import { GeoBounds, QuadTree } from "../src/spatial/quadtree.js";

function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / (1024 * 1024));
}

function runTypeScript1MBenchmark() {
  console.log("========================================================");
  console.log("  InstaRide TypeScript Engine - 1,000,000 (1M) Benchmark ");
  console.log("========================================================\n");

  const cityBounds: GeoBounds = {
    minLat: 28.4,
    maxLat: 28.9,
    minLng: 76.8,
    maxLng: 77.5,
  };

  // capacity 8, maxDepth 14
  const tree = new QuadTree(cityBounds, 8, 14);
  const NUM_DRIVERS = 1000000;
  const NUM_QUERIES = 20000;
  const K = 5;

  const memBefore = getMemoryUsageMB();

  // 1. Insertion Benchmark
  console.log(`[1/3] Inserting 1,000,000 (1 Million) drivers into QuadTree...`);
  const t0 = performance.now();
  for (let i = 0; i < NUM_DRIVERS; i++) {
    const lat =
      cityBounds.minLat +
      Math.random() * (cityBounds.maxLat - cityBounds.minLat);
    const lng =
      cityBounds.minLng +
      Math.random() * (cityBounds.maxLng - cityBounds.minLng);
    tree.insert(`driver_${i}`, lat, lng);
  }
  const t1 = performance.now();
  const insertMs = t1 - t0;
  const memAfter = getMemoryUsageMB();

  console.log(
    `  -> 1,000,000 drivers inserted in: ${insertMs.toFixed(2)} ms (${(insertMs / 1000).toFixed(2)} seconds)`,
  );
  console.log(
    `  -> Insertion Throughput: ${(NUM_DRIVERS / (insertMs / 1000)).toFixed(2)} inserts/sec`,
  );
  console.log(
    `  -> V8 Heap Memory for 1M entities: ~${memAfter - memBefore} MB (Total Heap: ${memAfter} MB)\n`,
  );

  // 2. Telemetry Updates
  const NUM_UPDATES = 50000;
  console.log(
    `[2/3] Simulating ${NUM_UPDATES} GPS telemetry updates in 1M fleet...`,
  );
  const t2 = performance.now();
  for (let i = 0; i < NUM_UPDATES; i++) {
    const lat =
      cityBounds.minLat +
      Math.random() * (cityBounds.maxLat - cityBounds.minLat);
    const lng =
      cityBounds.minLng +
      Math.random() * (cityBounds.maxLng - cityBounds.minLng);
    tree.update(`driver_${i}`, lat, lng);
  }
  const t3 = performance.now();
  const updateMs = t3 - t2;
  console.log(
    `  -> ${NUM_UPDATES} updates completed in: ${updateMs.toFixed(2)} ms`,
  );
  console.log(
    `  -> Update Throughput: ${(NUM_UPDATES / (updateMs / 1000)).toFixed(2)} updates/sec\n`,
  );

  // 3. k-NN Search
  console.log(
    `[3/3] Running ${NUM_QUERIES} spatial searches (k=${K}) on 1M drivers...`,
  );
  const t4 = performance.now();
  let totalFound = 0;
  for (let i = 0; i < NUM_QUERIES; i++) {
    const queryLat =
      cityBounds.minLat +
      Math.random() * (cityBounds.maxLat - cityBounds.minLat);
    const queryLng =
      cityBounds.minLng +
      Math.random() * (cityBounds.maxLng - cityBounds.minLng);
    const results = tree.kNearestNeighbors(queryLat, queryLng, K, 50000.0);
    totalFound += results.length;
  }
  const t5 = performance.now();
  const queryMs = t5 - t4;
  console.log(
    `  -> ${NUM_QUERIES} queries completed in: ${queryMs.toFixed(2)} ms`,
  );
  console.log(
    `  -> Average Latency per Query: ${((queryMs * 1000) / NUM_QUERIES).toFixed(2)} microseconds (us)`,
  );
  console.log(
    `  -> Query Throughput: ${(NUM_QUERIES / (queryMs / 1000)).toFixed(2)} queries/sec`,
  );
  console.log(`  -> Total candidate matches verified: ${totalFound}\n`);

  console.log("========================================================");
  console.log("            1,000,000 BENCHMARK COMPLETE                ");
  console.log("========================================================");
}

runTypeScript1MBenchmark();
