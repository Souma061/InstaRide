import { redis, connectRedis, disconnectRedis } from "../src/infra/redis_client.js";
import { RedisDriverLock } from "../src/core/redis_driver_lock.js";
import { performance } from "node:perf_hooks";

async function runMassiveRedisBenchmark() {
  console.log("=====================================================");
  console.log("      MASSIVE REDIS LOAD & THROUGHPUT BENCHMARK      ");
  console.log("=====================================================\n");

  await connectRedis();
  const lock = new RedisDriverLock();

  // Check initial Redis memory
  const infoBefore = await redis.info("memory");
  const memBeforeMatch = infoBefore.match(/used_memory_human:(.*)/);
  const memBefore = memBeforeMatch ? memBeforeMatch[1].trim() : "unknown";
  console.log(`[Setup] Redis Initial Memory: ${memBefore}`);

  const TOTAL_OPERATIONS = 250_000;
  const BATCH_SIZE = 2_000; // 2,000 concurrent in-flight socket requests
  console.log(`>>> Starting load test: ${TOTAL_OPERATIONS.toLocaleString()} mixed lock + Lua commit operations...`);
  console.log(`>>> Concurrency window: ${BATCH_SIZE.toLocaleString()} concurrent in-flight promises\n`);

  const latencies: number[] = [];
  const t0 = performance.now();

  for (let i = 0; i < TOTAL_OPERATIONS; i += BATCH_SIZE) {
    const batch = Array.from({ length: BATCH_SIZE }, async (_, idx) => {
      const id = i + idx;
      const start = performance.now();

      // 1. Acquire 15s lock for driver_{id}
      await lock.acquireLock(`driver_bench_${id}`, `req_bench_${id}`, 15000);

      // 2. Atomically commit the trip via Lua script
      await lock.commitTrip(`driver_bench_${id}`, `req_bench_${id}`);

      const elapsed = performance.now() - start;
      latencies.push(elapsed);
    });

    await Promise.all(batch);

    if ((i + BATCH_SIZE) % 50000 === 0) {
      console.log(`  -> Processed ${(i + BATCH_SIZE).toLocaleString()} / ${TOTAL_OPERATIONS.toLocaleString()} ops...`);
    }
  }

  const totalDurationMs = performance.now() - t0;
  const totalSec = totalDurationMs / 1000;
  const rps = TOTAL_OPERATIONS / totalSec;

  // Latency percentiles
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  // Check Redis memory after
  const infoAfter = await redis.info("memory");
  const memAfterMatch = infoAfter.match(/used_memory_human:(.*)/);
  const memAfter = memAfterMatch ? memAfterMatch[1].trim() : "unknown";

  console.log("\n-----------------------------------------------------");
  console.log(">>> BENCHMARK RESULTS:");
  console.log("-----------------------------------------------------");
  console.log(`  Total Operations  : ${TOTAL_OPERATIONS.toLocaleString()}`);
  console.log(`  Time Elapsed      : ${totalSec.toFixed(2)} seconds`);
  console.log(`  Throughput        : ${Math.round(rps).toLocaleString()} ops/sec`);
  console.log(`  p50 Latency       : ${p50.toFixed(2)} ms`);
  console.log(`  p95 Latency       : ${p95.toFixed(2)} ms`);
  console.log(`  p99 Latency       : ${p99.toFixed(2)} ms`);
  console.log(`  Redis RAM Before  : ${memBefore}`);
  console.log(`  Redis RAM After   : ${memAfter}`);
  console.log("=====================================================\n");

  await disconnectRedis();
}

runMassiveRedisBenchmark().catch((err) => {
  console.error("Benchmark error:", err);
  disconnectRedis();
});
