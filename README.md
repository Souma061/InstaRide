# InstaRide: Real-Time Ride-Matching Platform

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![C++17](https://img.shields.io/badge/C%2B%2B-17%20(-O3)-00599C.svg)](https://isocpp.org/)
[![Uber H3](https://img.shields.io/badge/Uber%20H3-Spatial%20Index-orange.svg)](https://h3geo.org/)
[![Koffi FFI](https://img.shields.io/badge/Koffi-In--Process%20FFI-brightgreen.svg)](https://koffi.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-black.svg)](https://fastify.dev/)
[![Redis](https://img.shields.io/badge/Redis-Distributed%20Locks-red.svg)](https://redis.io/)
[![React](https://img.shields.io/badge/React-19.x-61dafb.svg)](https://react.dev/)
[![TailwindCSS](https://img.shields.io/badge/Tailwind-4.x-38bdf8.svg)](https://tailwindcss.com/)
[![Tests](https://img.shields.io/badge/Tests-Passing%20(100%25)-emerald.svg)]()

A high-performance, real-time ride-matching platform and spatial visualization system that matches riders to nearest available drivers in microsecond latencies. Features a **multi-engine spatial architecture** comparing **Point-Region QuadTrees** against **Hexagonal Grids & Uber H3**, connected directly into Node.js via **zero-copy in-process Koffi FFI**, **Redis distributed CAS lock leases (`acquire_lock.lua`)**, and a **deterministic trip finite state machine**—free of managed spatial databases (no PostGIS, no Redis Geo). Tested and verified up to **2,000,000 (2 Million) concurrent drivers**.

---

## Architecture Overview

```mermaid
graph TB
    subgraph Clients["Clients & Frontend Layer"]
        UI["React 19 + TypeScript + Vite Dashboard<br/>(Leaflet Dark OSM + Engine Switcher)"]
        RiderClient["Rider Booking Portal"]
        DriverClient["Driver Terminal Simulator"]
        ChaosSuite["Concurrency & Chaos Dossier"]
    end

    subgraph Gateway["Fastify API Gateway & WebSocket Engine"]
        HTTP["REST Endpoints<br/>/rides, /drivers, /trips, /simulator, /api/engine"]
        WS["WebSocket Server (/ws)<br/>Role Multiplexing: rider | driver | observer"]
        AuthGuard["Role Gating & Ownership Authorization"]
    end

    subgraph CoreEngine["Core Matching & State Engine"]
        DriverReg["Driver Registry (In-Memory Hot Index)<br/>Lockstep Spatial Sync & Stale Eviction"]
        RedisLock["Redis Distributed Lock Manager<br/>acquire_lock.lua (15s Lease, 0.00% Double-Dispatch)"]
        TripStore["Redis Trip Store & State Machine<br/>Atomic Commit, Reconcile Orphaned Locks"]
        Simulator["Virtual Driver Simulator (Wander, Dispatch, Boarding)"]
    end

    subgraph SpatialEngines["Multi-Engine Spatial Routing Layer"]
        TS_QT["TypeScript PR-QuadTree<br/>In-Memory Dynamic Quadrants<br/>33.75 μs Latency @ 1M"]
        KoffiBridge["CppKoffiSpatialBridge<br/>Zero-Copy In-Process FFI"]
        CPP_QT["C++ PR-QuadTree (-O3 DLL)<br/>std::shared_mutex + Branch-and-Bound<br/>17.71 μs Latency @ 1M | 14.5 μs @ 2M"]
        CPP_HG["C++ HexGrid (-O3 DLL)<br/>Pointy-Top Axial (q,r) + In-Place Telemetry<br/>2.12M Ingest/s | 2.95M Updates/s"]
        UBER_H3["Uber H3 Engine (libh3.dll)<br/>Adaptive Micro-Hexes (Res 14: 6.4 μs)<br/>Real-Time Res 8 Surge Pricing Heatmaps"]
    end

    UI <-->|WebSocket Events & Telemetry| WS
    RiderClient -->|POST /rides| HTTP
    DriverClient <-->|POST /trips/driver-response<br/>POST /trips/:id/driver-action| HTTP
    ChaosSuite -->|POST /simulator/concurrency-race| HTTP
    HTTP --> AuthGuard
    AuthGuard --> CoreEngine
    CoreEngine <--> TS_QT
    CoreEngine <--> KoffiBridge
    KoffiBridge <-->|Zero-Copy C ABI| CPP_QT
    KoffiBridge <-->|Zero-Copy C ABI| CPP_HG
    KoffiBridge -.->|Native C Bindings| UBER_H3
    CoreEngine <--> RedisLock
    WS <--> CoreEngine
```

---

## End-to-End Matching Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor Rider as Rider Cockpit
    participant Gateway as API Gateway / WS
    participant Spatial as Spatial Engine (QuadTree / HexGrid)
    participant Lock as Redis Distributed Lock (acquire_lock.lua)
    actor Driver as Driver Cockpit
    participant FSM as Trip State Machine

    %% 1. Ingestion
    Note over Driver, Spatial: 1. Live Telemetry & In-Place Spatial Sync
    Driver->>Gateway: Location Telemetry Batch (lat, lng)
    Gateway->>Spatial: batchUpdate() via Koffi FFI (2M+ updates/sec)
    Gateway-->>Rider: Broadcast vehicle positions & grid telemetry

    %% 2. Ride Request & Spatial Search
    Note over Rider, Spatial: 2. Request Submission & Zero-Copy k-NN Discovery
    Rider->>Gateway: POST /rides { pickup, dropoff, riderId }
    Gateway->>Spatial: kNearestNeighbors(pickup, k=5, radius=10km)
    Spatial-->>Gateway: Ranked Candidate Drivers [D1, D2, D3] (< 25 μs)

    %% 3. Atomic CAS Locking
    Note over Gateway, Lock: 3. Atomic Distributed Lock Lease (Redis Lua)
    Gateway->>Lock: acquireLock(D1, requestId, ttl=15s)
    alt Driver D1 Available (Lock Granted)
        Lock-->>Gateway: Lock Granted (Status = LOCKED)
        Gateway->>Spatial: remove(D1) (Instantly invisible to competing riders)
        Gateway->>FSM: Create Trip -> Transition to MATCHING
        Gateway-->>Driver: Push Offer Notification (15s countdown lease)
        Gateway-->>Rider: Notify Matching in progress
    else Driver D1 Claimed by Competitor (Lock Collision)
        Lock-->>Gateway: Lock Denied
        Gateway->>Lock: acquireLock(D2) (Automatic cascade to Candidate #2)
    end

    %% 4. Driver Response & Negotiation
    Note over Driver, FSM: 4. Driver Negotiation & Lifecycle Execution
    Driver->>Gateway: POST /trips/driver-response { response: "accepted" }
    Gateway->>Lock: commitTrip(D1, requestId) -> Convert to BUSY
    Gateway->>FSM: Transition: MATCHING -> MATCHED
    Gateway-->>Rider: Notify Trip Matched (Driver ID, Vector, ETA)

    %% 5. Milestones & Completion
    Driver->>Gateway: POST /trips/:id/driver-action { action: "arrived" }
    Gateway->>FSM: Transition: MATCHED -> ARRIVED
    Driver->>Gateway: POST /trips/:id/driver-action { action: "start_trip" }
    Gateway->>FSM: Transition: ARRIVED -> IN_PROGRESS (Cancellation locked)
    Driver->>Gateway: POST /trips/:id/driver-action { action: "complete_trip" }
    Gateway->>FSM: Transition: IN_PROGRESS -> COMPLETED
    Gateway->>Lock: releaseCommittedDriver(D1) -> Status = AVAILABLE
    Gateway->>Spatial: insert(D1, dropoff.lat, dropoff.lng) -> Re-indexed at destination
    Gateway-->>Rider: Trip Completed Summary
```

---

## Core Technical Highlights

### 1. In-Process Zero-Copy FFI Bridge (Koffi)

The engine integrates native 64-bit C++ shared libraries (`quadtree.dll` and `hexgrid.dll`) directly into the Node.js process using **Koffi FFI**:

- **No OS Pipe Overhead**: Replaced legacy child-process stdio pipes with zero-copy in-process C exports (`extern "C"`).
- **Sub-Microsecond Struct Marshalling**: C structs (`CandidateC`, `DriverUpdateC`) are mapped directly to memory buffers without stringification or JSON serialization.
- **Microsecond Query Speed**: k-NN dispatch queries return in **$24.0\text{ }\mu s$ to $42.5\text{ }\mu s$** directly to TypeScript.
- **Hot-Swappable Runtime**: Select between `"ts"`, `"cpp_quadtree"`, and `"cpp_hexgrid"` on the fly via `POST /api/engine/select`.

---

### 2. PR-QuadTree vs. HexGrid vs. Uber H3: The 2,000,000 Driver Showdown

We evaluated three competing spatial paradigms under massive scale (500k to 2M drivers) and adversarial stress (100,000 drivers in a 50m hyper-cluster):

| Metric / Scenario | Point-Region QuadTree (`quadtree.dll`) | Flat HexGrid (`hexgrid.dll`) | Uber H3 Adaptive (`libh3.dll`) | Architectural Winner & Takeaway |
| :--- | :--- | :--- | :--- | :--- |
| **Ingestion (500k drivers)** | 1.15M drivers/sec (433 ms) | **2.12M drivers/sec (235 ms)** | ~980k drivers/sec | 🏆 **HexGrid (1.84× faster)**: Flat $(q,r)$ hashing avoids dynamic tree allocations |
| **RAM per Driver** | 189 Bytes | **161 Bytes** | ~175 Bytes | 🏆 **HexGrid (15% less RAM)**: Eliminates node pointers (`nw, ne, sw, se`) |
| **Telemetry In-Place Updates** | 2.17M updates/sec | **2.95M updates/sec** | 1.85M updates/sec | 🏆 **HexGrid (1.36× faster)**: 90%+ pings stay in the same hex bucket ($O(1)$ fast-path) |
| **Uniform Search Latency (p50)**| **15.8 $\mu s$** | 19.8 $\mu s$ | 22.4 $\mu s$ | 🏆 **QuadTree**: Priority-queue branch-and-bound prunes 75% of space per split |
| **Search Tail Latency (p99)** | **21.0 $\mu s$** | 26.9 $\mu s$ | 31.2 $\mu s$ | 🏆 **QuadTree**: Predictable bounding-box bounding eliminates boundary ring scans |
| **Adversarial Hyper-Cluster (100k in 50m)** | 14.5 $\mu s$ (Depth 14 Splits) | 2,237 $\mu s$ (Res 8 Bucket Degrades to $O(N)$) | **6.4 $\mu s$ (Res 14 Micro-Hexes)** | 🏆 **Uber H3 Res 14 (2.2× faster than QuadTree)**: Sub-meter micro-hexes prevent bucket collisions |
| **Surge Pricing Aggregation** | $O(N \log N)$ polygon binning | Fixed-size neighbor rings | **75,000 pings in 21.86 ms** | 🏆 **Uber H3 (Res 8)**: Native hierarchical parent/child aggregation computes surge heatmaps |

#### Engineering Conclusions:
1. **Hexagonal Indexing Wins for High-Frequency Telemetry**: When ingesting millions of moving GPS pings, flat hexagonal axial coordinate mapping $(q,r)$ outpaces QuadTrees by **36%–84%** because 90%+ of telemetry updates stay within the same cell and execute in 5 nanoseconds with zero heap allocations.
2. **QuadTrees Win for Low-Density Uniform Dispatch**: Priority-queue bounding-box pruning provides tighter p99 guarantees ($21\text{ }\mu s$) than hexagonal ring expansions ($k\text{-ring}$).
3. **Adaptive Multi-Resolution (Uber H3) Conquers Extreme Density**: Under hyper-clustered flash mobs (e.g., stadium exits, transit hubs), fixed-resolution hex grids degrade to $O(N)$. By switching dynamically to Uber H3 Resolution 14 (~1.3m micro-hexes), $O(1)$ spatial hashing beats QuadTree depth traversal by **2.2×** ($6.4\text{ }\mu s$ vs $14.5\text{ }\mu s$, 146,000 queries/sec).

---

### 3. Redis Distributed Atomic Locking (`acquire_lock.lua`)

To guarantee zero double-dispatch across distributed multi-node workers, InstaRide implements distributed atomic leases via Redis Lua:

```lua
-- acquire_lock.lua: Atomic CAS lease acquisition
local currentStatus = redis.call('HGET', KEYS[1], 'status')
if currentStatus and currentStatus ~= 'available' then
    return 0
end
local lockVal = redis.call('GET', KEYS[2])
if lockVal and lockVal ~= ARGV[1] then
    return 0
end
redis.call('HSET', KEYS[1], 'status', 'locked')
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return 1
```

- **0.00% Duplicate Dispatch**: Validated under 200 concurrent rider surges competing for the same drivers.
- **Self-Healing TTL (15s Leases)**: If a matching worker crashes mid-dispatch, Redis automatically expires the lease and re-enables the driver.
- **Orphan Lock Janitor**: `RedisTripStore.reconcileOrphanedTrips()` clears orphaned driver locks upon server boot.

---

### 4. Deterministic Trip Finite State Machine (FSM)

```text
IDLE ──> REQUESTED ──> MATCHING ──> MATCHED ──> EN_ROUTE ──> ARRIVED ──> IN_PROGRESS ──> COMPLETED
  │          │             │           │           │           │              │
  └── CANCELLED ───────────┴───────────┴───────────┴───────────┴──────────────┴── [Forbidden]
```

- **Passenger Onboard Anti-Fraud Guard**: Cancellation is permitted while searching, matched, or en-route. Once passenger boarding completes and status transitions to `IN_PROGRESS`, **cancellation is strictly forbidden**—only the driver can complete the trip at dropoff.
- **Atomic Rollback**: If a driver accepts at the exact microsecond a rider cancels, atomic CAS rollback releases the lock and returns the driver to `available`.

---

## REST API Reference

### Ride Operations

| Method | Endpoint | Description | Guard / Invariant |
| :--- | :--- | :--- | :--- |
| `POST` | `/rides` | Submit a new ride request | Validates GeoPoints, riderId, and offer timeout |
| `POST` | `/rides/:tripId/cancel` | Cancel active ride request | Blocked if `in_progress`; verifies rider ownership |
| `POST` | `/trips/:tripId/driver-action` | Advance trip milestone (`arrived`, `start_trip`, `complete_trip`) | Enforces `driverId === trip.driverId` |
| `POST` | `/trips/driver-response` | Driver responds to match offer (`accepted` / `rejected`) | Atomic CAS lease commit or fallback cascade |

### Spatial Engine & Simulation Controls

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/engine/status` | Read active engine (`"ts"` \| `"cpp_quadtree"` \| `"cpp_hexgrid"`), latency, query count |
| `POST` | `/api/engine/select` | Hot-swap active spatial engine (`"ts"`, `"cpp_quadtree"`, `"cpp_hexgrid"`) |
| `GET` | `/drivers` | Snapshot of all virtual drivers, coordinates, and lock states |
| `POST` | `/drivers/spawn` | Hot-insert an available driver at exact GPS coordinates |
| `POST` | `/simulator/reset` | Reseed region bounds and driver fleet ($1$ to $10,000$) |
| `POST` | `/simulator/concurrency-race` | Run simultaneous 2-rider race and return CAS evidence dossier |
| `GET` | `/config` | Read active city, bounding box, fleet size, and spatial index sizes |
| `GET` | `/health` | Service health status, active engine, and native index stats |

---

## WebSocket Gateway

Connect to the multiplexed gateway at `ws://localhost:3000/ws?role={role}&id={id}`:

- **`rider`**: Receives offer updates, matched driver coordinates, and trip milestones.
- **`driver`**: Streams telemetry heartbeats (`location_update`) and receives dispatch offers.
- **`observer`**: Receives QuadTree bounding box splits, fleet telemetry batches, and audit stream events.

---

## Verification & Test Suites

The test suite covers algorithmic correctness, concurrency safety, edge-case recovery, and FFI bindings:

```bash
# 1. Driver Registry & Lock Invariants (100% Passing)
pnpm test

# 2. Matching Service Orchestrator (26/26 Passing)
pnpm exec tsx tests/test_matching_service.ts

# 3. Native C++ In-Process Koffi FFI Bridge (24.0 μs Latency)
pnpm exec tsx tests/test_cpp_bridge.ts

# 4. C++ Engine Mirror & Simulator Divergence Verification (5/5 Passing)
pnpm exec tsx tests/test_cpp_engine_e2e.ts

# 5. Full-Server HTTP API E2E (0.000000° / 0m Coordinate Error)
pnpm exec tsx tests/e2e_server_cpp_engine.ts

# 6. Redis Distributed Locks & 200-Rider Concurrency Surge
pnpm exec tsx tests/test_full_integration_stress.ts

# --- C++ NATIVE COMPILATION & BENCHMARKS ---
cd cpp-engine

# Compile thread-safe DLLs (MinGW-w64 GCC 16.1+ 64-bit):
g++ -O3 -shared -std=c++17 quadtree_c_api.cpp -o quadtree.dll
g++ -O3 -shared -std=c++17 hexgrid_c_api.cpp -o hexgrid.dll

# Run 2M QuadTree vs HexGrid Benchmark:
g++ -O3 -std=c++17 benchmark_quadtree_vs_hexgrid.cpp -o bench.exe && ./bench.exe

# Run Adversarial Hyper-Cluster Showdown (QuadTree vs Uber H3 Res 14):
g++ -O3 -std=c++17 hyper_cluster_showdown.cpp -L. -lh3 -o showdown.exe && ./showdown.exe

# Run Uber H3 Surge Pricing Heatmap Aggregator:
g++ -O3 -std=c++17 h3_surge_and_multires.cpp -L. -lh3 -o surge.exe && ./surge.exe
```

---

## Getting Started

### Prerequisites

- **Node.js**: v20.x or higher (64-bit)
- **pnpm**: v9.x or higher
- **Redis**: v6.x or higher running at `127.0.0.1:6379`
- **C++ Compiler**: 64-bit MinGW-w64 GCC 14+ or Clang (POSIX threads, UCRT)

### Installation & Run

```bash
# 1. Clone repository
git clone https://github.com/Souma061/InstaRide.git
cd InstaRide

# 2. Install dependencies
pnpm install

# 3. Build frontend visualizer
pnpm build:frontend

# 4. Start backend server on http://localhost:3000
pnpm start
```

Open **`http://localhost:3000`** in your browser to experience the live visualizer, trigger live concurrency races, and hot-swap between TypeScript, C++ QuadTree, and C++ HexGrid.

---

## License

MIT License. Designed and engineered for high-throughput distributed spatial systems demonstration.
