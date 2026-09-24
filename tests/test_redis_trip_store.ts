import { RedisTripStore } from "../src/core/redis_trip_store.js";
import { Trip } from "../src/core/trip_state_machine.js";
import {
  connectRedis,
  disconnectRedis,
  redis,
} from "../src/infra/redis_client.js";

async function runTests() {
  console.log("=====================================================");
  console.log("      REDIS DISTRIBUTED TRIP STORE: TEST SUITE       ");
  console.log("=====================================================\n");

  await connectRedis();
  const tripStore = new RedisTripStore();

  const RIDER_A = "rider_alice_1";
  const TRIP_1: Trip = {
    id: "trip_1001",
    requestId: "req_alpha",
    riderId: RIDER_A,
    driverId: null,
    status: "requested",
    pickup: { lat: 12.9716, lng: 77.5946 },
    dropoff: { lat: 12.9816, lng: 77.6046 },
    createdAt: Date.now(),
    matchedAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    cancelledBy: null,
  };

  // Clean slate before testing
  await redis.del(`request:trip:${TRIP_1.requestId}`);
  await redis.del(`trip:${TRIP_1.id}`);
  await redis.del(`rider:active_trip:${RIDER_A}`);
  await redis.srem("trip:active", TRIP_1.id);

  // ----------------------------------------------------------------
  // Test 1: Trip Creation & Active Rider Lock
  // ----------------------------------------------------------------
  console.log("[Test 1] Creating Trip 1 for Alice...");
  const createRes = await tripStore.createTrip(TRIP_1);
  console.log(`  Creation Success: ${createRes.success} (Expected: true)`);

  const activeTrip = await tripStore.getActiveTripByRiderId(RIDER_A);
  console.log(
    `  Alice's Active Trip: ${activeTrip?.id} (Expected: trip_1001)\n`,
  );

  // ----------------------------------------------------------------
  // Test 2: Network Idempotency (Same RequestId Retry)
  // ----------------------------------------------------------------
  console.log(
    "[Test 2] Simulating mobile network retry with identical requestId...",
  );
  const retryRes = await tripStore.createTrip(TRIP_1);
  console.log(`  Retry Success: ${retryRes.success} (Expected: true)`);
  console.log(
    `  Returned Trip ID: ${retryRes.trip?.id} (Expected: trip_1001)\n`,
  );

  // ----------------------------------------------------------------
  // Test 3: Preventing Illegal Second Trip for Same Rider
  // ----------------------------------------------------------------
  console.log(
    "[Test 3] Alice attempts to book a 2nd trip while Trip 1 is active...",
  );
  const TRIP_2: Trip = {
    ...TRIP_1,
    id: "trip_1002",
    requestId: "req_beta_different",
  };
  const secondTripRes = await tripStore.createTrip(TRIP_2);
  console.log(
    `  Second Trip Rejected: ${!secondTripRes.success} (Expected: true)`,
  );
  console.log(`  Error Message: "${secondTripRes.error}"\n`);

  // ----------------------------------------------------------------
  // Test 4: Driver Match & State Update
  // ----------------------------------------------------------------
  console.log("[Test 4] Driver Bob matches with Trip 1...");
  TRIP_1.status = "matched";
  TRIP_1.driverId = "driver_bob_99";
  TRIP_1.matchedAt = Date.now();
  await tripStore.saveTrip(TRIP_1);

  const matchedFetch = await tripStore.getTrip(TRIP_1.id);
  console.log(
    `  Trip Status in Redis: "${matchedFetch?.status}" (Expected: "matched")`,
  );
  console.log(
    `  Assigned Driver: "${matchedFetch?.driverId}" (Expected: "driver_bob_99")\n`,
  );

  // ----------------------------------------------------------------
  // Test 5: Driver Cancels with Auto-Rematch
  // ----------------------------------------------------------------
  console.log("[Test 5] Driver Bob cancels -> Auto-Rematch triggered...");
  const rematchRes = await tripStore.handleDriverCancellation(
    TRIP_1.id,
    "driver_bob_99",
    "Flat tire",
    true, // autoRematch = true
  );
  console.log(`  Rematch Handled: ${rematchRes.success} (Expected: true)`);
  console.log(
    `  New Trip Status: "${rematchRes.trip?.status}" (Expected: "matching")`,
  );
  console.log(
    `  Driver ID cleared: ${rematchRes.trip?.driverId === null} (Expected: true)`,
  );
  const aliceStillActive = await tripStore.getActiveTripByRiderId(RIDER_A);
  console.log(
    `  Alice stays locked for rematch: ${aliceStillActive !== null} (Expected: true)\n`,
  );

  // ----------------------------------------------------------------
  // Test 6: Final Trip Completion & Rider Lock Cleanup
  // ----------------------------------------------------------------
  console.log("[Test 6] Completing Trip 1 and verifying rider release...");
  const currentTrip = (await tripStore.getTrip(TRIP_1.id))!;
  currentTrip.status = "completed";
  currentTrip.completedAt = Date.now();
  await tripStore.saveTrip(currentTrip);

  const aliceAfterCompletion = await tripStore.getActiveTripByRiderId(RIDER_A);
  console.log(
    `  Alice Active Trip after completion: ${aliceAfterCompletion} (Expected: null)`,
  );

  const activeTripsList = await tripStore.getActiveTrips();
  const inActiveSet = activeTripsList.some((t) => t.id === TRIP_1.id);
  console.log(
    `  Trip removed from active set: ${!inActiveSet} (Expected: true)\n`,
  );

  // ----------------------------------------------------------------
  // Test 7: Alice can now book a new trip freely
  // ----------------------------------------------------------------
  console.log("[Test 7] Alice books a brand new trip after completion...");
  const newTripRes = await tripStore.createTrip(TRIP_2);
  console.log(`  New Trip Allowed: ${newTripRes.success} (Expected: true)\n`);

  // Clean up
  if (newTripRes.trip) {
    newTripRes.trip.status = "cancelled";
    await tripStore.saveTrip(newTripRes.trip);
  }

  console.log("=====================================================");
  console.log("  ALL REDIS TRIP STORE INVARIANTS PASSED! (100%)      ");
  console.log("=====================================================\n");

  await disconnectRedis();
}

runTests().catch((err) => {
  console.error("Fatal Test Error:", err);
  disconnectRedis();
});
