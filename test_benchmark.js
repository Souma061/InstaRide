import pkg from "./spatial_hash_grid.js";
const { SpatialHashGrid, haversineDistance } = pkg;

const SF_BOUNDS = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

console.log("=====================================================");
console.log("   SPATIAL HASH GRID: BENCHMARK & CORRECTNESS TEST   ");
console.log("=====================================================\n");

const NUM_DRIVERS = 5000;
const grid = new SpatialHashGrid(SF_BOUNDS, 500);
const drivers = [];

console.log(
  `[1] Seeding ${NUM_DRIVERS} simulated drivers into San Francisco bounds...`,
);
const tSeedStart = performance.now();
for (let i = 0; i < NUM_DRIVERS; i++) {
  const id = `driver_${i}`;
  const lat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const lng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);
  drivers.push({ id, lat, lng });
  grid.insert(id, lat, lng);
}
const tSeedEnd = performance.now();
console.log(
  `    Seeding completed in ${(tSeedEnd - tSeedStart).toFixed(2)}ms (${(((tSeedEnd - tSeedStart) / NUM_DRIVERS) * 1000).toFixed(2)} µs/insert)\n`,
);

// 1. Correctness Test
console.log(
  "[2] Running Accuracy Verification (500 queries vs Brute-Force Haversine)...",
);
let discrepancies = 0;
let duplicateCount = 0;
const TEST_QUERIES = 500;
const k = 4;

for (let q = 0; q < TEST_QUERIES; q++) {
  const qLat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const qLng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);

  const allDists = drivers.map((d) => ({
    id: d.id,
    distance: haversineDistance(qLat, qLng, d.lat, d.lng),
  }));
  allDists.sort((a, b) => a.distance - b.distance);
  const expectedK = allDists.slice(0, k);

  const actualK = grid.kNearestNeighbors(qLat, qLng, k, 15000);

  const ids = actualK.map((x) => x.id);
  if (new Set(ids).size !== ids.length) {
    duplicateCount++;
  }

  for (let i = 0; i < k; i++) {
    if (
      !actualK[i] ||
      Math.abs(actualK[i].distance - expectedK[i].distance) > 0.5
    ) {
      discrepancies++;
      break;
    }
  }
}
console.log(`    Discrepancies: ${discrepancies} / ${TEST_QUERIES}`);
console.log(`    Duplicate IDs returned: ${duplicateCount}`);
console.log(
  `    Accuracy: ${(((TEST_QUERIES - discrepancies) / TEST_QUERIES) * 100).toFixed(1)}%\n`,
);

// 2. Telemetry Updates Benchmark
console.log("[3] Benchmarking Real-Time Telemetry Updates (50,000 updates)...");
const UPDATE_COUNT = 50000;
const startUpdate = performance.now();
for (let i = 0; i < UPDATE_COUNT; i++) {
  const d = drivers[i % NUM_DRIVERS];
  d.lat = Math.max(
    SF_BOUNDS.minLat,
    Math.min(SF_BOUNDS.maxLat, d.lat + (Math.random() - 0.5) * 0.0002),
  );
  d.lng = Math.max(
    SF_BOUNDS.minLng,
    Math.min(SF_BOUNDS.maxLng, d.lng + (Math.random() - 0.5) * 0.0002),
  );
  grid.update(d.id, d.lat, d.lng);
}
const endUpdate = performance.now();
const updateDurationMs = endUpdate - startUpdate;
console.log(`    Duration: ${updateDurationMs.toFixed(2)}ms`);
console.log(
  `    Mean Latency: ${((updateDurationMs / UPDATE_COUNT) * 1000).toFixed(2)} µs per update`,
);
console.log(
  `    Throughput: ${(UPDATE_COUNT / (updateDurationMs / 1000)).toLocaleString("en-US", { maximumFractionDigits: 0 })} updates/second\n`,
);

// 3. k-NN Search Benchmark
console.log("[4] Benchmarking k-NN Matching Queries (5,000 queries, k=4)...");
const QUERY_COUNT = 5000;
const latencies = [];
const startQuery = performance.now();
for (let i = 0; i < QUERY_COUNT; i++) {
  const qLat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const qLng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);
  const t0 = performance.now();
  grid.kNearestNeighbors(qLat, qLng, 4, 10000);
  const t1 = performance.now();
  latencies.push(t1 - t0);
}
const endQuery = performance.now();
const queryDurationMs = endQuery - startQuery;

latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(QUERY_COUNT * 0.5)];
const p95 = latencies[Math.floor(QUERY_COUNT * 0.95)];
const p99 = latencies[Math.floor(QUERY_COUNT * 0.99)];
const max = latencies[QUERY_COUNT - 1];

console.log(`    Duration: ${queryDurationMs.toFixed(2)}ms`);
console.log(`    p50 Latency: ${(p50 * 1000).toFixed(1)} µs`);
console.log(`    p95 Latency: ${(p95 * 1000).toFixed(1)} µs`);
console.log(`    p99 Latency: ${(p99 * 1000).toFixed(1)} µs`);
console.log(`    Max Latency: ${(max * 1000).toFixed(1)} µs`);
console.log(
  `    Throughput: ${(QUERY_COUNT / (queryDurationMs / 1000)).toLocaleString("en-US", { maximumFractionDigits: 0 })} queries/second\n`,
);
console.log("=====================================================");
