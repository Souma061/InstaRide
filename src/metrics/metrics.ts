import client from "prom-client";

// Initialize default Node.js system metrics (Heap, RSS, Event Loop Lag, GC)
client.collectDefaultMetrics({ prefix: "instaride_" });

// Custom InstaRide Real-Time Dispatch & Spatial Metrics
export const metrics = {
  // Gauges
  activeDrivers: new client.Gauge({
    name: "instaride_drivers_active",
    help: "Total drivers currently registered by status",
    labelNames: ["status"], // 'available' | 'busy' | 'offline'
  }),

  activeTrips: new client.Gauge({
    name: "instaride_trips_active",
    help: "Current trips in flight by lifecycle state",
    labelNames: ["state"], // 'requested' | 'matching' | 'matched' | 'en_route' | 'arrived' | 'in_progress'
  }),

  // Counters
  matchRequestsTotal: new client.Counter({
    name: "instaride_match_requests_total",
    help: "Total ride requests initiated",
    labelNames: ["status"], // 'success' | 'exhausted' | 'cancelled'
  }),

  lockCollisionsTotal: new client.Counter({
    name: "instaride_lock_collisions_total",
    help: "Number of concurrent lock contention events resolved via fallback",
  }),

  doubleDispatchViolations: new client.Counter({
    name: "instaride_double_dispatch_violations_total",
    help: "Double dispatch violation count (Strict 0.00% invariant)",
  }),

  telemetryUpdatesTotal: new client.Counter({
    name: "instaride_telemetry_updates_total",
    help: "Total GPS telemetry pings processed",
  }),

  // Histograms (Distributions for p50, p95, p99)
  matchDurationSeconds: new client.Histogram({
    name: "instaride_match_duration_seconds",
    help: "Time from rider request until driver match",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
  }),

  spatialQueryLatencyUs: new client.Histogram({
    name: "instaride_spatial_query_latency_microseconds",
    help: "k-NN spatial search latency in microseconds",
    labelNames: ["engine"], // 'cpp' | 'ts'
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
  }),

  knnLatencySeconds: new client.Histogram({
    name: "instaride_knn_latency_seconds",
    help: "k-NN spatial search latency in seconds",
    labelNames: ["engine"],
    buckets: [0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01],
  }),
};

export const register = client.register;
