import { QuadTree, haversineDistance } from "../src/spatial/quadtree.js";

const SF_BOUNDS = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

console.log("=====================================================");
console.log("   POINT-REGION QUADTREE: BENCHMARK & TEST SUITE     ");
console.log("=====================================================\n");

const NUM_DRIVERS = 5000;
const tree = new QuadTree(SF_BOUNDS, 8, 7);
const drivers: { id: string; lat: number; lng: number }[] = [];

console.log(`[1] Seeding ${NUM_DRIVERS} drivers into San Francisco bounds...`);
const t0 = performance.now();
for (let i = 0; i < NUM_DRIVERS; i++) {
  const id = `driver_${i}`;
  const lat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const lng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);
  drivers.push({ id, lat, lng });
  tree.insert(id, lat, lng);
}
const t1 = performance.now();
console.log(
  `    Seeding complete in ${(t1 - t0).toFixed(2)}ms (size: ${tree.size()})\n`,
);

// 1. Cluster Test (Airport taxi stand simulation)
console.log("[2] Testing Dense Cluster (200 drivers in 50m box)...");
for (let i = 0; i < 200; i++) {
  // SFO airport taxi stand approx
  const lat = 37.71 + (Math.random() - 0.5) * 0.0004;
  const lng = -122.4 + (Math.random() - 0.5) * 0.0004;
  const cId = `cluster_driver_${i}`;
  drivers.push({ id: cId, lat, lng });
  tree.insert(cId, lat, lng);
}
console.log(`    Cluster inserted successfully without exceeding maxDepth.\n`);

// 2. Accuracy Verification vs Brute Force
console.log("[3] Verifying Accuracy (500 queries vs Brute-Force Haversine)...");
let discrepancies = 0;
let duplicates = 0;
const TEST_QUERIES = 500;
const k = 4;

for (let q = 0; q < TEST_QUERIES; q++) {
  const qLat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const qLng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);

  // Brute force
  const all = drivers.map((d) => ({
    id: d.id,
    distance: haversineDistance(qLat, qLng, d.lat, d.lng),
  }));
  all.sort((a, b) => a.distance - b.distance);
  const expected = all.slice(0, k);

  const actual = tree.kNearestNeighbors(qLat, qLng, k, 15000);

  const ids = actual.map((x) => x.id);
  if (new Set(ids).size !== actual.length) {
    duplicates++;
  }

  for (let i = 0; i < k; i++) {
    if (
      !actual[i] ||
      Math.abs(actual[i].distance - expected[i].distance) > 0.5
    ) {
      discrepancies++;
      break;
    }
  }
}
console.log(`    Queries checked: ${TEST_QUERIES}`);
console.log(`    Discrepancies: ${discrepancies}`);
console.log(`    Duplicate IDs: ${duplicates}`);
console.log(
  `    Accuracy: ${(((TEST_QUERIES - discrepancies) / TEST_QUERIES) * 100).toFixed(1)}%\n`,
);

// 3. Telemetry Updates Benchmark
console.log("[4] Benchmarking Telemetry Updates (50,000 updates)...");
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
  tree.update(d.id, d.lat, d.lng);
}
const endUpdate = performance.now();
const updateDurationMs = endUpdate - startUpdate;
console.log(`    Duration: ${updateDurationMs.toFixed(2)}ms`);
console.log(
  `    Mean Latency: ${((updateDurationMs / UPDATE_COUNT) * 1000).toFixed(2)} µs/update`,
);
console.log(
  `    Throughput: ${(UPDATE_COUNT / (updateDurationMs / 1000)).toLocaleString("en-US", { maximumFractionDigits: 0 })} updates/sec\n`,
);

// 4. k-NN Search Benchmark
console.log("[5] Benchmarking k-NN Matching Queries (5,000 queries, k=4)...");
const QUERY_COUNT = 5000;
const latencies: number[] = [];
const startQuery = performance.now();
for (let i = 0; i < QUERY_COUNT; i++) {
  const qLat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const qLng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);
  const tStart = performance.now();
  tree.kNearestNeighbors(qLat, qLng, 4, 10000);
  const tEnd = performance.now();
  latencies.push(tEnd - tStart);
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
  `    Throughput: ${(QUERY_COUNT / (queryDurationMs / 1000)).toLocaleString("en-US", { maximumFractionDigits: 0 })} queries/sec\n`,
);
console.log("=====================================================");
