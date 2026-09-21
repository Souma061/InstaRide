# InstaRide: Master Architecture, System Design & Technical Roadmap

This living document consolidates all core architectural foundations, mathematical proofs, system trade-offs, pricing models, and future expansion possibilities for the **InstaRide Real-Time Spatial Matching Platform**.

---

## Table of Contents

1. [Core Engine (Implemented Architecture)](#1-core-engine-implemented-architecture)
2. [Spatial Indexing & Geometric Proofs](#2-spatial-indexing--geometric-proofs)
3. [Multi-Region & Geographic Scalability](#3-multi-region--geographic-scalability)
4. [Graph Road Network & Routing Engine](#4-graph-road-network--routing-engine)
5. [Fare Calculation & Dynamic Route Economics](#5-fare-calculation--dynamic-route-economics)
6. [Dispatch Optimization (Greedy vs. Batch Matching)](#6-dispatch-optimization-greedy-vs-batch-matching)
7. [Fault Tolerance, Edge Cases & Concurrency](#7-fault-tolerance-edge-cases--concurrency)
8. [GPS Telemetry & High-Frame-Rate Visualization](#8-gps-telemetry--high-frame-rate-visualization)
9. [Living Backlog & Future Possibilities](#9-living-backlog--future-possibilities)

---

## 1. Core Engine (Implemented Architecture)

The system is built around an in-memory, zero-disk-I/O hot path executing in sub-millisecond latency:

```
[ Rider Request ] ────────► [ Fastify Gateway (HTTP / WebSockets) ]
                                            │
                                            ▼
                                [ MatchingService ]
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
          [ DriverRegistry ]                              [ TripStateMachine ]
     - Available-Only Invariant                      - Deterministic 8-State Matrix
     - Atomic CAS Lock Lease (15s TTL)               - Role Authorization Guards
     - O(1) Leaf-Cached Quadtree                     - Rematch on Driver Breakdown
```

### The Invariants

1. **Available-Only Spatial Invariant**: The spatial index contains _exclusively_ available drivers. The moment an atomic lock is acquired, the driver is evicted from the Quadtree to prevent competing riders from even discovering them.
2. **Event-Loop CAS Atomicity**: By executing `acquireLock()` synchronously without `await` pauses on the Node.js event loop, lock claims are atomic, guaranteeing **0% double-dispatch** under thousands of concurrent requests.
3. **15-Second Offer Lease Loop**: Each candidate receives an exclusive 15-second offer window. Rejection or timeout immediately releases the lock back to the Quadtree and falls back to candidate #2.

---

## 2. Spatial Indexing & Geometric Proofs

### 2.1 The Point-Region Quadtree with Leaf Caching

- **Dual-Heap Branch & Bound**: Prunes spatial quadrants using `minDistanceToBox()` before computing expensive Haversine distances.
- **Leaf Caching ($0.17\,\mu\text{s}$)**: Direct node pointer storage (`driverLeaves.get(driverId)`) turns 90% of GPS updates into $O(1)$ in-place mutations instead of $O(\log N)$ root-down re-traversals.

### 2.2 Why `maxDepth = 7` (Preventing Airport Cluster Degeneracy)

Every division halves the bounding box ($2^D$). In a $15\,\text{km}$ city:

|    Depth ($D$)    |                Physical Cell Size                |         Real-World Scale          |
| :---------------: | :----------------------------------------------: | :-------------------------------: |
|      $D = 0$      |       $15\,\text{km} \times 15\,\text{km}$       |            Entire City            |
|      $D = 3$      |      $1.8\,\text{km} \times 1.8\,\text{km}$      |           Neighborhood            |
|      $D = 5$      |       $460\,\text{m} \times 460\,\text{m}$       |         A few city blocks         |
| **$D = 7$ (Cap)** | **$\approx 115\,\text{m} \times 115\,\text{m}$** | **City Block / Airport Taxi Lot** |
|     $D = 15$      |   $\approx 45\,\text{cm} \times 45\,\text{cm}$   |        Steering wheel size        |
|     $D = 20$      |  $\approx 1.4\,\text{cm} \times 1.4\,\text{cm}$  | Coin size (Stack Overflow hazard) |

**The Golden Rule**:

> Beyond ~100m, flat in-memory array scans across contiguous CPU L1 cache take $< 1\,\mu\text{s}$, beating 15 levels of nested object pointers. Capping at `maxDepth = 7` prevents infinite recursion when 200 drivers idle in the same parking lot.

### 2.3 The Geometric Proof: Why Only Triangles, Squares, and Hexagons Tile a Plane

To tile a 2D plane without gaps or overlapping, vertex interior angles must divide $360^\circ$ evenly:
$$\theta = \frac{(n - 2) \times 180^\circ}{n}$$

- **Triangle ($n=3$)**: $60^\circ \implies 360^\circ / 60^\circ = 6$ (Tiles)
- **Square ($n=4$)**: $90^\circ \implies 360^\circ / 90^\circ = 4$ (Tiles - Quadtrees)
- **Hexagon ($n=6$)**: $120^\circ \implies 360^\circ / 120^\circ = 3$ (Tiles - Uber H3)
- **Octagon ($n=8$)**: $135^\circ \implies 360^\circ / 135^\circ = 2.666\dots$ (**Impossible without leaving $90^\circ$ square gaps**).

---

## 3. Multi-Region & Geographic Scalability

The core engine is geographically agnostic. Bounding boxes are abstract configurations:

```typescript
export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}
```

### Presets Available:

- **San Francisco**: `[-122.527, 37.708] to [-122.348, 37.832]`
- **Kolkata Metro (City Scale)**: `[88.250, 22.450] to [88.480, 22.650]`
- **West Bengal (Regional Scale)**: `[85.800, 21.500] to [89.900, 27.300]`
- **All India (National Scale)**: `[68.100, 6.750] to [97.400, 35.500]`

### Multi-City Sharding Strategy

For national scaling, partition cities into separate Quadtree workers:

```typescript
const regionalIndexes = new Map<string, QuadTree>([
  ["kolkata", new QuadTree(KOLKATA_BOUNDS)],
  ["san_francisco", new QuadTree(SF_BOUNDS)],
]);
```

---

## 4. Graph Road Network & Routing Engine

Physical roads are **Directed, Weighted Graphs** ($G = (V, E)$):

- **Vertices ($V$)**: Intersections, flyover ramps, dead-ends.
- **Edges ($E$)**: One-way and two-way road segments with dual weights:
  - $w_{\text{dist}}$: Length in meters.
  - $w_{\text{time}}$: $\frac{\text{Distance}}{\text{Speed} \times \text{Congestion Factor}}$.

### 4.1 Two-Layer Hybrid Spatial-Graph Pipeline

```
[ Raw GPS (lat, lng) ]
          │
          ▼
[ Layer 1: Spatial Snapping (Quadtree) ]
  • Snaps coordinate to nearest road edge on the street network
          │
          ▼
[ Layer 2: Graph Shortest Path (A* / Contraction Hierarchies) ]
  • Query 1 (Min Distance): Shortcut Route (Alleys/Streets) -> 6 km | 18 min
  • Query 2 (Min Time): Express Route (Bypass/Highway)      -> 14 km | 12 min
```

### 4.2 Accelerating Graph Search (Contraction Hierarchies)

Standard Dijkstra takes 200–500ms over 2,000,000 city road segments.
**Contraction Hierarchies (CH)** pre-calculates arterial shortcuts to drop citywide route queries from **500ms down to $< 1\,\text{ms}$**.

---

## 5. Fare Calculation & Dynamic Route Economics

### 5.1 Base Formula

$$\text{Fare} = (\text{Base} + D \times R_{\text{dist}} + T \times R_{\text{time}}) \times \text{Surge} + \text{Tolls} - \text{Discount}$$

### 5.2 The Shortcut vs. Long-Cut Dilemma

- **Shortcut Route (City streets)**: $6\,\text{km}$, $18\,\text{mins} \implies ₹138$.
- **Express Route (Highway)**: $14\,\text{km}$, $12\,\text{mins} \implies ₹222$.

### 5.3 Real-Time GPS Corridor Tracking

1. At booking, backend generates both route corridors (Path A & Path B).
2. During the ride, if driver GPS stays within 50m of the shortcut:
   - Server activates the **Shortcut Discount** (e.g. Save ₹84).
   - WebSocket pushes: _"Driver took the shortcut! Fare discounted by ₹84."_
3. **Anti-Detour Protection (Deviation Ceiling)**: If a driver takes an unauthorized detour to inflate the meter, the fare is hard-capped to the upfront estimate.

---

## 6. Dispatch Optimization (Greedy vs. Batch Matching)

| Dimension        | Greedy Dispatch (Simple)          | Batch Matching (Uber DISCO Style)                          |
| :--------------- | :-------------------------------- | :--------------------------------------------------------- |
| **Trigger**      | Immediate on rider request        | 3–5 second collection window                               |
| **Optimization** | Local optimum (first nearest car) | Global city-wide minimum wait time                         |
| **Algorithm**    | $k$-NN spatial lookup             | **Weighted Bipartite Matching** (Kuhn-Munkres / Hungarian) |
| **Trade-off**    | Fast response, but sub-optimal    | Short 3s wait, but saves 15–20% citywide travel time       |

---

## 7. Fault Tolerance, Edge Cases & Concurrency

### 7.1 Mid-Trip Network Drops

1. **15s Offer Window Drop**: Server-side TTL deadman switch automatically reclaims the lock and advances to candidate #2.
2. **Brief Cellular Blip (5–10s)**: Client reconnects and sends `sync_state`. State machine immediately rehydrates active trip and driver coordinates.
3. **Driver Disappearance (`en_route`)**: If zero GPS ticks for >30 seconds, server marks driver stale and triggers `rematch(tripId)`, auto-dispatching a replacement car.
4. **Onboard Security (`in_progress`)**: Cancellation and rematching are strictly blocked once rider is physically inside the car.

### 7.2 The 15.002s Late-Accept Race

If Driver 1 taps accept 2ms after lease expiration:

- Server CAS check confirms offer moved to Candidate #2.
- Driver 1 is rejected with `409 Conflict / OFFER_EXPIRED`.
- Driver 1 returns to Quadtree as `available`.

---

## 8. GPS Telemetry & High-Frame-Rate Visualization

### The 4-Stage GPS Flow:

1. **Device**: GPS fired at 1–3 Hz (`lat, lng, heading, speed`).
2. **Backend**: Leaf-cached Quadtree update ($0.17\,\mu\text{s}$), zero DB I/O.
3. **Network**: Batched into 1 Hz `telemetry_batch` to conserve network bandwidth.
4. **Frontend Smoothness**:
   - **LERP (Linear Interpolation)**: 60 FPS `requestAnimationFrame` calculates intermediate positions between 1s ticks.
   - **Heading Rotation**: Dynamically calculates bearing angle $\theta$ so car icons face forward along the road.
   - **Dead-Reckoning**: Extrapolates position during brief tunnel outages.

---

## 9. Living Backlog & Future Possibilities

- [ ] **Surge Heatmaps**: Compute Quadtree leaf density ratios ($\frac{\text{Demand}}{\text{Supply}}$) to render real-time pricing heatmaps.
- [ ] **A\* Graph Routing Engine**: Implement in-memory street network routing with dual-weight shortcuts.
- [ ] **Multi-City Worker Sharding**: Add dynamic region configuration (`REGION=KOLKATA`).
- [ ] **React + MapLibre GL Client**: WebGL vector map frontend with 60 FPS LERP animations.
- [ ] **Batch Dispatcher (Bipartite Matcher)**: Add 3-second batching window option alongside instant greedy dispatch.
- [ ] **PostgreSQL Snapshot Persistence**: Periodic state dump for disaster recovery.
