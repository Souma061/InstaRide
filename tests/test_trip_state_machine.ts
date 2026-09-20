import { TripStateMachine } from "../src/core/trip_state_machine.js";

console.log(
  "======================================================================",
);
console.log(
  "           TRIP STATE MACHINE COMPREHENSIVE VERIFICATION              ",
);
console.log(
  "======================================================================\n",
);

const sm = new TripStateMachine();
let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

// 1. Happy Path Lifecycle
console.log("[1. Happy Path Lifecycle]");
const r1 = sm.createTrip({
  requestId: "req_happy",
  riderId: "rider_alice",
  pickup: { lat: 37.77, lng: -122.41 },
  dropoff: { lat: 37.78, lng: -122.42 },
});
assert(
  r1.success && r1.trip?.status === "requested",
  "createTrip sets status to requested",
);

const m1 = sm.startMatching(r1.trip!.id);
assert(m1.success && m1.trip?.status === "matching", "requested -> matching");

const match1 = sm.setMatched(r1.trip!.id, "driver_bob");
assert(
  match1.success &&
    match1.trip?.status === "matched" &&
    match1.trip?.driverId === "driver_bob" &&
    sm.getActiveTripForDriver("driver_bob")?.id === r1.trip!.id,
  "matching -> matched assigns driverId and updates activeDriverTrips",
);

const enRoute1 = sm.driverEnRoute(r1.trip!.id);
assert(
  enRoute1.success && enRoute1.trip?.status === "en_route",
  "matched -> en_route",
);

const arrived1 = sm.driverArrived(r1.trip!.id);
assert(
  arrived1.success && arrived1.trip?.status === "arrived",
  "en_route -> arrived",
);

const start1 = sm.startTrip(r1.trip!.id);
assert(
  start1.success &&
    start1.trip?.status === "in_progress" &&
    start1.trip?.startedAt !== null,
  "arrived -> in_progress (startedAt recorded)",
);

const complete1 = sm.completeTrip(r1.trip!.id);
assert(
  complete1.success &&
    complete1.trip?.status === "completed" &&
    complete1.trip?.completedAt !== null,
  "in_progress -> completed (completedAt recorded)",
);

assert(
  sm.getActiveTripForRider("rider_alice") === undefined &&
    sm.getActiveTripForDriver("driver_bob") === undefined,
  "completed cleans up active rider and driver indexes",
);

// 2. Idempotency & In-flight Double-Booking Guards
console.log("\n[2. Concurrency & Idempotency Guards]");
const replay = sm.createTrip({
  requestId: "req_happy", // same requestId
  riderId: "rider_alice",
  pickup: { lat: 37.77, lng: -122.41 },
  dropoff: { lat: 37.78, lng: -122.42 },
});
assert(
  replay.success && replay.trip?.id === r1.trip!.id,
  "Idempotent createTrip returns existing trip",
);

// Create trip for Alice again now that previous trip is completed
const r2 = sm.createTrip({
  requestId: "req_alice_2",
  riderId: "rider_alice",
  pickup: { lat: 37.77, lng: -122.41 },
  dropoff: { lat: 37.78, lng: -122.42 },
});
assert(r2.success, "Rider can book new trip after previous is completed");

// Try creating a second active trip for Alice while r2 is active
const r2_dup = sm.createTrip({
  requestId: "req_alice_3",
  riderId: "rider_alice",
  pickup: { lat: 37.77, lng: -122.41 },
  dropoff: { lat: 37.78, lng: -122.42 },
});
assert(
  !r2_dup.success && r2_dup.error?.includes("already has an active trip"),
  "Rider double-booking rejected while trip is active",
);

// 3. Driver Double-Booking Guard
console.log("\n[3. Driver Double-Booking Guard]");
sm.startMatching(r2.trip!.id);
sm.setMatched(r2.trip!.id, "driver_charlie");

const r3 = sm.createTrip({
  requestId: "req_david_1",
  riderId: "rider_david",
  pickup: { lat: 37.75, lng: -122.43 },
  dropoff: { lat: 37.76, lng: -122.44 },
});
sm.startMatching(r3.trip!.id);

const matchCharlieAgain = sm.setMatched(r3.trip!.id, "driver_charlie");
assert(
  !matchCharlieAgain.success &&
    matchCharlieAgain.error?.includes("already has an active trip"),
  "Driver double-assignment rejected when driver already busy",
);

// 4. Role Authorization Checks
console.log("\n[4. Role Authorization Checks]");
// Driver trying to mark arrived before matching
assert(
  !sm.driverArrived(r3.trip!.id).success,
  "Cannot mark arrived when status is matching (invalid transition)",
);

// Rider trying to mark arrived
const riderArrive = sm.transition(r2.trip!.id, "arrived", "rider");
assert(
  !riderArrive.success && riderArrive.error?.includes("Only driver"),
  "Rider cannot trigger arrived status",
);

// Driver trying to cancel unassigned trip
const driverCancelUnassigned = sm.cancelTrip(
  r3.trip!.id,
  "driver",
  "unassigned cancel",
);
assert(
  !driverCancelUnassigned.success &&
    driverCancelUnassigned.error?.includes(
      "Driver cannot cancel an unassigned trip",
    ),
  "Driver cannot cancel requested/matching trip before assignment",
);

// Rider can cancel matching trip
const riderCancel = sm.cancelTrip(r3.trip!.id, "rider", "changed my mind");
assert(
  riderCancel.success && riderCancel.trip?.status === "cancelled",
  "Rider can cancel matching trip",
);

// 5. In-Progress Cancellation Strict Block
console.log("\n[5. In-Progress Cancellation Strict Block]");
sm.driverEnRoute(r2.trip!.id);
sm.driverArrived(r2.trip!.id);
sm.startTrip(r2.trip!.id); // in_progress

const riderCancelInProgress = sm.cancelTrip(r2.trip!.id, "rider", "abort now!");
assert(
  !riderCancelInProgress.success &&
    riderCancelInProgress.error?.includes(
      "Invalid transition from in_progress to cancelled",
    ),
  "Rider cancellation strictly blocked once in_progress",
);

const driverCancelInProgress = sm.cancelTrip(
  r2.trip!.id,
  "driver",
  "abort now!",
);
assert(
  !driverCancelInProgress.success &&
    driverCancelInProgress.error?.includes(
      "Invalid transition from in_progress to cancelled",
    ),
  "Driver cancellation strictly blocked once in_progress",
);

// Complete r2 so charlie is free
sm.completeTrip(r2.trip!.id);

// 6. Driver Breakdown / Auto-Rematch Fallback
console.log("\n[6. Driver Breakdown / Auto-Rematch Fallback]");
const r4 = sm.createTrip({
  requestId: "req_rematch",
  riderId: "rider_eva",
  pickup: { lat: 37.75, lng: -122.43 },
  dropoff: { lat: 37.76, lng: -122.44 },
});
sm.startMatching(r4.trip!.id);
sm.setMatched(r4.trip!.id, "driver_frank");
sm.driverEnRoute(r4.trip!.id);

// Frank breaks down -> Rematch trip
const rematchRes = sm.rematchTrip(r4.trip!.id, "Driver flat tire");
assert(
  rematchRes.success &&
    rematchRes.trip?.status === "matching" &&
    rematchRes.trip?.driverId === null &&
    rematchRes.trip?.matchedAt === null &&
    sm.getActiveTripForDriver("driver_frank") === undefined,
  "Rematch from en_route resets status to matching, clears driverId and driver active index",
);

// Now new driver can be matched
const matchGrace = sm.setMatched(r4.trip!.id, "driver_grace");
assert(
  matchGrace.success &&
    matchGrace.trip?.driverId === "driver_grace" &&
    sm.getActiveTripForDriver("driver_grace")?.id === r4.trip!.id,
  "Rematched trip successfully pairs with a new driver",
);

// 7. Audit Log Integrity
console.log("\n[7. Audit Log Integrity]");
const auditEvents = sm.getAuditEvents();
assert(
  auditEvents.length > 10,
  `Audit log captured ${auditEvents.length} transition events`,
);
const lastEvent = auditEvents[auditEvents.length - 1];
assert(
  lastEvent.toStatus === "matched" && lastEvent.triggeredBy === "system",
  "Audit log records correct fromStatus, toStatus, and triggeredBy",
);

console.log(
  "\n======================================================================",
);
console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log(
  "======================================================================",
);

if (failed > 0) {
  process.exit(1);
}
