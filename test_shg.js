import pkg from './spatial_hash_grid.js';
const { SpatialHashGrid, haversineDistance } = pkg;

const SF_BOUNDS = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

// 1. Correctness Test: Compare against Brute Force
console.log('=== TEST 1: Correctness vs Brute Force ===');
const grid = new SpatialHashGrid(SF_BOUNDS, 500);

const NUM_DRIVERS = 5000;
const drivers = [];

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

for (let i = 0; i < NUM_DRIVERS; i++) {
  const id = `driver_${i}`;
  const lat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const lng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);
  drivers.push({ id, lat, lng });
  grid.insert(id, lat, lng);
}

let discrepancies = 0;
let duplicatesCount = 0;
const TEST_QUERIES = 200;
const k = 4;

for (let q = 0; q < TEST_QUERIES; q++) {
  const qLat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const qLng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);

  // Brute force calculation
  const allDists = drivers.map(d => ({
    id: d.id,
    lat: d.lat,
    lng: d.lng,
    distance: haversineDistance(qLat, qLng, d.lat, d.lng)
  }));
  allDists.sort((a, b) => a.distance - b.distance);
  const expectedK = allDists.slice(0, k);

  const actualK = grid.kNearestNeighbors(qLat, qLng, k, 15000);

  // Check for duplicates
  const ids = actualK.map(x => x.id);
  const uniqueIds = new Set(ids);
  if (ids.length !== uniqueIds.size) {
    duplicatesCount++;
  }

  // Compare distances
  let match = true;
  if (actualK.length !== expectedK.length) {
    match = false;
  } else {
    for (let i = 0; i < k; i++) {
      // allow tiny floating point difference
      if (Math.abs(actualK[i].distance - expectedK[i].distance) > 1.0) {
        match = false;
        break;
      }
    }
  }

  if (!match) {
    discrepancies++;
    if (discrepancies <= 3) {
      console.log(`Discrepancy at query (${qLat.toFixed(4)}, ${qLng.toFixed(4)}):`);
      console.log('Expected:', expectedK.map(x => `${x.id}:${x.distance.toFixed(1)}m`));
      console.log('Actual:  ', actualK.map(x => `${x.id}:${x.distance.toFixed(1)}m`));
    }
  }
}

console.log(`Discrepancies in ${TEST_QUERIES} queries: ${discrepancies}`);
console.log(`Duplicate IDs returned: ${duplicatesCount}`);

// 2. Benchmark Performance
console.log('\n=== TEST 2: Performance Benchmark (5,000 Drivers) ===');

// Telemetry Updates
const UPDATE_COUNT = 50000;
const startUpdate = performance.now();
for (let i = 0; i < UPDATE_COUNT; i++) {
  const driverIdx = i % NUM_DRIVERS;
  const d = drivers[driverIdx];
  // simulate small movement (+/- 10 meters ~ 0.0001 deg)
  d.lat += (Math.random() - 0.5) * 0.0002;
  d.lng += (Math.random() - 0.5) * 0.0002;
  // clamp to bounds
  d.lat = Math.max(SF_BOUNDS.minLat, Math.min(SF_BOUNDS.maxLat, d.lat));
  d.lng = Math.max(SF_BOUNDS.minLng, Math.min(SF_BOUNDS.maxLng, d.lng));
  grid.update(d.id, d.lat, d.lng);
}
const endUpdate = performance.now();
const updateDurationMs = endUpdate - startUpdate;
console.log(`${UPDATE_COUNT} updates took: ${updateDurationMs.toFixed(2)}ms (${(updateDurationMs / UPDATE_COUNT * 1000).toFixed(2)} µs/update)`);
console.log(`Throughput: ${(UPDATE_COUNT / (updateDurationMs / 1000)).toFixed(0)} updates/sec`);

// k-NN Queries
const QUERY_COUNT = 5000;
const queryLatencies = [];
const startQuery = performance.now();
for (let i = 0; i < QUERY_COUNT; i++) {
  const qLat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
  const qLng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);
  const t0 = performance.now();
  grid.kNearestNeighbors(qLat, qLng, 4, 10000);
  const t1 = performance.now();
  queryLatencies.push(t1 - t0);
}
const endQuery = performance.now();
const queryDurationMs = endQuery - startQuery;

queryLatencies.sort((a, b) => a - b);
const p50 = queryLatencies[Math.floor(QUERY_COUNT * 0.5)];
const p95 = queryLatencies[Math.floor(QUERY_COUNT * 0.95)];
const p99 = queryLatencies[Math.floor(QUERY_COUNT * 0.99)];
const max = queryLatencies[QUERY_COUNT - 1];

console.log(`${QUERY_COUNT} k-NN queries (k=4) took: ${queryDurationMs.toFixed(2)}ms`);
console.log(`Latency p50: ${(p50 * 1000).toFixed(1)} µs, p95: ${(p95 * 1000).toFixed(1)} µs, p99: ${(p99 * 1000).toFixed(1)} µs, max: ${(max * 1000).toFixed(1)} µs`);
console.log(`Throughput: ${(QUERY_COUNT / (queryDurationMs / 1000)).toFixed(0)} queries/sec`);

