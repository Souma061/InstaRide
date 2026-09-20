import { DriverRegistry } from "../src/core/driver_registry.js";
import { QuadTree } from "../src/spatial/quadtree.js";

const SF_BOUNDS = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

console.log(
  "======================================================================",
);
console.log(
  "      CONCURRENT RIDE-MATCHING RACE: TWO RIDERS, ONE DRIVER           ",
);
console.log(
  "======================================================================\n",
);

const tree = new QuadTree(SF_BOUNDS, 8, 7);
const registry = new DriverRegistry(tree);

// Place 1 prime driver right in front of both riders
const PRIME_DRIVER = "Driver_Prime";
const BACKUP_DRIVER = "Driver_Backup";

registry.registerDriver(PRIME_DRIVER, 37.75, -122.45, "available");
registry.registerDriver(BACKUP_DRIVER, 37.755, -122.45, "available"); // ~550m away

console.log(`[Setup]`);
console.log(
  `  - ${PRIME_DRIVER} stationed at (37.7500, -122.4500) [AVAILABLE]`,
);
console.log(
  `  - ${BACKUP_DRIVER} stationed at (37.7550, -122.4500) [AVAILABLE]`,
);
console.log(`  - Initial QuadTree size: ${tree.size()}\n`);

// Rider Alice is 15 meters away
const aliceCoords = { lat: 37.7501, lng: -122.4501 };
// Rider Bob is 25 meters away
const bobCoords = { lat: 37.7502, lng: -122.4502 };

interface MatchResult {
  rider: string;
  requestId: string;
  assignedDriver: string | null;
  attempts: { driverId: string; locked: boolean }[];
}

/**
 * Simulates a realistic dispatch workflow:
 * 1. Find k-nearest available candidates.
 * 2. Try to lock Candidate 1.
 * 3. If Candidate 1 is claimed by a competitor, fall back to Candidate 2.
 */
async function dispatchRider(
  riderName: string,
  requestId: string,
  pickup: { lat: number; lng: number },
): Promise<MatchResult> {
  const attempts: { driverId: string; locked: boolean }[] = [];

  // 1. Query candidates from spatial index
  const candidates = registry.findNearbyCandidates(
    pickup.lat,
    pickup.lng,
    4,
    5000,
  );

  let assignedDriver: string | null = null;

  // 2. Sequential atomic lock loop
  for (const candidate of candidates) {
    const lockGranted = registry.acquireLock(candidate.id, requestId, 15_000);
    attempts.push({ driverId: candidate.id, locked: lockGranted });

    if (lockGranted) {
      assignedDriver = candidate.id;
      break; // Successfully matched!
    }
    // If lock failed, competitor grabbed this driver. Loop falls through to next candidate!
  }

  return {
    rider: riderName,
    requestId,
    assignedDriver,
    attempts,
  };
}

console.log("[Simulating Simultaneous Request Burst]");
console.log(
  "  Rider Alice and Rider Bob request rides at the exact same millisecond...\n",
);

// Fire both ride requests simultaneously using Promise.all
const [aliceResult, bobResult] = await Promise.all([
  dispatchRider("Alice", "req_alice_101", aliceCoords),
  dispatchRider("Bob", "req_bob_202", bobCoords),
]);

console.log("--- RESULTS ---");
console.log(`Rider Alice:`);
console.log(`  - Assigned Driver: ${aliceResult.assignedDriver}`);
console.log(`  - Dispatch Attempts:`, aliceResult.attempts);

console.log(`\nRider Bob:`);
console.log(`  - Assigned Driver: ${bobResult.assignedDriver}`);
console.log(`  - Dispatch Attempts:`, bobResult.attempts);

// Assertions & Verification
console.log("\n--- VERIFICATION AUDIT ---");

const aliceDriver = aliceResult.assignedDriver;
const bobDriver = bobResult.assignedDriver;

// 1. Both riders must get a driver
console.log(
  `  1. Did Alice get matched? ${aliceDriver !== null ? "PASS" : "FAIL"} (${aliceDriver})`,
);
console.log(
  `  2. Did Bob get matched?   ${bobDriver !== null ? "PASS" : "FAIL"} (${bobDriver})`,
);

// 2. Zero Double-Dispatch: Alice and Bob MUST NOT have the same driver
const isDoubleDispatched = aliceDriver !== null && aliceDriver === bobDriver;
console.log(
  `  3. Double-Dispatch Check (Must be false): ${isDoubleDispatched} -> ${!isDoubleDispatched ? "PASS (0% duplicate)" : "FAIL (RACE DETECTED)"}`,
);

// 3. One rider won Driver_Prime, the other safely fell through to Driver_Backup
const primeAssignedTo =
  aliceDriver === PRIME_DRIVER
    ? "Alice"
    : bobDriver === PRIME_DRIVER
      ? "Bob"
      : "None";
const backupAssignedTo =
  aliceDriver === BACKUP_DRIVER
    ? "Alice"
    : bobDriver === BACKUP_DRIVER
      ? "Bob"
      : "None";

console.log(`  4. ${PRIME_DRIVER} winner: ${primeAssignedTo}`);
console.log(`  5. ${BACKUP_DRIVER} runner-up: ${backupAssignedTo}`);
console.log(
  `  6. Remaining available in QuadTree: ${tree.size()} (Expected: 0)`,
);

if (isDoubleDispatched || !aliceDriver || !bobDriver) {
  throw new Error("Concurrency test failed!");
}

console.log(
  "\n======================================================================",
);
console.log(
  "   CONCURRENCY TEST 2: HIGH-LOAD STRESS TEST (1,000 RIDERS vs 30 DRIVERS)  ",
);
console.log(
  "======================================================================\n",
);

const TOTAL_DRIVERS = 20;
const TOTAL_REQUESTS = 2000;

// Seed drivers across the city
const stressTree = new QuadTree(SF_BOUNDS, 8, 7);
const stressRegistry = new DriverRegistry(stressTree);

for (let i = 0; i < TOTAL_DRIVERS; i++) {
  const dId = `fleet_driver_${i}`;
  const lat = 37.75 + (Math.random() - 0.5) * 0.04;
  const lng = -122.45 + (Math.random() - 0.5) * 0.04;
  stressRegistry.registerDriver(dId, lat, lng, "available");
}

console.log(`  - Seeded ${TOTAL_DRIVERS} drivers into stress registry`);
console.log(
  `  - Firing ${TOTAL_REQUESTS} simultaneous rider requests competing for those ${TOTAL_DRIVERS} drivers...\n`,
);

const stressRequests = Array.from({ length: TOTAL_REQUESTS }, (_, i) => {
  const rId = `rider_${i}`;
  const reqId = `req_${i}`;
  const pLat = 37.75 + (Math.random() - 0.5) * 0.03;
  const pLng = -122.45 + (Math.random() - 0.5) * 0.03;

  return (async () => {
    const candidates = stressRegistry.findNearbyCandidates(pLat, pLng, 5, 5000);
    for (const c of candidates) {
      if (stressRegistry.acquireLock(c.id, reqId, 15_000)) {
        return { rider: rId, driver: c.id };
      }
    }
    return { rider: rId, driver: null }; // No driver available
  })();
});

const stressResults = await Promise.all(stressRequests);

const matchedDrivers = stressResults
  .map((r) => r.driver)
  .filter((d): d is string => d !== null);

const uniqueMatchedDrivers = new Set(matchedDrivers);
const duplicateAssignments = matchedDrivers.length - uniqueMatchedDrivers.size;

console.log(`  - Total Requests: ${TOTAL_REQUESTS}`);
console.log(
  `  - Total Matches Made: ${matchedDrivers.length} / ${TOTAL_DRIVERS} available drivers`,
);
console.log(`  - Unique Drivers Assigned: ${uniqueMatchedDrivers.size}`);
console.log(`  - Duplicate Double-Dispatches: ${duplicateAssignments}`);
console.log(
  `  - Unmatched Riders (handled gracefully): ${TOTAL_REQUESTS - matchedDrivers.length}`,
);

if (duplicateAssignments !== 0) {
  throw new Error(
    `CRITICAL CONCURRENCY FAILURE: ${duplicateAssignments} duplicate assignments detected!`,
  );
}

console.log(
  "\n======================================================================",
);
console.log(
  "   STRESS TEST PASSED: STRICT 0% DOUBLE-DISPATCH GUARANTEE VERIFIED    ",
);
console.log(
  "======================================================================",
);
