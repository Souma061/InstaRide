# 🔍 InstaRide Codebase — Deep Security & Reliability Audit

> **Audit Date:** 2026-09-26  
> **Scope:** Full codebase — 15 source files, 4 Lua scripts, configs  
> **Auditor:** Automated deep analysis (Antigravity)

---

## Executive Summary

The InstaRide RT Ride Matching System is an architecturally sound real-time matching platform with Redis-backed distributed locks, a QuadTree spatial index, and a C++ native accelerator. However, the audit uncovered **5 CRITICAL**, **9 HIGH**, **8 MEDIUM**, and **5 LOW** severity findings across security, concurrency, memory safety, and reliability.

```mermaid
xychart-beta
  title "Findings by Severity"
  x-axis ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
  y-axis "Count" 0 --> 10
  bar [5, 9, 8, 5]
```

---

## ⚠️ Re-audit Status (2026-09-26)

**Regression found:** commit `34ad56a` fixed a batch of the findings below; the very next commit `b37eb89` ("refactor: streamline ride cancellation…") reverted **all of that code** while keeping this document. The fixes have been re-applied and are now guarded by `tests/test_audit_fixes.ts` §8–§12, so a re-revert fails the suite.

| Status | Findings |
|---|---|
| ✅ Fixed **and** regression-tested | C-1, C-2, H-1, H-4, H-7, H-8, M-1 |
| ✅ Fixed, **not** covered by a test | H-5, H-6, M-4, M-8, L-1, L-3, L-5 |
| ⚠️ Partially mitigated | C-3 — Redis is now acquired *before* in-memory mutation (`driver_registry.ts:161-176`), but there is still no startup reconciliation of the QuadTree from Redis |
| ❌ Still open | C-4 (see correction), C-5, H-2, H-3, H-9, M-2, M-3, M-5, M-6, M-7, L-2, L-4, plus all three Architecture concerns |
| ❌ Still open (C++ side) | 12 of 14 items in [cpp_audit.md](./cpp_audit.md) — #6 and the new #15 are fixed |

**Correction to C-4:** the ".env … committed to git" claim was **wrong**. `.env` is listed in `.gitignore` and `git ls-files` returns only `.env.example` — `.env` has never been tracked in any commit. The real residual issue is narrower: your local `.env` ships an empty `REDIS_PASSWORD=`. Treat the rest of C-4 as invalid.

**Newly found, not in the original list:** `CppSpatialBridge.stop()` could crash the host Node process via an unhandled `EPIPE` stream error. Fixed during the restore.

**Newly found 2026-09-26 — FR10 was only enforced on the TypeScript index.** `DriverRegistry` is the single funnel for every index mutation, but it was handed only the TS `QuadTree`; the C++ mirror was fed `insert` + `batchUpdate` from `server.ts` and **never told about `remove`**. So a driver locked, marked busy, or evicted stayed discoverable through `cppBridge.kNearestNeighbors` — the exact path `server.ts` uses to answer matching — letting offers go to unavailable drivers. Fixed by routing all registry mutations through `idxInsert`/`idxUpdate`/`idxRemove` and attaching the bridge as a mirror (`driverRegistry.setMirror(cppBridge)`). Covered by `tests/test_cpp_engine_e2e.ts` E3.

---

## 🔴 CRITICAL Findings

### C-1: Command Injection via C++ IPC Bridge
| | |
|---|---|
| **File** | [cpp_spatial_bridge.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/spatial/cpp_spatial_bridge.ts#L133-L154) |
| **Lines** | 133, 139, 148, 154, 167 |
| **Category** | Security — Command Injection |

**Description:** Driver IDs are directly interpolated into space-delimited IPC commands (e.g., `` `INSERT ${id} ${lat} ${lng}` ``). An attacker-controlled `id` containing spaces or newlines (e.g., `driver1 0 0\nREMOVE driver2\nQUIT`) can execute arbitrary commands against the C++ engine.

**Impact:** Full compromise of the spatial index, denial of service, unauthorized data manipulation (removing/relocating other drivers).

**Fix:** Validate `id` with a strict regex (`^[a-zA-Z0-9_-]+$`) before any IPC command, or migrate to structured JSON payloads.

---

### C-2: IPC Queue Desync — Single Parse Error Corrupts All Subsequent Matches
| | |
|---|---|
| **File** | [cpp_spatial_bridge.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/spatial/cpp_spatial_bridge.ts#L56-L69) |
| **Lines** | 56–69 |
| **Category** | Error Handling — Cascading Failure |

**Description:** In the `rl.on("line")` handler, if `JSON.parse(line)` throws, the `catch` block logs the error but does **not** shift the corresponding resolver from `pendingQueue` and does **not** reject it. This means:
1. The failed request's promise hangs **forever** (memory leak).
2. The queue is **permanently desynchronized** — every subsequent response resolves the **wrong** promise.

**Impact:** A single malformed C++ output permanently breaks the bridge. Wrong drivers get matched to wrong riders. Memory leaks from dangling promises.

**Fix:**
```typescript
// In the catch block:
const failedResolver = this.pendingQueue.shift();
if (failedResolver) failedResolver({ status: "error", error: String(err) });
```

---

### C-3: In-Memory / Redis State Divergence (Split-Brain)
| | |
|---|---|
| **Files** | [driver_registry.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/driver_registry.ts#L151-L177), [matching_service.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/matching_service.ts#L362-L371) |
| **Category** | Concurrency — Distributed State |

**Description:** `acquireLock()` first checks `driver.status !== "available"` in-memory (L157), then conditionally calls `redisLock.acquireLock()`. If Redis acquires the lock but the process crashes before updating the in-memory `driver.lockToken` and calling `spatialIndex.remove()` (L176), the in-memory state on a restarted/different node will still show the driver as "available" in the QuadTree — while Redis has them locked. The reverse is also true: in-memory lock can succeed while Redis is down.

The `releaseLock()` path (L188-203) similarly has a window where Redis releases succeed but in-memory re-insertion into the QuadTree fails, leaving a phantom locked driver.

**Impact:** Double-booking of drivers across cluster nodes. A driver locked by Node A appears available to Node B's QuadTree.

**Fix:** Treat Redis as the source of truth. On lock acquisition failure in Redis, don't modify in-memory state. On process startup, reconcile in-memory QuadTree state from Redis lock/state hashes.

---

### C-4: `.env` File Ships an Empty `REDIS_PASSWORD`
| | |
|---|---|
| **File** | [.env](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/.env#L9) |
| **Line** | 9 |
| **Category** | Security — Weak Configuration |

> **Corrected 2026-09-26:** the original claim that this file is *committed to git* was false — `.env` is in `.gitignore` and has never been tracked. Only `.env.example` is committed. The finding is downgraded to a local-configuration issue.

**Description:** The local `.env` has `REDIS_PASSWORD=` (empty). `.env.example` is identical (317 bytes both), so a fresh clone inherits the same empty value and:

1. Development/staging Redis runs with **no authentication** by default.
2. `docker-compose.monitoring.yml` and `redis_client.ts` never enable `requirepass`.

**Impact:** If the Redis port is reachable beyond localhost, unauthenticated access allows data exfiltration, key manipulation, and `FLUSHALL`.

**Fix:** Set a strong `REDIS_PASSWORD` in every non-local environment and enable Redis `requirepass`. Keep `.env` gitignored (it already is) — do not add real secrets to `.env.example`.

---

### C-5: No WebSocket Authentication — Role Spoofing
| | |
|---|---|
| **File** | [server.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/server.ts#L797-L810) |
| **Lines** | 797–810 |
| **Category** | Security — Authentication Bypass |

**Description:** The WebSocket upgrade handler at `/ws` accepts `role` and `id` as query parameters with no cryptographic verification:
```typescript
const role: ClientRole = (query.role as ClientRole) || "observer";
const clientId = query.id;
wsManager.handleConnection(socket, role, clientId);
```
Any client can connect as `?role=driver&id=sim_driver_1` and impersonate any driver — accepting/rejecting ride offers, sending fake telemetry, and hijacking trips.

**Impact:** Complete impersonation of any driver or rider. An attacker can accept all ride offers, cancel trips, and inject fake GPS data.

**Fix:** Implement JWT or session-token authentication on the WS upgrade. Validate `id` ownership against the token's claims.

---

## 🟠 HIGH Findings

### H-1: Unresolved Promises Leaked on C++ Process Exit
| | |
|---|---|
| **File** | [cpp_spatial_bridge.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/spatial/cpp_spatial_bridge.ts#L72-L78) |
| **Lines** | 72–78, 181–191 |
| **Category** | Memory Leak / Hanging Requests |

When the C++ process crashes or `stop()` is called, `pendingQueue` is not drained. All pending queries hang forever.

**Fix:** On exit/stop, reject all pending promises:
```typescript
while (this.pendingQueue.length > 0) {
  const resolver = this.pendingQueue.shift()!;
  resolver({ status: "error", error: "C++ engine disconnected" });
}
```

---

### H-2: No WS Rate Limiting or Message Size Limits
| | |
|---|---|
| **File** | [ws_manager.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/gateway/ws_manager.ts#L62-L70) |
| **Category** | Security — DoS |

No rate limiting on incoming WebSocket messages. No `maxPayload` configuration. A malicious client can flood the server with thousands of `ride_request` or `driver_telemetry` messages per second, exhausting CPU, Redis connections, and memory.

**Fix:** Add per-client rate limiting (e.g., token bucket). Set `maxPayload` on the WebSocket server. Implement connection limits per IP.

---

### H-3: No WS Heartbeat / Ping-Pong — Zombie Connections
| | |
|---|---|
| **File** | [ws_manager.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/gateway/ws_manager.ts) |
| **Category** | Resource Leak |

The `ClientConnection` interface defines `isAlive: boolean` (L13) but it is **never used**. There is no server-side ping/pong heartbeat interval. Half-open TCP connections (e.g., client lost network) will accumulate indefinitely, leaking memory via the `observerSockets` Set, `riderSockets` and `driverSockets` Maps.

**Fix:** Implement a 30s ping interval. On pong, set `isAlive = true`. On tick, terminate connections where `isAlive === false`.

---

### H-4: QuadTree Never Collapses — Unbounded Memory Bloat
| | |
|---|---|
| **File** | [quadtree.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/spatial/quadtree.ts#L274-L293) |
| **Lines** | 274–293 |
| **Category** | Memory Leak |

`remove()` deletes a point from a leaf but never merges empty subtrees back into their parent. Over hours of operation with drivers moving across boundaries, the tree continuously subdivides but never shrinks, causing O(n) empty node overhead and degraded KNN traversal.

**Fix:** After removal, check if all 4 siblings are empty leaf nodes. If so, collapse the parent back to an undivided leaf.

---

### H-5: Synchronous `fs.readFileSync` on Every Root Page Request
| | |
|---|---|
| **File** | [server.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/server.ts#L189-L203) |
| **Lines** | 189–203, 207–213 |
| **Category** | Blocking — Event Loop |

The `GET /` and `GET /dashboard` handlers call `fs.readFileSync()` on every request. This blocks the event loop during disk I/O, creating latency spikes for all concurrent WebSocket and matching operations.

**Fix:** Read the HTML once at startup and serve from memory, or use Fastify's static file plugin properly.

---

### H-6: `reset()` Method Calls Async `releaseLock()` Without `await`
| | |
|---|---|
| **File** | [matching_service.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/matching_service.ts#L265-L278) |
| **Lines** | 265–278 |
| **Category** | Error Handling — Silent Failure |

```typescript
this.driverRegistry.releaseLock(offer.driverId, requestId); // Missing await!
...
this.driverRegistry.completeTrip(assignedDriverId);          // Missing await!
```

Both `releaseLock()` and `completeTrip()` are async (they call Redis). Without `await`, any Redis errors are silently swallowed, and locks may remain held after region reset.

**Fix:** Make `reset()` async and `await` all Redis operations (or use `Promise.allSettled`).

---

### H-7: `abortedRequests` Set Grows Without Bound
| | |
|---|---|
| **File** | [matching_service.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/matching_service.ts#L61) |
| **Line** | 61 |
| **Category** | Memory Leak |

`abortedRequests` is a `Set<string>` that is added to on every cancellation (L227) and region reset (L262) but is only deleted from when a new ride with the same `requestId` starts (L116). Cancelled rides never reuse their `requestId`, so this set **grows monotonically forever**.

**Fix:** Delete the `requestId` from `abortedRequests` at the end of `dispatchOfferLoop()` after the loop finishes or aborts.

---

### H-8: `trips` Map in `TripStateMachine` Grows Without Eviction
| | |
|---|---|
| **File** | [trip_state_machine.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/trip_state_machine.ts#L73) |
| **Line** | 73 |
| **Category** | Memory Leak |

The `trips` and `requestToTrip` Maps grow on every `createTrip()` call. `clearActiveIndices()` only removes from `activeRiderTrips` and `activeDriverTrips` — the trip record itself is **never deleted**. Over days of operation with thousands of trips, this will consume significant memory.

**Fix:** Implement a TTL-based eviction or circular buffer for completed/cancelled trips. Delete from `trips` and `requestToTrip` after a configurable retention period.

---

### H-9: Event Loop Blocking in `spatial_hash_grid.js` KNN Search
| | |
|---|---|
| **File** | [spatial_hash_grid.js](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/spatial_hash_grid.js) |
| **Category** | Blocking — Event Loop |

The `kNearestNeighbors` search unconditionally expands outward to `maxRing` without early termination. For large radii (e.g., 50km), this scans hundreds of cells synchronously, freezing the V8 event loop.

**Fix:** Track the k-th worst distance. If `ring * cellSizeMeters > worstDistance`, break the outer loop.

---

## 🟡 MEDIUM Findings

### M-1: `requestId` Auto-Generated with `Date.now()` — Not Collision-Safe
| | |
|---|---|
| **Files** | [server.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/server.ts#L643), [ws_manager.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/gateway/ws_manager.ts#L129) |
| **Category** | Correctness — Idempotency |

When no `requestId` is provided, both the HTTP and WS handlers generate one via `` `req_${Date.now()}` ``. Under concurrent load, two requests arriving in the same millisecond get the same `requestId`, causing the second to be treated as an idempotent retry of the first.

**Fix:** Use `crypto.randomUUID()` for auto-generated request IDs.

---

### M-2: `create_trip.lua` — Missing TTL on `request:trip:` and `trip:` Keys
| | |
|---|---|
| **File** | [create_trip.lua](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/infra/lua/create_trip.lua#L22-L24) |
| **Lines** | 22–24 |
| **Category** | Redis — Resource Leak |

The Lua script sets `rider:active_trip:` with a 7200s TTL (good), but `request:trip:{requestId}` (L22) and `trip:{tripId}` (L23) are set **without any TTL**. These keys persist forever even after trips complete, causing unbounded Redis memory growth.

**Fix:** Set TTLs on all trip-related keys (e.g., 24h for trip data, 2h for request mapping).

---

### M-3: Redis `release_lock.lua` Doesn't Reset Driver State Hash
| | |
|---|---|
| **File** | [release_lock.lua](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/infra/lua/release_lock.lua) |
| **Category** | State Inconsistency |

`release_lock.lua` only deletes the lock key but does **not** update `driver:state:{driverId}` back to `"available"`. Meanwhile, `commit_trip.lua` sets the state to `"busy"`. After a failed commit + release, the `driver:state` hash may still show `"busy"` even though the lock was released — preventing the driver from being locked again (since `acquire_lock.lua` checks for `status == "busy"`).

**Fix:** In `release_lock.lua`, also `HSET` the driver state back to `"available"` (or add a separate recovery mechanism).

---

### M-4: `reconcileOrphanedTrips` Uses `redis.keys()` — O(N) Full Scan
| | |
|---|---|
| **File** | [redis_trip_store.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/redis_trip_store.ts#L116) |
| **Line** | 116 |
| **Category** | Performance — Redis Blocking |

`redis.keys("rider:active_trip:*")` performs a full keyspace scan. In production with thousands of keys, this blocks the Redis event loop for potentially hundreds of milliseconds, impacting all other clients.

**Fix:** Use `SCAN` with a cursor-based iterator, or maintain a separate set tracking active rider keys.

---

### M-5: Grafana Admin Credentials Hardcoded in Docker Compose
| | |
|---|---|
| **File** | [docker-compose.monitoring.yml](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/docker-compose.monitoring.yml#L26-L27) |
| **Lines** | 26–27 |
| **Category** | Security — Hardcoded Credentials |

```yaml
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=admin
```

Default `admin/admin` credentials are committed. Anyone with network access to port 3001 gets full Grafana admin access.

**Fix:** Use environment variable references or Docker secrets for Grafana credentials.

---

### M-6: Empty `cpp_koffi_spatial_bridge.ts` File — Broken Import
| | |
|---|---|
| **File** | [cpp_koffi_spatial_bridge.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/spatial/cpp_koffi_spatial_bridge.ts) |
| **Category** | Architectural — Dead Code |

The file is 0 bytes. Any import will yield `undefined` exports, causing runtime crashes if referenced.

**Fix:** Implement the Koffi bridge or remove the file entirely.

---

### M-7: `handleDriverCancellation` in `RedisTripStore` Bypasses State Machine Validation
| | |
|---|---|
| **File** | [redis_trip_store.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/redis_trip_store.ts#L211-L243) |
| **Lines** | 211–243 |
| **Category** | Correctness — State Integrity |

This method directly mutates `trip.status = "matching"` or `"cancelled"` and calls `saveTrip()` without routing through the `TripStateMachine.transition()` method. This bypasses:
- Allowed-transition validation
- Role authorization checks
- Audit event recording
- `onTransition` callbacks

**Fix:** Route through `stateMachine.rematchTrip()` or `stateMachine.cancelTrip()` instead of directly mutating trip status.

---

### M-8: Simulated Drivers Auto-Respond to Offers — No Guard Against Real Drivers
| | |
|---|---|
| **File** | [server.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/server.ts#L92) |
| **Line** | 92 |
| **Category** | Correctness — Business Logic |

```typescript
onOfferDispatched: (notif) => {
  wsManager.notifyDriverOffer(notif.driverId, notif);
  simulator.handleIncomingOffer(notif.driverId, notif.requestId); // Always called!
},
```

Every dispatched offer triggers the simulator's auto-response, even for real WebSocket-connected drivers. If a real driver and the simulator both respond, it creates a race where the simulator's response (1.2–2.8s) may override the real driver's intent.

**Fix:** Only call `simulator.handleIncomingOffer()` if `virtualDrivers.has(driverId)`. The simulator already has this guard internally, but the server dispatches to it unconditionally.

---

## 🟢 LOW Findings

### L-1: `LOCK_SAFETY_MARGIN_MS` Comment Says "1 second" But Value is 3000ms
| | |
|---|---|
| **File** | [matching_service.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/matching_service.ts#L350) |
| **Line** | 350 |

```typescript
const LOCK_SAFETY_MARGIN_MS = 3000; // 1 second safety margin...
```
Comment is stale/incorrect. Misleads future developers.

---

### L-2: Duplicate `GeoPoint` Interface Definition
| | |
|---|---|
| **Files** | [validation.ts L1](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/utils/validation.ts#L1), [trip_state_machine.ts L15](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/trip_state_machine.ts#L15) |

`GeoPoint` is defined independently in both files. This creates type-checking fragility if one changes.

**Fix:** Export from a single shared location.

---

### L-3: `console.log` in Production Hot Path — Commit Trip
| | |
|---|---|
| **File** | [redis_driver_lock.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/redis_driver_lock.ts#L69) |
| **Line** | 69 |

```typescript
console.log(`Committing trip for driver ${driverId} with request ID ${requestId}`);
```

This runs on every trip commit in production. Console I/O is synchronous and can block the event loop under high throughput.

**Fix:** Use structured logging at `debug` level, or remove.

---

### L-4: `scripts_check_redis.ts` is an Empty File (0 bytes)
| | |
|---|---|
| **File** | [scripts_check_redis.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/scripts_check_redis.ts) |

Dead file adding noise. Remove or implement.

---

### L-5: Commented-Out `cancelRide` Method Left in Source
| | |
|---|---|
| **File** | [matching_service.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/core/matching_service.ts#L180-L221) |
| **Lines** | 180–221 |

40+ lines of commented-out code. Use version control instead of keeping dead code in-source.

---

## Architecture & Design Concerns

### Missing Graceful Shutdown for Active Trips

[server.ts L828-843](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/server.ts#L828-L843): The shutdown handler stops the simulator and closes Fastify, but does **not**:
- Cancel active matching loops
- Release held driver locks in Redis
- Save in-flight trip state to Redis
- Drain pending WebSocket messages

Trips in `matching` status during shutdown become orphans until `reconcileOrphanedTrips` runs on next startup.

### No Circuit Breaker on Redis

[redis_client.ts](file:///d:/MyWorkspace/Projects/RT_Ride_Matching_System/src/infra/redis_client.ts): If Redis becomes unavailable, every matching operation will fail with unhandled rejections propagating through `acquireLock()`, `commitTrip()`, and `saveTrip()`. There's no circuit breaker to fall back to local-only matching or queue requests.

### Single-Node In-Memory State

The `TripStateMachine`, `DriverRegistry`, and `MatchingService` all maintain in-memory Maps. In a multi-node deployment, these diverge immediately. The Redis store partially addresses this but the matching loop runs entirely in-memory.

---

## Summary Table

| ID | Severity | Category | File | Issue |
|-----|----------|--------------------------|-------------------------------|----------------------------------------------|
| C-1 | 🔴 CRITICAL | Security | `cpp_spatial_bridge.ts` | Command injection via IPC |
| C-2 | 🔴 CRITICAL | Error Handling | `cpp_spatial_bridge.ts` | Parse error desyncs entire pending queue |
| C-3 | 🔴 CRITICAL | Concurrency | `driver_registry.ts` | In-memory/Redis split-brain on locks |
| C-4 | 🔴 CRITICAL | Security | `.env` | Empty `REDIS_PASSWORD` *(corrected: never committed to git)* |
| C-5 | 🔴 CRITICAL | Security | `server.ts` | WebSocket role/ID spoofing — no auth |
| H-1 | 🟠 HIGH | Memory Leak | `cpp_spatial_bridge.ts` | Pending promises leaked on process exit |
| H-2 | 🟠 HIGH | Security — DoS | `ws_manager.ts` | No rate limiting or message size limits |
| H-3 | 🟠 HIGH | Resource Leak | `ws_manager.ts` | No ping/pong heartbeat, zombie connections |
| H-4 | 🟠 HIGH | Memory Leak | `quadtree.ts` | Never collapses empty subtrees |
| H-5 | 🟠 HIGH | Blocking | `server.ts` | `readFileSync` on every HTTP request |
| H-6 | 🟠 HIGH | Error Handling | `matching_service.ts` | `reset()` doesn't await async Redis calls |
| H-7 | 🟠 HIGH | Memory Leak | `matching_service.ts` | `abortedRequests` set grows forever |
| H-8 | 🟠 HIGH | Memory Leak | `trip_state_machine.ts` | `trips` map never evicts completed trips |
| H-9 | 🟠 HIGH | Blocking | `spatial_hash_grid.js` | KNN search blocks event loop on large radius |
| M-1 | 🟡 MEDIUM | Correctness | `server.ts`, `ws_manager.ts` | `Date.now()` requestId collisions |
| M-2 | 🟡 MEDIUM | Redis Leak | `create_trip.lua` | No TTL on trip/request keys |
| M-3 | 🟡 MEDIUM | State Inconsistency | `release_lock.lua` | Doesn't reset driver state hash |
| M-4 | 🟡 MEDIUM | Performance | `redis_trip_store.ts` | `KEYS *` blocks Redis on large keyspace |
| M-5 | 🟡 MEDIUM | Security | `docker-compose.yml` | Hardcoded Grafana admin/admin |
| M-6 | 🟡 MEDIUM | Architecture | `cpp_koffi_spatial_bridge.ts` | Empty file — broken import path |
| M-7 | 🟡 MEDIUM | Correctness | `redis_trip_store.ts` | Bypasses state machine validation |
| M-8 | 🟡 MEDIUM | Correctness | `server.ts` | Simulator responds for real drivers too |
| L-1 | 🟢 LOW | Documentation | `matching_service.ts` | Stale comment (1s vs 3s) |
| L-2 | 🟢 LOW | Code Quality | Multiple | Duplicate `GeoPoint` interface |
| L-3 | 🟢 LOW | Performance | `redis_driver_lock.ts` | `console.log` in hot path |
| L-4 | 🟢 LOW | Dead Code | `scripts_check_redis.ts` | Empty file |
| L-5 | 🟢 LOW | Dead Code | `matching_service.ts` | 40 lines of commented-out code |

---

## Recommended Priority Order

*Rewritten 2026-09-26 to cover only what is still open — C-1, C-2, H-1, H-4 through H-8, M-1, M-4, M-8 and L-1/L-3/L-5 are fixed and regression-tested.*

1. **Immediate (Before any deployment):** C-5 (WebSocket role spoofing), C-4 (enable Redis `requirepass` before the port is reachable)
2. **This sprint:** C-3 (startup reconciliation of QuadTree from Redis), M-3 (`release_lock.lua` doesn't reset `driver:state`), M-7 (`handleDriverCancellation` bypasses the state machine)
3. **Next sprint:** H-2 (WS rate limits / `maxPayload`), H-3 (ping-pong heartbeat), H-9 (KNN early exit), M-2 (missing TTLs on trip keys)
4. **Backlog:** M-5 (Grafana credentials), M-6 (empty `cpp_koffi_spatial_bridge.ts`), all three Architecture concerns, and all 14 items in `cpp_audit.md`
5. **Cleanup:** L-2 (duplicate `GeoPoint`), L-4 (empty `scripts_check_redis.ts`)
