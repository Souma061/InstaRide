import pkg from "./spatial_hash_grid.js";

const { SpatialHashGrid, haversineDistance } = pkg;

const SF_BOUNDS = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

const WARMUP_QUERIES = 1000;

const TEST_QUERIES = 10000;

const K_VALUES = [1, 4, 10, 20];

const DRIVER_COUNTS = [1000, 5000, 10000, 25000, 50000, 100000];

const CELL_SIZES = [100, 250, 500, 1000, 2000];

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function randomDriver(i) {
  return {
    id: `driver_${i}`,

    lat: randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat),

    lng: randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng),
  };
}

function percentile(sortedValues, p) {
  return sortedValues[
    Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * p))
  ];
}

function formatUs(ms) {
  return `${(ms * 1000).toFixed(2)} µs`;
}

function createGridWithDrivers(driverCount, cellSize) {
  const grid = new SpatialHashGrid(SF_BOUNDS, cellSize);

  const drivers = new Array(driverCount);

  for (let i = 0; i < driverCount; i++) {
    const driver = randomDriver(i);

    drivers[i] = driver;

    grid.insert(driver.id, driver.lat, driver.lng);
  }

  return {
    grid,
    drivers,
  };
}

function bruteForceKNN(drivers, qLat, qLng, k) {
  return drivers
    .map((driver) => ({
      id: driver.id,

      distance: haversineDistance(qLat, qLng, driver.lat, driver.lng),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}

function sameNearestSet(actual, expected, toleranceMeters = 0.5) {
  if (actual.length !== expected.length) {
    return false;
  }

  const actualIds = new Set(actual.map((x) => x.id));

  const expectedIds = new Set(expected.map((x) => x.id));

  // Duplicate detection.
  if (actualIds.size !== actual.length) {
    return false;
  }

  // Same IDs.
  for (const id of expectedIds) {
    if (!actualIds.has(id)) {
      return false;
    }
  }

  // Same ordering/distances.
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(actual[i].distance - expected[i].distance) > toleranceMeters) {
      return false;
    }
  }

  return true;
}

function benchmarkQueries(grid, count, k, maxRadiusMeters = 15000) {
  // Warm up V8/JIT.
  for (let i = 0; i < WARMUP_QUERIES; i++) {
    grid.kNearestNeighbors(
      randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat),

      randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng),

      k,
      maxRadiusMeters,
    );
  }

  const latencies = new Array(count);

  const start = process.hrtime.bigint();

  for (let i = 0; i < count; i++) {
    const qLat = randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);

    const qLng = randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);

    const t0 = process.hrtime.bigint();

    grid.kNearestNeighbors(qLat, qLng, k, maxRadiusMeters);

    const t1 = process.hrtime.bigint();

    latencies[i] = Number(t1 - t0) / 1e6;
  }

  const end = process.hrtime.bigint();

  const durationMs = Number(end - start) / 1e6;

  latencies.sort((a, b) => a - b);

  return {
    durationMs,

    p50: percentile(latencies, 0.5),

    p95: percentile(latencies, 0.95),

    p99: percentile(latencies, 0.99),

    max: latencies[latencies.length - 1],

    throughput: count / (durationMs / 1000),
  };
}

console.log("=====================================================");

console.log("   SPATIAL HASH GRID: STRESS / CORRECTNESS SUITE    ");

console.log("=====================================================\n");

/*
========================================================
1. ADVERSARIAL CORRECTNESS
========================================================
*/

console.log("[1] Adversarial correctness test");

const { grid: correctnessGrid, drivers: correctnessDrivers } =
  createGridWithDrivers(5000, 500);

let discrepancies = 0;

let duplicates = 0;

const queryPoints = [];

// Random queries.
for (let i = 0; i < 8000; i++) {
  queryPoints.push({
    lat: randomInRange(SF_BOUNDS.minLat, SF_BOUNDS.maxLat),

    lng: randomInRange(SF_BOUNDS.minLng, SF_BOUNDS.maxLng),
  });
}

// Explicit boundary queries.
const boundaryEpsilon = 1e-8;

for (const lat of [
  SF_BOUNDS.minLat,
  SF_BOUNDS.maxLat,

  (SF_BOUNDS.minLat + SF_BOUNDS.maxLat) / 2,
]) {
  for (const lng of [
    SF_BOUNDS.minLng,
    SF_BOUNDS.maxLng,

    (SF_BOUNDS.minLng + SF_BOUNDS.maxLng) / 2,
  ]) {
    queryPoints.push({
      lat,
      lng,
    });

    queryPoints.push({
      lat: Math.min(SF_BOUNDS.maxLat, lat + boundaryEpsilon),

      lng: Math.min(SF_BOUNDS.maxLng, lng + boundaryEpsilon),
    });
  }
}

for (const k of K_VALUES) {
  for (const point of queryPoints) {
    const expected = bruteForceKNN(correctnessDrivers, point.lat, point.lng, k);

    const actual = correctnessGrid.kNearestNeighbors(
      point.lat,
      point.lng,
      k,
      15000,
    );

    const ids = actual.map((x) => x.id);

    if (new Set(ids).size !== ids.length) {
      duplicates++;
    }

    if (!sameNearestSet(actual, expected)) {
      discrepancies++;

      if (discrepancies <= 5) {
        console.log(
          `    First discrepancy: k=${k}, lat=${point.lat}, lng=${point.lng}`,
        );
      }
    }
  }
}

console.log(`    Queries checked: ${queryPoints.length * K_VALUES.length}`);

console.log(`    Discrepancies: ${discrepancies}`);

console.log(`    Duplicate IDs: ${duplicates}`);

console.log(`    Accuracy: ${discrepancies === 0 ? "100.0%" : "FAILED"}\n`);

/*
========================================================
2. SCALING BENCHMARK
========================================================
*/

console.log("[2] Scaling benchmark (k=4, 5,000 queries)");

console.log("\nDrivers       p50        p95        p99        max        QPS");

console.log(
  "------------------------------------------------------------------",
);

for (const driverCount of DRIVER_COUNTS) {
  const { grid } = createGridWithDrivers(driverCount, 500);

  const result = benchmarkQueries(grid, 5000, 4, 15000);

  console.log(
    `${String(driverCount).padEnd(13)}` +
      `${formatUs(result.p50).padEnd(11)}` +
      `${formatUs(result.p95).padEnd(11)}` +
      `${formatUs(result.p99).padEnd(11)}` +
      `${formatUs(result.max).padEnd(11)}` +
      `${Math.round(result.throughput).toLocaleString()}`,
  );
}

/*
========================================================
3. CELL SIZE BENCHMARK
========================================================
*/

console.log("\n[3] Cell-size benchmark (5,000 drivers, k=4)");

console.log("\nCell Size     p50        p95        p99        max        QPS");

console.log(
  "------------------------------------------------------------------",
);

for (const cellSize of CELL_SIZES) {
  const { grid } = createGridWithDrivers(5000, cellSize);

  const result = benchmarkQueries(grid, 5000, 4, 15000);

  console.log(
    `${String(`${cellSize}m`).padEnd(13)}` +
      `${formatUs(result.p50).padEnd(11)}` +
      `${formatUs(result.p95).padEnd(11)}` +
      `${formatUs(result.p99).padEnd(11)}` +
      `${formatUs(result.max).padEnd(11)}` +
      `${Math.round(result.throughput).toLocaleString()}`,
  );
}

/*
========================================================
4. TELEMETRY BENCHMARK
========================================================
*/

console.log("\n[4] Telemetry update benchmark");

const { grid: telemetryGrid, drivers: telemetryDrivers } =
  createGridWithDrivers(5000, 500);

const UPDATE_COUNT = 100000;

// Warmup.
for (let i = 0; i < 10000; i++) {
  const driver = telemetryDrivers[i % telemetryDrivers.length];

  telemetryGrid.update(driver.id, driver.lat, driver.lng);
}

const updateStart = process.hrtime.bigint();

for (let i = 0; i < UPDATE_COUNT; i++) {
  const driver = telemetryDrivers[i % telemetryDrivers.length];

  driver.lat = Math.max(
    SF_BOUNDS.minLat,
    Math.min(SF_BOUNDS.maxLat, driver.lat + (Math.random() - 0.5) * 0.0002),
  );

  driver.lng = Math.max(
    SF_BOUNDS.minLng,
    Math.min(SF_BOUNDS.maxLng, driver.lng + (Math.random() - 0.5) * 0.0002),
  );

  telemetryGrid.update(driver.id, driver.lat, driver.lng);
}

const updateEnd = process.hrtime.bigint();

const updateDurationMs = Number(updateEnd - updateStart) / 1e6;

console.log(`    Updates: ${UPDATE_COUNT.toLocaleString()}`);

console.log(`    Duration: ${updateDurationMs.toFixed(2)}ms`);

console.log(`    Mean latency: ${formatUs(updateDurationMs / UPDATE_COUNT)}`);

console.log(
  `    Throughput: ${Math.round(
    UPDATE_COUNT / (updateDurationMs / 1000),
  ).toLocaleString()} updates/sec`,
);

console.log("\n=====================================================");

console.log("                    TEST COMPLETE                   ");

console.log("=====================================================");
