# Frontend & GPS Telemetry Architecture Specification

This document preserves the architectural blueprint for the **React + WebGL Frontend** and the **Real-Time GPS Telemetry Pipeline** for the InstaRide Matching System.

---

## 1. End-to-End GPS Telemetry Pipeline

```
[ 1. Device Ingestion ]              [ 2. Backend Hot Path ]                 [ 3. Frontend Smooth Render ]

 Driver Mobile Device                   Fastify Gateway                          React + MapLibre GL
 (or Virtual Simulator)                 (In-Memory Engine)                       (Browser Canvas)
        │                                      │                                        │
        │ GPS Tick (1-3 Hz)                    │                                        │
        │ { lat, lng, heading, speed }         │                                        │
        ├─────────────────────────────────────►│                                        │
        │                                      │ 1. Coordinate Sanity Check             │
        │                                      │ 2. Quadtree Leaf Cache Update (0.17µs) │
        │                                      │ 3. Zero Database I/O on hot path       │
        │                                      │                                        │
        │                                      │ Telemetry Batch Broadcast              │
        │                                      ├───────────────────────────────────────►│
        │                                      │                                        │ 1. LERP Interpolation (60 FPS)
        │                                      │                                        │ 2. Smooth Heading Rotation
        │                                      │                                        │ 3. Quadtree Bounding Box Update
```

### 1.1 Ingestion & Transport
- **Protocol**: Binary or lightweight JSON frames over WebSockets (`/ws?role=driver`).
- **Payload Contract**:
  ```json
  {
    "type": "driver_telemetry",
    "driverId": "d_101",
    "lat": 37.7749,
    "lng": -122.4194,
    "heading": 84.5,
    "speed": 12.3,
    "timestamp": 1789935500000
  }
  ```

### 1.2 Backend In-Memory Processing (Sub-Microsecond)
- **Validation**: Rejects `NaN`, latitude outside $[-90, 90]$, and longitude outside $[-180, 180]$.
- **Leaf-Cached Spatial Indexing ($0.17\,\mu\text{s}$)**:
  - Updates use `driverLeaves.get(driverId)` to access the target leaf directly.
  - In-place mutation if driver remains inside the same node boundary.
  - Zero synchronous disk I/O on the hot path.
- **Targeted Fan-out**:
  - If the driver is in an active trip (`en_route` or `in_progress`), coordinate ticks are immediately forwarded to the matched rider socket.

### 1.3 Bandwidth Optimization (Batching)
- To prevent network congestion, driver coordinates are batched and broadcast to observers at 1 Hz via `telemetry_batch`.

### 1.4 Frontend Smooth Rendering
- **Linear Interpolation (LERP)**: Animate marker positions 60 times per second across the 1-second arrival gap to eliminate stuttering:
  $$\text{pos}(t) = \text{start} + (\text{target} - \text{start}) \times t$$
- **Heading & Bearing**: Dynamically compute bearing angle $\theta$ to orient car markers forward:
  $$\theta = \text{atan2}(\sin(\Delta \text{lng})\cos(\text{lat}_2), \cos(\text{lat}_1)\sin(\text{lat}_2) - \sin(\text{lat}_1)\cos(\text{lat}_2)\cos(\Delta \text{lng}))$$
- **Dead-Reckoning**: Extrapolate position using last known velocity vector if connection drops temporarily in tunnels.

---

## 2. React + WebGL Frontend Architecture

### 2.1 Tech Stack
| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Framework** | React 19 + Vite (TypeScript) | High performance, rapid HMR |
| **Map Rendering** | MapLibre GL JS | WebGL 60 FPS vector tiles without API keys |
| **Styling** | Tailwind CSS | Dark dispatch command center theme |
| **State Management**| Zustand | High-frequency telemetry updates without re-render cascades |
| **Iconography** | Lucide React | Clean, scalable UI icons |

### 2.2 Layout & Component Hierarchy
```
client/src/
├── components/
│   ├── Map/
│   │   ├── RideMap.tsx           # MapLibre WebGL container
│   │   ├── QuadTreeOverlay.tsx   # GeoJSON layer for spatial partitions
│   │   ├── CarMarkers.tsx        # LERP-animated car symbols
│   │   └── SearchRadar.tsx       # Animated k-NN expanding circle
│   ├── Panels/
│   │   ├── RiderPanel.tsx        # Pickup/dropoff pins & request button
│   │   ├── DriverPanel.tsx       # 15s circular countdown & trip actions
│   │   ├── ScenariosBar.tsx      # 2-Rider race & stress test triggers
│   │   └── AuditFeed.tsx         # Live CAS lock and state transition stream
│   └── HUD/
│       └── MetricsBar.tsx        # Latency p99, driver counts, active trips
├── hooks/
│   └── useRideSocket.ts          # Auto-reconnecting WebSocket client
└── store/
    └── useRideStore.ts           # Central reactive state store
```

---

## 3. Geographic Region Configurations

Presets for easily switching regions:

```typescript
export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// San Francisco
export const SF_BOUNDS: GeoBounds = {
  minLat: 37.7081, maxLat: 37.8324,
  minLng: -122.5270, maxLng: -122.3482,
};

// Kolkata Metro (City Scale)
export const KOLKATA_BOUNDS: GeoBounds = {
  minLat: 22.4500, maxLat: 22.6500,
  minLng: 88.2500, maxLng: 88.4800,
};

// West Bengal (Regional Scale)
export const WEST_BENGAL_BOUNDS: GeoBounds = {
  minLat: 21.5000, maxLat: 27.3000,
  minLng: 85.8000, maxLng: 89.9000,
};

// India (National Scale)
export const INDIA_BOUNDS: GeoBounds = {
  minLat: 6.7500, maxLat: 35.5000,
  minLng: 68.1000, maxLng: 97.4000,
};
```
