import cassandra from "cassandra-driver";
import { getCassandraClient, initCassandraSchema } from "../src/infra/cassandra_client.js";

const { consistencies } = cassandra.types;

interface GpsPing {
  driverId: string;
  lat: number;
  lng: number;
  timestamp: Date;
}

function generatePings(count: number, driverPoolSize: number = 200): GpsPing[] {
  const pings: GpsPing[] = new Array(count);
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const dId = `driver_${(i % driverPoolSize).toString().padStart(4, "0")}`;
    pings[i] = {
      driverId: dId,
      lat: 12.9716 + (Math.random() - 0.5) * 0.1,
      lng: 77.5946 + (Math.random() - 0.5) * 0.1,
      timestamp: new Date(now - i * 10),
    };
  }
  return pings;
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(index, sortedArr.length - 1))];
}

async function runExperiment3() {
  console.log("==========================================================");
  console.log("🪳 EXPERIMENT 3: CASSANDRA DEEP DIVE — BATCHING & CONSISTENCY");
  console.log("==========================================================\n");

  await initCassandraSchema();
  const client = getCassandraClient({ keyspace: "instaride" });
  await client.connect();

  const TOTAL_WRITES = 30_000;
  console.log(`Generating ${TOTAL_WRITES.toLocaleString()} synthetic GPS records...`);
  const dataset = generatePings(TOTAL_WRITES);
  console.log("✓ Dataset ready.\n");

  const insertQuery = `
    INSERT INTO instaride.gps_bench (driver_id, ping_time, lat, lng)
    VALUES (?, ?, ?, ?)
  `;

  const results: Array<{
    Pattern: string;
    Consistency: string;
    Duration: string;
    Throughput: string;
    p50: string;
    p95: string;
    p99: string;
    Cassandra_Insight: string;
  }> = [];

  // -------------------------------------------------------------
  // Test A: Concurrent Individual Prepared Writes (Consistency = ONE)
  // -------------------------------------------------------------
  console.log("--- Test A: Concurrent Individual Prepared Writes (ONE) ---");
  {
    const latencies: number[] = [];
    const t0 = performance.now();
    let cursor = 0;
    const CONCURRENCY = 256;

    async function worker() {
      while (cursor < TOTAL_WRITES) {
        const i = cursor++;
        if (i >= TOTAL_WRITES) break;
        const p = dataset[i];
        const q0 = performance.now();
        await client.execute(
          insertQuery,
          [p.driverId, p.timestamp, p.lat, p.lng],
          { prepare: true, consistency: consistencies.one }
        );
        latencies.push(performance.now() - q0);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    const duration = performance.now() - t0;
    latencies.sort((a, b) => a - b);
    const opsSec = Math.round(TOTAL_WRITES / (duration / 1000));

    results.push({
      Pattern: "Individual Concurrent (256 in flight)",
      Consistency: "ONE",
      Duration: `${duration.toFixed(1)} ms`,
      Throughput: `${opsSec.toLocaleString()} ops/s`,
      p50: `${percentile(latencies, 50).toFixed(2)} ms`,
      p95: `${percentile(latencies, 95).toFixed(2)} ms`,
      p99: `${percentile(latencies, 99).toFixed(2)} ms`,
      Cassandra_Insight: "Optimal async pipelining across token ring",
    });
    console.log(`✓ Completed: ${opsSec.toLocaleString()} ops/sec\n`);
  }

  // -------------------------------------------------------------
  // Test B: Concurrent Individual Prepared Writes (Consistency = QUORUM)
  // -------------------------------------------------------------
  console.log("--- Test B: Concurrent Individual Prepared Writes (QUORUM) ---");
  {
    const latencies: number[] = [];
    const t0 = performance.now();
    let cursor = 0;
    const CONCURRENCY = 256;

    async function worker() {
      while (cursor < TOTAL_WRITES) {
        const i = cursor++;
        if (i >= TOTAL_WRITES) break;
        const p = dataset[i];
        const q0 = performance.now();
        await client.execute(
          insertQuery,
          [p.driverId, p.timestamp, p.lat, p.lng],
          { prepare: true, consistency: consistencies.quorum }
        );
        latencies.push(performance.now() - q0);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    const duration = performance.now() - t0;
    latencies.sort((a, b) => a - b);
    const opsSec = Math.round(TOTAL_WRITES / (duration / 1000));

    results.push({
      Pattern: "Individual Concurrent (256 in flight)",
      Consistency: "QUORUM",
      Duration: `${duration.toFixed(1)} ms`,
      Throughput: `${opsSec.toLocaleString()} ops/s`,
      p50: `${percentile(latencies, 50).toFixed(2)} ms`,
      p95: `${percentile(latencies, 95).toFixed(2)} ms`,
      p99: `${percentile(latencies, 99).toFixed(2)} ms`,
      Cassandra_Insight: "Strict majority consensus (no penalty on 1-node)",
    });
    console.log(`✓ Completed: ${opsSec.toLocaleString()} ops/sec\n`);
  }

  // -------------------------------------------------------------
  // Test C: Intra-Partition UNLOGGED BATCH (Best Practice: 50 per batch)
  // -------------------------------------------------------------
  console.log("--- Test C: Intra-Partition UNLOGGED BATCH (Same Driver Partition) ---");
  {
    // Group records by driver_id (single partition key)
    const grouped = new Map<string, GpsPing[]>();
    for (const p of dataset) {
      if (!grouped.has(p.driverId)) grouped.set(p.driverId, []);
      grouped.get(p.driverId)!.push(p);
    }

    const batches: Array<Array<{ query: string; params: any[] }>> = [];
    const BATCH_SIZE = 50;
    for (const [, pings] of grouped.entries()) {
      for (let i = 0; i < pings.length; i += BATCH_SIZE) {
        const slice = pings.slice(i, i + BATCH_SIZE);
        batches.push(
          slice.map((p) => ({
            query: insertQuery,
            params: [p.driverId, p.timestamp, p.lat, p.lng],
          }))
        );
      }
    }

    const latencies: number[] = [];
    const t0 = performance.now();
    let bCursor = 0;

    async function batchWorker() {
      while (bCursor < batches.length) {
        const idx = bCursor++;
        if (idx >= batches.length) break;
        const b = batches[idx];
        const q0 = performance.now();
        await client.batch(b, { prepare: true, logged: false });
        latencies.push(performance.now() - q0);
      }
    }

    await Promise.all(Array.from({ length: 64 }, () => batchWorker()));
    const duration = performance.now() - t0;
    latencies.sort((a, b) => a - b);
    const opsSec = Math.round(TOTAL_WRITES / (duration / 1000));

    results.push({
      Pattern: "Intra-Partition UNLOGGED (50 / batch)",
      Consistency: "ONE (default)",
      Duration: `${duration.toFixed(1)} ms`,
      Throughput: `${opsSec.toLocaleString()} ops/s`,
      p50: `${percentile(latencies, 50).toFixed(2)} ms`,
      p95: `${percentile(latencies, 95).toFixed(2)} ms`,
      p99: `${percentile(latencies, 99).toFixed(2)} ms`,
      Cassandra_Insight: "Atomic SSTable memtable write with ZERO coordinator fanout",
    });
    console.log(`✓ Completed: ${opsSec.toLocaleString()} ops/sec\n`);
  }

  // -------------------------------------------------------------
  // Test D: Inter-Partition UNLOGGED BATCH (Anti-Pattern: Cross Driver Partition)
  // -------------------------------------------------------------
  console.log("--- Test D: Inter-Partition UNLOGGED BATCH (Cross Driver Partitions) ---");
  {
    // Create batches slicing arbitrary drivers (spanning many partition keys)
    const batches: Array<Array<{ query: string; params: any[] }>> = [];
    const BATCH_SIZE = 50;
    for (let i = 0; i < dataset.length; i += BATCH_SIZE) {
      const slice = dataset.slice(i, i + BATCH_SIZE);
      batches.push(
        slice.map((p) => ({
          query: insertQuery,
          params: [p.driverId, p.timestamp, p.lat, p.lng],
        }))
      );
    }

    const latencies: number[] = [];
    const t0 = performance.now();
    let bCursor = 0;

    async function batchWorker() {
      while (bCursor < batches.length) {
        const idx = bCursor++;
        if (idx >= batches.length) break;
        const b = batches[idx];
        const q0 = performance.now();
        await client.batch(b, { prepare: true, logged: false });
        latencies.push(performance.now() - q0);
      }
    }

    await Promise.all(Array.from({ length: 64 }, () => batchWorker()));
    const duration = performance.now() - t0;
    latencies.sort((a, b) => a - b);
    const opsSec = Math.round(TOTAL_WRITES / (duration / 1000));

    results.push({
      Pattern: "Cross-Partition UNLOGGED (50 / batch)",
      Consistency: "ONE (default)",
      Duration: `${duration.toFixed(1)} ms`,
      Throughput: `${opsSec.toLocaleString()} ops/s`,
      p50: `${percentile(latencies, 50).toFixed(2)} ms`,
      p95: `${percentile(latencies, 95).toFixed(2)} ms`,
      p99: `${percentile(latencies, 99).toFixed(2)} ms`,
      Cassandra_Insight: "Anti-pattern: Coordinator must unpack & route across token ranges",
    });
    console.log(`✓ Completed: ${opsSec.toLocaleString()} ops/sec\n`);
  }

  // -------------------------------------------------------------
  // Display Results
  // -------------------------------------------------------------
  console.log("==========================================================");
  console.log("📊 CASSANDRA PATTERN SHOWDOWN SCOREBOARD");
  console.log("==========================================================");
  console.table(results);

  console.log("\n🎓 Key Architectural Takeaways for InstaRide:");
  console.log("  1. Intra-Partition UNLOGGED batches are the fastest ingestion mechanism");
  console.log("     because all mutations hit the exact same partition key on disk/memtable.");
  console.log("  2. Cross-Partition batches force the coordinator node to unpack queries and");
  console.log("     delegate across multiple nodes/tokens, introducing coordinator overhead.");
  console.log("  3. Async Prepared Statements with client concurrency offer consistent low p50");
  console.log("     latency when real-time single-item streaming is preferred over micro-batching.");
  console.log("==========================================================\n");

  await client.shutdown();
}

runExperiment3().catch((err) => {
  console.error("Experiment 3 failed:", err);
  process.exit(1);
});
