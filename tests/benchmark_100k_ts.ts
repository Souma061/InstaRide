import { QuadTree, GeoBounds } from "../src/spatial/quadtree.js";

function runTypeScriptBenchmark() {
  console.log("========================================================");
  console.log("  InstaRide TypeScript Engine - 100,000 Driver Benchmark ");
  console.log("========================================================\n");

  const cityBounds: GeoBounds = {
    minLat: 28.4,
    maxLat: 28.9,
    minLng: 76.8,
    maxLng: 77.5,
  };

  const tree = new QuadTree(cityBounds, 8, 12);
  const NUM_DRIVERS = 100000;
  const NUM_QUERIES = 10000;
  const K = 5;

  // 1. Insertion Benchmark
  console.log(`[1/3] Inserting ${NUM_DRIVERS} drivers into PR-QuadTree...`);
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
  console.log(
    `  -> Inserted ${NUM_DRIVERS} drivers in: ${insertMs.toFixed(2)} ms`,
  );
  console.log(
    `  -> Throughput: ${(NUM_DRIVERS / (insertMs / 1000)).toFixed(2)} inserts/sec\n`,
  );

  // 2. Telemetry Updates
  console.log(`[2/3] Simulating 10,000 GPS telemetry updates...`);
  const t2 = performance.now();
  for (let i = 0; i < 10000; i++) {
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
  console.log(`  -> 10,000 updates in: ${updateMs.toFixed(2)} ms`);
  console.log(
    `  -> Throughput: ${(10000 / (updateMs / 1000)).toFixed(2)} updates/sec\n`,
  );

  // 3. k-NN Search
  console.log(`[3/3] Running ${NUM_QUERIES} k-NN queries (k=${K})...`);
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
    `  -> ${NUM_QUERIES} queries executed in: ${queryMs.toFixed(2)} ms`,
  );
  console.log(
    `  -> Average Latency: ${((queryMs * 1000) / NUM_QUERIES).toFixed(2)} microseconds (us) per query`,
  );
  console.log(
    `  -> Query Throughput: ${(NUM_QUERIES / (queryMs / 1000)).toFixed(2)} queries/sec`,
  );
  console.log(`  -> Total candidate matches found: ${totalFound}\n`);

  console.log("========================================================");
  console.log("                   BENCHMARK COMPLETE                   ");
  console.log("========================================================");
}

runTypeScriptBenchmark();
