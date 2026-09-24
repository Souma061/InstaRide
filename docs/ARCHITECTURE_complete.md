# InstaRide — Real-Time Ride Matching System
## Architecture, Implementation Status & Roadmap

> **Version:** Post-Redis Integration (September 2026)
> **Author:** Engineering session log
> **Status:** Core engine battle-tested. SQL tier not yet built.

---

## 1. What This System Is

InstaRide is a real-time ride-matching engine designed to handle city-scale ride demand. It solves one hard problem: given thousands of moving drivers and incoming ride requests arriving simultaneously, find the best available nearby driver and lock them atomically — with no double-dispatch, no phantom locks, and no race conditions — in under one millisecond of matching decision time.

The system is not a simple CRUD app with a database and a loop. It is a layered pipeline where each tier has a specific job and a specific latency budget.

---

## 2. The Three-Tier Data Pipeline

This is the core data flow. Each tier handles a different class of data at a different speed.

```
 [ Raw GPS Pings — 3.88 million updates/sec ]
              |
              v
 ┌─────────────────────────────────────────────┐
 │         TIER 1: C++ Spatial Engine          │
 │         cpp-engine/Quadtree.hpp             │
 │                                             │
 │  Pure RAM. Ephemeral. No persistence.       │
 │  - Recursive Quadtree spatial index         │
 │  - Branch-and-Bound Best-First k-NN search  │
 │  - MinHeap priority queue for candidates    │
 │  - O(1) driver removal via pointer index    │
 │  - 2M drivers @ 322.9 MB RAM                │
 │  - 47,800 k-NN queries/sec                  │
 │  - 3,880,000 GPS update ops/sec             │
 └───────────────────┬─────────────────────────┘
                     │
          State changes only (lock, match,
          cancel, complete) — NOT raw GPS
                     │ ~72,000 ops/sec
                     v
 ┌─────────────────────────────────────────────┐
 │         TIER 2: Redis Hot Tier              │
 │     src/infra/redis_client.ts               │
 │     src/core/redis_driver_lock.ts           │
 │     src/core/redis_trip_store.ts            │
 │                                             │
 │  Distributed atomic state. TTL-backed.      │
 │  - SETNX driver lock (atomic, with TTL)     │
 │  - Lua scripts for lock release & commit    │
 │  - Trip JSON store with idempotency keys    │
 │  - Single-active-trip guard per rider       │
 │  - Active trip set (SADD/SREM)              │
 │  - 71,982 lock acquisitions/sec             │
 │  - 7,201 full Lua commit transactions/sec   │
 └───────────────────┬─────────────────────────┘
                     │
          Business milestones only
          (trip created, matched, completed)
                     │ ~100 writes/sec
                     v
 ┌─────────────────────────────────────────────┐
 │       TIER 3: PostgreSQL Cold Tier          │
 │             [ NOT YET BUILT ]               │
 │                                             │
 │  Financial ledger. Audit trail.             │
 │  - trips table (5 writes per lifecycle)     │
 │  - Write-behind queue via Redis LPUSH       │
 │  - Batch worker → bulk INSERT               │
 │  - Immutable event log (never update,       │
 │    only insert state change records)        │
 └─────────────────────────────────────────────┘
```

**The key design decision:** GPS telemetry NEVER touches Redis or PostgreSQL. The C++ engine is the only consumer of raw coordinates. Redis only sees the outcome of spatial decisions — which driver was locked, which trip was matched. This is what allows the system to handle millions of GPS pings while keeping Redis clean and fast.

---

## 3. Layer-by-Layer Breakdown

### Layer 1 — C++ Spatial Engine (`cpp-engine/`)

**Files:**
- `Quadtree.hpp` — Core data structure and all algorithms
- `quadtree_c_api.cpp` — C-linkage API wrapper (exported from `quadtree.dll`)
- `engine_bridge.cpp` — OS pipe IPC server (Node.js ↔ C++ communication)

**How it works:**

The Quadtree recursively subdivides a 2D bounding box (currently set to Bengaluru: lat 12.86–13.06, lng 77.50–77.72) into quadrants. Each leaf node holds up to 8 driver points. When a leaf exceeds capacity it splits into 4 children.

```
 Root Bounding Box (entire city)
        |
   ┌────┴────┐
  NW        NE
   |
  ┌┴──────┐
 NW.NW  NW.NE
   |
 [leaf: Driver_1, Driver_7, Driver_22, ...]
```

**k-NN search (Best-First Branch and Bound):**

Instead of brute-force searching all nodes, the algorithm uses a MinHeap ordered by distance-to-bounding-box. It expands the closest region first and prunes any region whose minimum possible distance exceeds the current k-th best known candidate. This produces exact k-nearest results orders of magnitude faster than brute force at scale.

**Key data structure fix (chaos-engineering-discovered):**

`DriverRecord` stores a heap-allocated `Point*` pointer rather than a `Point` value. This allows the fast-path GPS update (`update()`) to mutate coordinates in-place without any tree restructuring — a single pointer dereference. Before this fix, update modified a copy and coordinates silently went stale, causing spatially incorrect k-NN results.

```
DriverRecord {
  Point *point;            // heap pointer — mutations are live immediately
  QuadtreeNode *leaf;      // direct leaf reference — O(1) remove
}
```

**Memory management fix (chaos-engineering-discovered):**

The original `remove()` method erased the driver from `driverIndex` but never called `delete pt`. Under sustained 2M-driver thrash workloads this leaked 38.4 MB. Fixed: `remove()` now calls `delete ptToDelete` before erasing. The destructor calls `clear()` which walks `driverIndex` and deletes all remaining `Point*` allocations.

**IPC Bridge (`engine_bridge.cpp`):**

Node.js spawns the C++ engine as a child process. Communication goes over stdin/stdout OS pipes using a simple newline-delimited JSON protocol. Commands: `INSERT`, `REMOVE`, `UPDATE`, `KNN`, `CLEAR`. The bridge handles framing and parses responses. This keeps the C++ engine as a pure computation server with no Node.js FFI overhead in the hot path.

**TypeScript fallback (`src/spatial/quadtree.ts`):**

A pure TypeScript Quadtree implementation exists for environments where C++ compilation is not possible (CI, Windows without MSVC, Docker without build stage). The `CppSpatialBridge` (`src/spatial/cpp_spatial_bridge.ts`) wraps both and selects based on `SPATIAL_ENGINE=cpp` env var.

---

### Layer 2 — TypeScript Core Engine (`src/core/`)

This layer is the brain of the matching system. It coordinates state, locks, and lifecycle.

#### `TripStateMachine` (`trip_state_machine.ts`)

Manages all trip lifecycle state transitions. In-memory Map store (not yet Redis-backed).

```
 requested --> matching --> matched --> en_route --> arrived --> in_progress --> completed
      |            |           |            |           |
      |            |           |            └───────────┴──> matching  (driver breakdown: auto-rematch)
      └────────────┴───────────┴──────────────────────────> cancelled (actor: rider | driver | system)
                                                              [blocked once in_progress]
```

**State transition matrix (enforced):** Each status has an explicit allowlist of valid next statuses. Invalid transitions return `{ success: false, error: "..." }` without mutating state.

**8 transition methods:** `startMatching`, `setMatched`, `driverEnRoute`, `driverArrived`, `startTrip`, `completeTrip`, `cancelTrip`, `rematchTrip`.

All methods return a `TransitionResult` with the updated `Trip` and a full `StateTransitionEvent` audit record (who triggered it, from/to status, timestamp, reason).

#### `DriverRegistry` (`driver_registry.ts`)

Bridges the spatial index and the distributed lock layer. Dual-mode: runs with or without Redis.

```
  DriverRegistry
       |
       ├── spatialIndex (QuadTree | CppSpatialBridge)
       │        k-NN queries, insert, remove, update
       |
       └── redisLock?: RedisDriverLock
                |
                ├── acquireLock()  --> Redis SETNX + PX TTL
                ├── releaseLock()  --> Lua release_lock.lua (atomic check-and-delete)
                ├── commitTrip()   --> Lua commit_trip.lua (delete lock + set state=busy)
                └── completeTrip() --> HSET driver:state:{id} status=available
```

**Without `redisLock`:** Falls back to in-memory `LockToken` per `DriverRecord`. Used by all in-memory unit tests. All existing tests pass unchanged.

**With `redisLock`:** All lock operations are distributed and atomically safe across multiple Node.js processes.

**Critical behavior:** When a driver is successfully locked (`acquireLock` returns `true`), the driver is immediately removed from the spatial index. They are invisible to all subsequent k-NN queries until either released (re-inserted) or committed (stays removed, status becomes `busy`). This is what prevents double-dispatch without any mutex in the query path.

#### `MatchingService` (`matching_service.ts`)

The offer dispatch engine. Runs asynchronously with a configurable timeout per offer.

```
 requestRide(params)
      |
      ├── [2-step gate if tripStore present]
      │     1. Check request:trip:{requestId} — reject if already exists (network retry)
      │     2. SET rider:active_trip:{riderId} NX — reject if rider already has active trip (illegal second ride)
      |
      ├── stateMachine.startMatching(trip)
      |
      └── dispatchOfferLoop(trip, candidates [])  <-- runs in background, not awaited
               |
               ├── spatialIndex.KNearestNeighbors(pickup, k, radius)
               |
               ├── For each candidate:
               │     1. await driverRegistry.acquireLock(driverId, requestId, ttlMs)
               │           -- if false: driver taken, try next candidate
               │     2. emit onOfferDispatched --> WebSocket push to driver
               │     3. Race: driver response vs. offer timeout (Promise.race)
               │
               │     On "accepted":
               │        await driverRegistry.commitTrip(driverId, requestId)
               │        stateMachine.setMatched(tripId, driverId)
               │        tripStore?.saveTrip(matchedTrip)
               │        emit onTripMatched --> WebSocket push to rider
               │        DONE
               │
               │     On "rejected" | "timed_out":
               │        await driverRegistry.releaseLock(driverId, requestId)
               │        -- driver re-inserted into spatial index
               │        -- try next candidate
               │
               │     On "cancelled":
               │        await driverRegistry.releaseLock(driverId, requestId)
               │        halt loop
               │
               └── If all candidates exhausted without match:
                     stateMachine.cancelTrip(tripId, "no_drivers")
                     tripStore?.saveTrip(cancelledTrip)
                     emit onMatchFailed
```

**Deadman switch:** Each offer has a `NodeJS.Timeout` timer. If the driver does not respond within `offerTimeoutMs` (default 15,000ms), the Promise resolves with `"timed_out"` and the lock is released.

**Cancellation propagation:** A separate `cancelledRequests` Set is checked at each iteration. If `cancelRide()` is called mid-loop, the loop sees the flag on its next iteration and halts cleanly.

#### `RedisDriverLock` (`redis_driver_lock.ts`)

Thin Redis wrapper for driver-scoped distributed locks.

**Key schema:**
```
  driver_lock:{driverId}      SET {requestId} NX PX {ttlMs}    -- lock (auto-expires)
  driver:state:{driverId}     HSET status busy                  -- state after commit
```

**Lua scripts (loaded once at module import, not per-call):**

`src/infra/lua/release_lock.lua`:
```lua
  -- Atomic: only delete the lock if the caller is the current holder
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
  -- Prevents a late TTL expiry from releasing the next rider's lock
```

`src/infra/lua/commit_trip.lua`:
```lua
  -- Atomic: verify ownership, delete lock, set driver state=busy
  if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call("DEL", KEYS[1])
  redis.call("HSET", KEYS[2], "status", "busy", "currentTripRequestId", ARGV[1])
  return 1
  -- Both operations happen together or not at all
```

#### `RedisTripStore` (`redis_trip_store.ts`)

Manages all trip data in Redis with two idempotency gates on creation.

**Key schema:**
```
  trip:{tripId}               SET JSON.stringify(trip)           -- full trip object
  request:trip:{requestId}    SET {tripId}                       -- idempotency lookup
  rider:active_trip:{riderId} SET {tripId} NX                    -- single active trip guard
  trip:active                 SADD {tripId}                      -- active trip set
```

**2-Step creation gate:**
```
  Step 1: GET request:trip:{requestId}
          -- if exists: this is a network retry, return existing trip (idempotent)
          -- if missing: new request, proceed

  Step 2: SET rider:active_trip:{riderId} {tripId} NX
          -- NX means "only set if not exists"
          -- if fails: rider already has an active trip, reject as illegal second ride
          -- if succeeds: rider slot claimed, continue

  Step 3: Pipeline SET trip:{tripId}, SET request:trip:{requestId}, SADD trip:active
```

This distinction matters: Step 1 handles the legitimate case (network retry, same request replayed). Step 2 handles the malicious or buggy case (rider trying to book two rides simultaneously).

**Terminal cleanup:** When a trip reaches `completed` or `cancelled`, `saveTrip()` pipelines `SREM trip:active` + `DEL rider:active_trip:{riderId}`. The rider slot is freed, and they can book again.

---

### Layer 3 — Gateway (`src/gateway/`, `src/server.ts`)

**Fastify HTTP + WebSocket server.**

- `src/server.ts`: Bootstrap, route registration, simulator wiring. Uses `@fastify/websocket` for WS upgrade.
- `src/gateway/ws_manager.ts`: Role-based WebSocket session manager. Maintains maps of `riderId → socket`, `driverId → socket`, `observer → socket`. Dispatches offer notifications, revocations, match confirmations.

**Roles:** `rider`, `driver`, `observer`. Each role has separate authorization and a separate set of messages it can receive.

**Current wiring state in `server.ts`:**
```typescript
  const driverRegistry = new DriverRegistry(spatialIndex);       // NO redisLock
  const matchingService = new MatchingService(driverRegistry, stateMachine, { ... }); // NO tripStore
```

**⚠ This means the server currently runs in pure in-memory mode.** Redis is built, tested, and working — but not yet connected to the production server instantiation. See "Remaining Work" section.

---

### Layer 4 — Metrics & Simulation (`src/metrics/`, `src/simulation/`)

- `src/metrics/metrics.ts`: `prom-client` counters and histograms. Exposed on `GET /metrics` for Prometheus scraping.
- `src/simulation/driver_simulator.ts`: Simulates driver behavior for load testing — registers drivers, moves them, responds to offers (accept/reject with configurable probability). Used by `server.ts` for in-process load simulation.

**Docker monitoring stack (running):**
```
  instaride-redis       → localhost:6379   (Redis 7 Alpine, AOF persistence)
  instaride-prometheus  → localhost:9090   (scrapes /metrics every 15s)
  instaride-grafana     → localhost:3001   (dashboards, connects to Prometheus)
```

---

## 4. Redis Key Schema (Complete Reference)

| Key Pattern | Type | Value | TTL | Purpose |
|---|---|---|---|---|
| `driver_lock:{driverId}` | String | `requestId` | `offerTimeoutMs` | Distributed driver lock |
| `driver:state:{driverId}` | Hash | `{status, currentTripRequestId}` | None | Driver state after commit |
| `trip:{tripId}` | String | JSON `Trip` object | None | Full trip data |
| `request:trip:{requestId}` | String | `tripId` | None | Idempotency index |
| `rider:active_trip:{riderId}` | String | `tripId` | None | Single-active-trip guard |
| `trip:active` | Set | `Set<tripId>` | None | All active trips |

> **Note on lock key naming:** The lock prefix is `driver_lock:` (underscore, not colon). Keys are `driver_lock:Driver_42`, not `driver:lock:Driver_42`. This is intentional and consistent across all tests.

---

## 5. Test Suite

| Test File | What It Covers | Status |
|---|---|---|
| `test_driver_registry.ts` | In-memory lock, unlock, commit, spatial remove/re-insert | ✅ PASS |
| `test_trip_state_machine.ts` | All 8 transitions, invalid transition rejection, event audit | ✅ PASS |
| `test_matching_service.ts` | 26 scenarios: full match, timeout, cancel, no drivers, all reject | ✅ PASS |
| `test_concurrency_race.ts` | 2,000 simultaneous riders vs 20 drivers, 0 double-dispatches | ✅ PASS |
| `test_audit_fixes.ts` | 29 edge case regression tests from audit | ✅ PASS |
| `test_integration_edge_cases.ts` | 11 full-stack edge cases | ✅ PASS |
| `test_redis_driver_lock.ts` | 6 Redis lock tests: acquire, mutual exclusion, Lua release, TTL expiry, 1k concurrency, atomic commit | ✅ PASS |
| `test_redis_trip_store.ts` | 7 tests: creation, network retry idempotency, illegal second ride, match update, driver cancellation, completion cleanup | ✅ PASS |
| `test_full_redis_matching_integration.ts` | 6 end-to-end Redis integration tests | ✅ PASS |
| `attack3_concurrency_carnage.ts` | 10,000 simultaneous riders → exactly 1 match, 9,999 graceful | ✅ PASS |
| `benchmark_redis_load.ts` | 250,000 mixed ops at concurrency 2,000 | ✅ PASS |

---

## 6. Chaos Engineering Results

Four C++ torture attacks were run against the engine.

**Attack 1 — Singularity (`attack1_singularity.cpp`):**
All 500k drivers inserted at the exact same coordinate. Tests degenerate tree behavior and k-NN correctness when spatial distribution is zero variance. Engine survived — all candidates returned correctly from the same leaf.

**Attack 2 — Coordinate Poisoning (`attack2_poisoning.cpp`):**
Injected NaN, ±Infinity, and out-of-bounds lat/lng values. Before fix: undefined behavior. After fix: `KNearestNeighbors` guards `isnan()` and `isinf()` at entry and returns an empty result safely.

**Attack 3 — Concurrency Carnage (`attack3_concurrency_carnage.ts`):**
10,000 riders requesting rides simultaneously against the matching engine. Found that `MatchingServiceEvents` interface methods were named differently than what `ws_manager.ts` expected — fixed. Result: exactly 1 trip matched, 9,999 gracefully cancelled with no double-dispatch.

**Attack 4 — Sustained Thrash (`attack4_thrashing.cpp`):**
5 million insert/update/remove cycles over 2M drivers across leaf boundary crossings. Exposed two bugs:
1. **Stale coordinate bug:** `update()` was modifying a copy of `Point`, not the live heap pointer. Fast-path GPS updates were silently discarded. Fixed by storing `Point*`.
2. **Memory leak:** `remove()` erased from `driverIndex` but never called `delete pt`. 38.4 MB leaked. Fixed with `delete ptToDelete` before `erase()`.

---

## 7. Performance Benchmarks

| Benchmark | Result |
|---|---|
| C++ inserts | 236,000 drivers/sec |
| C++ k-NN queries (2M drivers) | 47,800 queries/sec |
| C++ GPS updates | 3,880,000 ops/sec |
| C++ RAM for 2M drivers | 322.9 MB (169.3 bytes/driver) |
| Redis GET (native) | 1,600,000 ops/sec |
| Redis SET (native) | 736,000 ops/sec |
| Redis lock acquisitions (Node.js) | 71,982 /sec (100k test) |
| Redis Lua commit transactions (Node.js) | 7,201 /sec (250k test, 2 Redis ops each) |
| MatchingService ride requests | 58,027 /sec (10k rider concurrency test) |

The single-node Redis bottleneck at ~72k lock ops/sec is the current throughput ceiling. This is sufficient for city-scale load. A Redis Cluster deployment would linearly scale this.

---

## 8. What Can Be Improved (Short-Term)

### 8.1 Wire Redis into `server.ts` (Critical)

The server currently instantiates `DriverRegistry` and `MatchingService` without Redis. The production server is running in pure in-memory mode. Redis infrastructure is built and tested but disconnected from the server entry point.

Required changes in `src/server.ts`:
```
  import { connectRedis, disconnectRedis } from "./infra/redis_client.js"
  import { RedisDriverLock } from "./core/redis_driver_lock.js"
  import { RedisTripStore } from "./core/redis_trip_store.js"

  await connectRedis()
  const redisLock = new RedisDriverLock()
  const tripStore = new RedisTripStore()
  const driverRegistry = new DriverRegistry(spatialIndex, redisLock)   // <-- add redisLock
  const matchingService = new MatchingService(driverRegistry, stateMachine, events, tripStore)  // <-- add tripStore
```

Also: graceful shutdown hook — on `SIGTERM`, call `disconnectRedis()` and `fastify.close()`.

### 8.2 Fix `await cancelRide()` in `ws_manager.ts`

`cancelRide()` was changed to `async` in the matching service. Any call site that does not `await` it will silently discard the result. Check `src/gateway/ws_manager.ts` for `this.matchingService.cancelRide(...)` and add `await`.

### 8.3 Redis Cluster Hash Tags

All Lua scripts touch two keys in a single `EVAL` call. On a multi-master Redis Cluster, both keys must hash to the same slot or Redis throws `CROSSSLOT`. Currently the keys are:
```
  driver_lock:{driverId}    and    driver:state:{driverId}
```
These hash differently on a cluster. Fix: add hash tags so both use the driverId as the slot key:
```
  {driverId}:lock    and    {driverId}:state
```
This is a one-line change in `RedisDriverLock` constants, but requires coordinated key migration if drivers are already in Redis.

### 8.4 `TripStateMachine` Persistence

`TripStateMachine` is a plain in-memory `Map<tripId, Trip>`. On server restart all in-flight trip state is lost. Redis was not chosen for state machine backing to keep the architecture clean, but trips that survive a Redis flush but not a server restart is the current failure mode. Options:
- Back `TripStateMachine` with Redis (store `trip:{tripId}` as the source of truth and hydrate on startup)
- Accept the current behavior: any in-progress trip during a server restart is orphaned (reasonable for v1)

---

## 9. Future Implementations Remaining

### 9.1 PostgreSQL Cold Tier

The most impactful missing piece. Without it, all completed trip history is lost when Redis is cleared. Design:

```
  Trip completes
      |
      v
  Redis LPUSH "db:write:queue" --> JSON milestone event
      |
      v
  Background worker (separate process or setInterval)
      |
      v
  Postgres bulk INSERT (batch 500 rows at a time)
      |
  trips table:
    id, request_id, rider_id, driver_id, status,
    pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
    created_at, matched_at, started_at, completed_at,
    cancelled_at, cancellation_reason, cancelled_by,
    fare_amount, distance_meters
```

Only 5 writes per trip lifecycle (created, matched, en_route, in_progress, completed/cancelled). At 100 trips/sec city scale, that is 500 Postgres writes/sec — well within single-node Postgres limits.

### 9.2 Docker Multi-Stage Build

The C++ engine currently requires a local compiler. A multi-stage Dockerfile would:
```
  Stage 1 (build):   gcc image → compile Quadtree.hpp + quadtree_c_api.cpp → quadtree.dll
  Stage 2 (ts):      node:20 image → pnpm install + tsc build
  Stage 3 (runtime): slim node:20 image → copy .dll + compiled .js → run
```
This makes the system deployable without a dev environment.

### 9.3 CI/CD Pipeline

`.github/workflows/ci.yml` with:
- TypeScript type check (`tsc --noEmit`)
- Compile C++ engine in CI environment
- Run full test suite (`pnpm test`)
- Run `attack3_concurrency_carnage.ts` as a blocking gate (0 double-dispatch required to pass)
- Build Docker image and push to registry on merge to main

### 9.4 Kubernetes / Health Probes

- `GET /health/live` — returns 200 if process is alive (liveness probe)
- `GET /health/ready` — returns 200 only if Redis is connected, C++ engine is responsive, and spatial index is loaded (readiness probe)
- `SIGTERM` handler for graceful pod shutdown — drain in-flight offers, close Redis, close C++ bridge, then exit

### 9.5 Redis Cluster

When a single Redis node is insufficient (above ~500k rides/hour city scale), move to Redis Cluster mode:
- 3 master nodes, 3 replicas
- Enable hash tags (see 8.3 above)
- `ioredis` has built-in cluster support — `new Redis.Cluster([nodes])` is a near drop-in replacement

### 9.6 GPS Kalman Filtering

Current GPS updates are applied raw. In practice, GPS signals in urban environments have tunnel gaps, signal jumps, and noise. A Kalman filter per driver would smooth coordinates and suppress phantom position jumps that would cause k-NN search to return wrong candidates.

### 9.7 Dynamic Surge Pricing & Demand Heatmaps

Using the spatial engine already in place:
- Divide the city bounding box into a fixed hexagonal grid
- Count ride requests per hex cell per time window (rolling 5-minute)
- Compute supply/demand ratio per cell
- Apply surge multiplier: `fare = base_fare × surge_multiplier`
- Expose heatmap data as a WebSocket broadcast for the observer role (Grafana or map UI)

### 9.8 Ride Pooling / Carpool Matching

A second matching mode where:
- Two or more riders with compatible routes are grouped into one trip
- Driver gets one composite route with multiple pickups and dropoffs
- Detour heuristic: accept pooling only if total detour < N% of direct route for each rider
- Requires route geometry API (OSRM or Valhalla) for detour calculation

---

## 10. File Map

```
RT_Ride_Matching_System/
  |
  ├── src/
  │   ├── server.ts                        HTTP + WS entry point, Fastify routes
  │   ├── core/
  │   │   ├── driver_registry.ts           Spatial + lock coordinator (dual-mode)
  │   │   ├── matching_service.ts          Async offer dispatch engine
  │   │   ├── redis_driver_lock.ts         Distributed lock over Redis SETNX + Lua
  │   │   ├── redis_trip_store.ts          Trip persistence, idempotency, rider guard
  │   │   └── trip_state_machine.ts        8-state FSM with transition matrix
  │   ├── gateway/
  │   │   └── ws_manager.ts               WebSocket session manager, role dispatch
  │   ├── infra/
  │   │   ├── redis_client.ts             ioredis singleton, connect/disconnect
  │   │   └── lua/
  │   │       ├── release_lock.lua        Atomic check-and-delete
  │   │       └── commit_trip.lua         Atomic lock-delete + state-set
  │   ├── spatial/
  │   │   ├── cpp_spatial_bridge.ts       IPC bridge to C++ engine
  │   │   └── quadtree.ts                 TypeScript Quadtree fallback
  │   ├── metrics/
  │   │   └── metrics.ts                  Prometheus counters, histograms
  │   ├── simulation/
  │   │   └── driver_simulator.ts         In-process driver bot for load testing
  │   └── utils/
  │       ├── min_heap.ts                 Generic MinHeap (used by TS k-NN)
  │       └── validation.ts              GeoPoint, GeoBounds, timeout validators
  |
  ├── cpp-engine/
  │   ├── Quadtree.hpp                    Core spatial index (all algorithms here)
  │   ├── quadtree_c_api.cpp              C-linkage DLL export wrapper
  │   ├── engine_bridge.cpp               OS pipe IPC server
  │   ├── benchmark_2M_throughput.cpp     2M driver GPS update throughput test
  │   ├── attack1_singularity.cpp         Singularity coordinate chaos test
  │   ├── attack2_poisoning.cpp           NaN/Inf coordinate poisoning test
  │   ├── attack4_thrashing.cpp           Sustained insert/update/remove chaos test
  │   └── stress_breaking_point.cpp       Find engine breaking point
  |
  ├── tests/
  │   ├── test_driver_registry.ts         Unit: DriverRegistry lock methods
  │   ├── test_trip_state_machine.ts      Unit: all state transitions
  │   ├── test_matching_service.ts        Unit: 26 matching scenarios
  │   ├── test_concurrency_race.ts        Load: 2k riders vs 20 drivers
  │   ├── test_audit_fixes.ts             Regression: 29 edge cases
  │   ├── test_integration_edge_cases.ts  Integration: 11 full-stack cases
  │   ├── test_redis_driver_lock.ts       Integration: 6 Redis lock tests
  │   ├── test_redis_trip_store.ts        Integration: 7 Redis trip store tests
  │   ├── test_full_redis_matching_integration.ts  End-to-end: 6 Redis tests
  │   ├── attack3_concurrency_carnage.ts  Chaos: 10k riders simultaneously
  │   ├── benchmark_redis_load.ts         Benchmark: 250k Redis ops
  │   ├── benchmark_100k_ts.ts            Benchmark: 100k TS Quadtree inserts
  │   └── benchmark_1M_ts.ts              Benchmark: 1M TS Quadtree inserts
  |
  ├── .env                                Runtime config (not committed)
  ├── .env.example                        Config template (committed)
  ├── .luarc.json                         Suppress VS Code Lua redis global warnings
  ├── package.json
  ├── tsconfig.json
  └── ARCHITECTURE.md                     This file
```

---

## 11. Current Implementation Summary

| Component | Status | Notes |
|---|---|---|
| C++ Quadtree engine | ✅ Complete + battle-tested | All 4 chaos attacks passed |
| TypeScript Quadtree fallback | ✅ Complete | Used when C++ unavailable |
| C++ IPC bridge | ✅ Complete | OS pipe JSON protocol |
| TripStateMachine | ✅ Complete | In-memory; not yet Redis-backed |
| DriverRegistry (in-memory mode) | ✅ Complete + tested | Fallback when no Redis |
| DriverRegistry (Redis mode) | ✅ Complete + tested | Pass `redisLock` to constructor |
| RedisDriverLock | ✅ Complete + tested | SETNX + Lua scripts |
| RedisTripStore | ✅ Complete + tested | 2-step gate, all lifecycle ops |
| MatchingService | ✅ Complete + tested | Async loop, deadman switch |
| Redis wired into server.ts | ❌ NOT DONE | Server still in-memory mode |
| `cancelRide` await in ws_manager.ts | ❌ NOT DONE | Possible silent failure |
| PostgreSQL cold tier | ❌ NOT STARTED | No DB writes of any kind yet |
| Docker multi-stage build | ❌ NOT STARTED | C++ requires local compiler |
| CI/CD pipeline | ❌ NOT STARTED | No `.github/workflows/` yet |
| Redis Cluster hash tags | ❌ NOT STARTED | Single-node keys, no `{...}` |
| Kubernetes health probes | ❌ NOT STARTED | No `/health` routes |
| GPS Kalman filtering | ❌ NOT STARTED | Raw GPS applied directly |
| Surge pricing / heatmaps | ❌ NOT STARTED | Future feature |
| Ride pooling | ❌ NOT STARTED | Future feature |
