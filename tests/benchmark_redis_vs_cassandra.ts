import Redis from "ioredis";
import cassandra from "cassandra-driver";
import { initCassandraSchema, getCassandraClient } from "../src/infra/cassandra_client.js";

interface GpsPing {
  driverId: string;
  lat: number;
  lng: number;
  timestamp: Date;
}

function generatePings(count: number, driverPoolSize: number = 500): GpsPing[] {
  const pings: GpsPing[] = new Array(count);
  const baseLat = 12.9716;
  const baseLng = 77.5946;
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const driverIdx = i % driverPoolSize;
    pings[i] = {
      driverId: `driver_${driverIdx.toString().padStart(4, "0")}`,
      lat: baseLat + (Math.random() - 0.5) * 0.1,
      lng: baseLng + (Math.random() - 0.5) * 0.1,
      timestamp: new Date(now - (count - i) * 100),
    };
  }
  return pings;
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(index, sortedArr.length - 1))];
}

async function runBenchmark() {
  console.log("==========================================================");
  console.log("🚀 INSTARIDE HIGH-THROUGHPUT SHOWDOWN: REDIS VS CASSANDRA");
  console.log("==========================================================\n");

  const TOTAL_PINGS = 50_000;
  console.log(`Generating ${TOTAL_PINGS.toLocaleString()} simulated GPS telemetry pings...`);
  const dataset = generatePings(TOTAL_PINGS);
  console.log("✓ Dataset ready.\n");

  // --- 1. REDIS BENCHMARK (Pipeline Mode) ---
  console.log("--- 1. Testing Redis (Pipelined HSET / Ephemeral Hot Path) ---");
  const redis = new Redis({ host: "127.0.0.1", port: 6379, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  const REDIS_BATCH_SIZE = 500;
  const redisLatencies: number[] = [];
  const redisStart = performance.now();

  for (let i = 0; i < TOTAL_PINGS; i += REDIS_BATCH_SIZE) {
    const batch = dataset.slice(i, i + REDIS_BATCH_SIZE);
    const chunkStart = performance.now();
    const pipeline = redis.pipeline();

    for (const ping of batch) {
      pipeline.hset(`driver:${ping.driverId}:loc`, {
        lat: ping.lat,
        lng: ping.lng,
        updatedAt: ping.timestamp.getTime(),
      });
    }

    await pipeline.exec();
    redisLatencies.push(performance.now() - chunkStart);
  }

  const redisDurationMs = performance.now() - redisStart;
  const redisThroughput = (TOTAL_PINGS / (redisDurationMs / 1000));
  redisLatencies.sort((a, b) => a - b);
  const redisP50 = percentile(redisLatencies, 50);
  const redisP95 = percentile(redisLatencies, 95);
  const redisP99 = percentile(redisLatencies, 99);

  console.log(`✓ Redis finished in ${redisDurationMs.toFixed(1)}ms (${Math.round(redisThroughput).toLocaleString()} pings/sec)\n`);
  await redis.quit();

  // --- 2. CASSANDRA SCHEMA & CONNECT ---
  console.log("--- 2. Initializing Apache Cassandra Schema ---");
  await initCassandraSchema();
  const cassandraClient = getCassandraClient({ keyspace: "instaride" });
  await cassandraClient.connect();
  console.log("✓ Connected to Cassandra cluster & verified schema.\n");

  // --- 3. CASSANDRA BENCHMARK (Concurrent Prepared Statements) ---
  console.log("--- 3. Testing Cassandra (Concurrent Prepared Statements) ---");
  const insertQuery = `
    INSERT INTO instaride.gps_bench (driver_id, ping_time, lat, lng)
    VALUES (?, ?, ?, ?)
  `;

  const cassandraLatencies: number[] = [];
  const cassandraStart = performance.now();

  // Concurrency windowing
  const CONCURRENCY = 256;
  let cursor = 0;

  async function worker() {
    while (cursor < TOTAL_PINGS) {
      const idx = cursor++;
      if (idx >= TOTAL_PINGS) break;
      const ping = dataset[idx];
      const qStart = performance.now();
      await cassandraClient.execute(
        insertQuery,
        [ping.driverId, ping.timestamp, ping.lat, ping.lng],
        { prepare: true }
      );
      cassandraLatencies.push(performance.now() - qStart);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const cassandraDurationMs = performance.now() - cassandraStart;
  const cassandraThroughput = (TOTAL_PINGS / (cassandraDurationMs / 1000));
  cassandraLatencies.sort((a, b) => a - b);
  const cassandraP50 = percentile(cassandraLatencies, 50);
  const cassandraP95 = percentile(cassandraLatencies, 95);
  const cassandraP99 = percentile(cassandraLatencies, 99);

  console.log(`✓ Cassandra Concurrent finished in ${cassandraDurationMs.toFixed(1)}ms (${Math.round(cassandraThroughput).toLocaleString()} pings/sec)\n`);

  // --- 4. CASSANDRA BENCHMARK (Unlogged Batches by Driver) ---
  console.log("--- 4. Testing Cassandra (Intra-Partition UNLOGGED BATCH) ---");
  const driverBatches = new Map<string, GpsPing[]>();
  for (const ping of dataset) {
    if (!driverBatches.has(ping.driverId)) {
      driverBatches.set(ping.driverId, []);
    }
    driverBatches.get(ping.driverId)!.push(ping);
  }

  const batchLatencies: number[] = [];
  const batchStart = performance.now();

  const BATCH_SIZE = 50;
  const batchQueries: Array<Array<{ query: string; params: any[] }>> = [];

  for (const [, pings] of driverBatches.entries()) {
    for (let i = 0; i < pings.length; i += BATCH_SIZE) {
      const chunk = pings.slice(i, i + BATCH_SIZE);
      batchQueries.push(
        chunk.map((p) => ({
          query: insertQuery,
          params: [p.driverId, p.timestamp, p.lat, p.lng],
        }))
      );
    }
  }

  let batchCursor = 0;
  async function batchWorker() {
    while (batchCursor < batchQueries.length) {
      const idx = batchCursor++;
      if (idx >= batchQueries.length) break;
      const bQueries = batchQueries[idx];
      const qStart = performance.now();
      await cassandraClient.batch(bQueries, { prepare: true, logged: false });
      batchLatencies.push(performance.now() - qStart);
    }
  }

  const batchWorkers = Array.from({ length: 64 }, () => batchWorker());
  await Promise.all(batchWorkers);

  const batchDurationMs = performance.now() - batchStart;
  const batchThroughput = (TOTAL_PINGS / (batchDurationMs / 1000));
  batchLatencies.sort((a, b) => a - b);
  const batchP50 = percentile(batchLatencies, 50);
  const batchP95 = percentile(batchLatencies, 95);
  const batchP99 = percentile(batchLatencies, 99);

  console.log(`✓ Cassandra UNLOGGED BATCH finished in ${batchDurationMs.toFixed(1)}ms (${Math.round(batchThroughput).toLocaleString()} pings/sec)\n`);

  await cassandraClient.shutdown();

  // --- 5. RESULTS SUMMARY TABLE ---
  console.log("==========================================================");
  console.log("📊 WRITE SHOWDOWN SCOREBOARD");
  console.log("==========================================================");

  console.table([
    {
      Engine: "Redis (Pipeline 500)",
      Total_Writes: TOTAL_PINGS,
      Duration: `${redisDurationMs.toFixed(1)} ms`,
      Throughput: `${Math.round(redisThroughput).toLocaleString()} ops/sec`,
      "p50 Latency": `${redisP50.toFixed(2)} ms`,
      "p95 Latency": `${redisP95.toFixed(2)} ms`,
      "p99 Latency": `${redisP99.toFixed(2)} ms`,
      Storage_Tier: "RAM (Hot State)",
    },
    {
      Engine: "Cassandra (Prepared Concurrent)",
      Total_Writes: TOTAL_PINGS,
      Duration: `${cassandraDurationMs.toFixed(1)} ms`,
      Throughput: `${Math.round(cassandraThroughput).toLocaleString()} ops/sec`,
      "p50 Latency": `${cassandraP50.toFixed(2)} ms`,
      "p95 Latency": `${cassandraP95.toFixed(2)} ms`,
      "p99 Latency": `${cassandraP99.toFixed(2)} ms`,
      Storage_Tier: "Disk / Append-Only LSM",
    },
    {
      Engine: "Cassandra (UNLOGGED BATCH 50)",
      Total_Writes: TOTAL_PINGS,
      Duration: `${batchDurationMs.toFixed(1)} ms`,
      Throughput: `${Math.round(batchThroughput).toLocaleString()} ops/sec`,
      "p50 Latency": `${batchP50.toFixed(2)} ms`,
      "p95 Latency": `${batchP95.toFixed(2)} ms`,
      "p99 Latency": `${batchP99.toFixed(2)} ms`,
      Storage_Tier: "Disk / Append-Only LSM",
    },
  ]);

  console.log("\n💡 Architectural Takeaway:");
  console.log("  • Redis is sub-millisecond in-memory, perfect for immediate driver lock & geospatial search.");
  console.log("  • Cassandra absorbs massive write streams directly to commit log + SSTables without blocking,");
  console.log("    making it the ideal persistent cold-storage flight recorder for millions of GPS breadcrumbs.");
  console.log("==========================================================\n");
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});

