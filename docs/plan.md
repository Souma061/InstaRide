# InstaRide Cassandra Architecture & Experiment Plan (`plan.md`)

This plan replaces CockroachDB with **Apache Cassandra** across three targeted experiments designed to test high-throughput ingestion, real-time telemetry recording, and Cassandra-specific distributed storage capabilities.

---

## The 3 Cassandra Experiments

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INSTARIDE SYSTEM                                  │
│                                                                             │
│  [Driver Simulator] ───(GPS Pings)────┐                                     │
│  [Trip State Machine] ─(Transitions)──┤                                     │
│                                       ▼                                     │
│                     ┌───────────────────────────────────┐                   │
│                     │       Asynchronous Buffer         │                   │
│                     └─────────────────┬─────────────────┘                   │
│                                       │                                     │
│               ┌───────────────────────┴───────────────────────┐             │
│               ▼                                               ▼             │
│    ┌─────────────────────┐                         ┌─────────────────────┐  │
│    │     REDIS (Hot)     │                         │   CASSANDRA (Cold)  │  │
│    │  • Current Location │                         │  • GPS Breadcrumbs  │  │
│    │  • Geospatial Index │                         │  • Trip Audit Log   │  │
│    │  • Ephemeral State  │                         │  • Historical Sinks │  │
│    └─────────────────────┘                         └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Experiment 1: Head-to-Head Write Benchmark (Redis vs. Cassandra)
- **Goal:** Measure raw write throughput and latency distribution under heavy GPS ping bursts.
- **Scope:**
  - Ingest 50,000–100,000 simulated GPS pings (`driver_id`, `lat`, `lng`, `timestamp`).
  - **Redis Baseline:** Pipelined `HSET` / `GEOADD` batches (500 pings per pipeline).
  - **Cassandra Test:** Concurrent prepared CQL `INSERT` statements into time-series partitioned table (`PRIMARY KEY ((driver_id), timestamp)`).
  - **Metrics:** Throughput ($pings/sec$), $p50$, $p95$, $p99$ latency percentiles.

---

### Experiment 2: The "Black Box Flight Recorder" (Telemetry & State Machine Integration)
- **Goal:** Connect live application services to Cassandra for millisecond time-series playback and immutable audit tracking.
- **Components:**
  1. **GPS Breadcrumbs (`instaride.driver_breadcrumbs`):**
     - Hook non-blocking buffer to `DriverSimulator.onTelemetryTick`.
     - Partition key: `(driver_id, date)`. Clustering key: `timestamp DESC`.
     - Enables exact trajectory reconstruction and speed analysis.
  2. **Trip Audit Trail (`instaride.trip_audit_log`):**
     - Hook non-blocking buffer to `TripStateMachine.onTransition`.
     - Partition key: `trip_id`. Clustering key: `timestamp ASC`.
     - Record immutable event stream: `from_status`, `to_status`, `triggered_by`, `reason`.
  3. **Verification:** Run the simulator, then inspect live breadcrumbs and transition trails directly via `cqlsh`.

---

### Experiment 3: Tunable Consistency & High-Concurrency Batching Showdown
- **Goal:** Stress Cassandra's distributed storage engine under different write patterns and consistency levels.
- **Test Scenarios:**
  - **Single Asynchronous Concurrent Writes vs. `UNLOGGED BATCH`:** Compare individual prepared concurrent promises vs batched partition writes to understand Cassandra's optimal write path.
  - **Consistency Level Benchmark:** Compare latency and throughput under `ConsistencyLevel.ONE` vs `ConsistencyLevel.QUORUM`.
  - **Burstable Ingestion:** Fire a high-frequency burst (10,000 writes in under 200ms) to test non-blocking buffering and backpressure handling.

---

## Implementation Roadmap

### Phase 1: Infrastructure & Dependencies
- [x] **1.1 Docker Compose Setup (`docker-compose.cassandra.yml`)**
  - Cassandra 4.1 container with lightweight JVM flags (`MAX_HEAP_SIZE=512M`, `HEAP_NEWSIZE=128M`) on port `9042`.
  - Redis container (`redis:7-alpine`) on port `6379`.
- [x] **1.2 Install Node Driver**
  - Added `cassandra-driver` and `@types/cassandra-driver`.
- [x] **1.3 Cassandra Client & Schema Migration**
  - Created `src/infra/cassandra_client.ts` with auto-keyspace and table initialization.

### Phase 2: Experiment 1 Execution (Showdown Benchmark)
- [x] **2.1 Implement & Run `tests/benchmark_redis_vs_cassandra.ts`**
  - Ingested 50,000 synthetic GPS records.
  - Redis Pipeline 500: **159,613 ops/sec** (p50: 2.75ms)
  - Cassandra Prepared Concurrent: **32,780 ops/sec** (p50: 6.02ms)
  - Cassandra UNLOGGED BATCH 50: **217,485 ops/sec** (p50: 12.07ms)

### Phase 3: Experiment 2 Execution (Flight Recorder)
- [x] **3.1 Build `CassandraFlightRecorder` buffer (`src/infra/flight_recorder.ts`)**
  - Hooked non-blocking buffer to `DriverSimulator.onTelemetryTick` & `TripStateMachine.onTransition`.
- [x] **3.2 Run and Query (`tests/test_flight_recorder.ts`)**
  - Simulated 50 roaming virtual drivers and full 6-phase trip state machine lifecycles.
  - Successfully retrieved time-series GPS breadcrumbs and immutable chronological audit trails from Cassandra.

### Phase 4: Experiment 3 Execution (Consistency & Batch Stress)
- [x] **4.1 Implement & Run `tests/benchmark_cassandra_patterns.ts`**
  - Intra-Partition UNLOGGED: **323,331 ops/sec** (p50: 9.04ms)
  - Cross-Partition UNLOGGED: **178,277 ops/sec** (p50: 10.19ms, p95: 50.47ms - 2.5x latency penalty due to coordinator fanout)
  - Individual Concurrent QUORUM: **103,892 ops/sec** (p50: 2.18ms)
  - Individual Concurrent ONE: **63,900 ops/sec** (p50: 2.98ms)
