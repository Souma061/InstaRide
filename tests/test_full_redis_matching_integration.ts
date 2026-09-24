import assert from "node:assert";
import { DriverRegistry } from "../src/core/driver_registry.js";
import { MatchingService } from "../src/core/matching_service.js";
import { RedisDriverLock } from "../src/core/redis_driver_lock.js";
import { RedisTripStore } from "../src/core/redis_trip_store.js";
import { TripStateMachine } from "../src/core/trip_state_machine.js";
import {
  connectRedis,
  disconnectRedis,
  redis,
} from "../src/infra/redis_client.js";
import { QuadTree } from "../src/spatial/quadtree.js";

async function runFullIntegrationTest() {
  console.log(
    "======================================================================",
  );
  console.log(
    "   COMPLETE REDIS + MATCHING ENGINE FULL INTEGRATION TEST             ",
  );
  console.log(
    "   Verifying Distributed Concurrency, Idempotency & Edge Cases        ",
  );
  console.log(
    "======================================================================\n",
  );

  await connectRedis();

  // Flush Redis test namespace to ensure 100% clean test environment
  await redis.flushall();

  const bounds = { minLat: 12.86, maxLat: 13.06, minLng: 77.5, maxLng: 77.72 };
  const spatialIndex = new QuadTree(bounds, 8, 10);
  const redisLock = new RedisDriverLock();
  const tripStore = new RedisTripStore();
  const driverRegistry = new DriverRegistry(spatialIndex, redisLock);
  const stateMachine = new TripStateMachine();

  let matchingService: MatchingService;
  matchingService = new MatchingService(
    driverRegistry,
    stateMachine,
    {
      onOfferDispatched: (notif) => {
        // Auto-accept offers for driver_accepting
        if (notif.driverId.startsWith("driver_auto_accept")) {
          setImmediate(() => {
            matchingService.handleDriverResponse(
              notif.driverId,
              notif.requestId,
              "accepted",
            );
          });
        }
      },
      onTripMatched: () => {},
      onMatchFailed: () => {},
    },
    tripStore,
  );

  // --------------------------------------------------------------------------
  // EDGE CASE 1: End-to-End Match with Distributed Redis State
  // --------------------------------------------------------------------------
  console.log("[Test 1] End-to-End Ride Request & Redis Lock/State Commit...");
  const D1 = "driver_auto_accept_1";
  driverRegistry.registerDriver(D1, 12.9716, 77.5946, "available");

  const req1 = await matchingService.requestRide({
    requestId: "req_test_1",
    riderId: "rider_carol",
    pickup: { lat: 12.9716, lng: 77.5946 },
    dropoff: { lat: 12.9816, lng: 77.6046 },
    offerTimeoutMs: 2000,
  });

  assert(req1.success && req1.trip, "Ride request 1 should succeed");
  console.log(
    `  Initial trip created: ${req1.trip.id} (Status: ${req1.trip.status})`,
  );

  // Allow dispatch offer loop to match driver
  await new Promise((resolve) => setTimeout(resolve, 100));

  const trip1After = stateMachine.getTrip(req1.trip.id);
  assert(
    trip1After?.status === "matched",
    `Trip should be matched, got ${trip1After?.status}`,
  );
  assert(trip1After?.driverId === D1, `Driver should be ${D1}`);

  // Verify state in Redis
  const tripInRedis = await tripStore.getTrip(req1.trip.id);
  assert(tripInRedis?.status === "matched", "Trip in Redis must be 'matched'");
  assert(tripInRedis?.driverId === D1, `Driver in Redis must be ${D1}`);

  const driverRedisState = await redis.hgetall(`driver:state:${D1}`);
  assert(
    driverRedisState.status === "busy",
    "Driver status in Redis must be 'busy'",
  );
  const isLockCleared = await redisLock.isLocked(D1);
  assert(!isLockCleared, "Driver temporary lock must be deleted after commit");
  console.log(
    "  [+] PASSED: Match completed, persisted to Redis, lock cleanly converted to 'busy'.\n",
  );

  // --------------------------------------------------------------------------
  // EDGE CASE 2: Network Idempotency (Mobile Packet Replay)
  // --------------------------------------------------------------------------
  console.log("[Test 2] Network Retry with identical requestId...");
  const replayReq = await matchingService.requestRide({
    requestId: "req_test_1", // Same requestId
    riderId: "rider_carol",
    pickup: { lat: 12.9716, lng: 77.5946 },
    dropoff: { lat: 12.9816, lng: 77.6046 },
  });

  assert(replayReq.success, "Replayed request must succeed idempotently");
  assert(
    replayReq.trip?.id === req1.trip.id,
    "Must return the exact existing trip",
  );
  console.log(
    `  [+] PASSED: Replayed request returned existing trip ${replayReq.trip?.id}.\n`,
  );

  // --------------------------------------------------------------------------
  // EDGE CASE 3: Single Active Trip Invariant (Cluster-Wide Rider Lock)
  // --------------------------------------------------------------------------
  console.log(
    "[Test 3] Carol attempts to request a 2nd ride while Trip 1 is active...",
  );
  const illegalSecondReq = await matchingService.requestRide({
    requestId: "req_test_different_2",
    riderId: "rider_carol", // Same rider!
    pickup: { lat: 12.95, lng: 77.55 },
    dropoff: { lat: 12.96, lng: 77.56 },
  });

  assert(!illegalSecondReq.success, "Second active request must be rejected");
  assert(
    illegalSecondReq.error?.includes("already has an active trip"),
    `Error should mention active trip: ${illegalSecondReq.error}`,
  );
  console.log(
    `  [+] PASSED: Rejected illegal concurrent trip: "${illegalSecondReq.error}".\n`,
  );

  // --------------------------------------------------------------------------
  // EDGE CASE 4: Competing Riders (Mutual Exclusion Race for Lone Driver)
  // --------------------------------------------------------------------------
  console.log(
    "[Test 4] Two riders racing for 1 available driver (Driver_Prize)...",
  );
  const D_PRIZE = "driver_auto_accept_prize";
  driverRegistry.registerDriver(D_PRIZE, 12.93, 77.61, "available");

  // Fire 2 simultaneous requests
  const pA = matchingService.requestRide({
    requestId: "req_race_A",
    riderId: "rider_Alice",
    pickup: { lat: 12.93, lng: 77.61 },
    dropoff: { lat: 12.94, lng: 77.62 },
    offerTimeoutMs: 1000,
  });

  const pB = matchingService.requestRide({
    requestId: "req_race_B",
    riderId: "rider_Bob",
    pickup: { lat: 12.93, lng: 77.61 },
    dropoff: { lat: 12.94, lng: 77.62 },
    offerTimeoutMs: 1000,
  });

  const [resA, resB] = await Promise.all([pA, pB]);
  assert(
    resA.success && resB.success,
    "Both requests should initiate matching",
  );

  // Wait for offers to settle
  await new Promise((resolve) => setTimeout(resolve, 200));

  const tripA = stateMachine.getTrip(resA.trip!.id);
  const tripB = stateMachine.getTrip(resB.trip!.id);

  const matchedCount =
    (tripA?.status === "matched" ? 1 : 0) +
    (tripB?.status === "matched" ? 1 : 0);
  assert(
    matchedCount === 1,
    `Exactly 1 trip should be matched! Found ${matchedCount}`,
  );
  console.log(
    `  Winner: ${tripA?.status === "matched" ? "Rider Alice" : "Rider Bob"}`,
  );
  console.log(
    "  [+] PASSED: Zero double-dispatch! Exactly 1 competitor locked the driver.\n",
  );

  // --------------------------------------------------------------------------
  // EDGE CASE 5: Rider Cancellation & Clean Lock Rollback
  // --------------------------------------------------------------------------
  console.log("[Test 5] Rider cancels while driver offer is pending...");
  const D_PENDING = "driver_manual_pending";
  driverRegistry.registerDriver(D_PENDING, 12.95, 77.65, "available");

  const pendingReq = await matchingService.requestRide({
    requestId: "req_to_cancel",
    riderId: "rider_impulsive",
    pickup: { lat: 12.95, lng: 77.65 },
    dropoff: { lat: 12.96, lng: 77.66 },
    offerTimeoutMs: 5000,
  });

  // Small delay so lock is acquired in Redis
  await new Promise((resolve) => setTimeout(resolve, 50));
  const isDriverLocked = await redisLock.isLocked(D_PENDING);
  assert(isDriverLocked, "Driver should be locked during pending offer");

  // Rider cancels!
  const cancelRes = await matchingService.cancelRide(
    "req_to_cancel",
    "rider",
    "Changed mind",
  );
  assert(cancelRes.success, "Cancellation should succeed");

  // Driver lock must be revoked immediately
  const isLockReleased = await redisLock.isLocked(D_PENDING);
  assert(
    !isLockReleased,
    "Driver lock must be revoked in Redis upon cancellation",
  );

  // Rider lock in Redis must be released
  const activeTripAfterCancel =
    await tripStore.getActiveTripByRiderId("rider_impulsive");
  assert(
    activeTripAfterCancel === null,
    "Rider active lock must be deleted from Redis",
  );
  console.log(
    "  [+] PASSED: Cancellation released driver lock and freed rider active lock.\n",
  );

  // --------------------------------------------------------------------------
  // EDGE CASE 6: Full Trip Completion & Teardown
  // --------------------------------------------------------------------------
  console.log(
    "[Test 6] Full Trip Lifecycle: en_route -> arrived -> in_progress -> completed...",
  );
  const matchedTripId = req1.trip.id;

  // Milestone 1: en_route
  stateMachine.driverEnRoute(matchedTripId);
  // Milestone 2: arrived
  stateMachine.driverArrived(matchedTripId);
  // Milestone 3: in_progress
  stateMachine.startTrip(matchedTripId);
  // Milestone 4: completed
  stateMachine.completeTrip(matchedTripId);

  // Sync completed state
  const finalTrip = stateMachine.getTrip(matchedTripId)!;
  await tripStore.saveTrip(finalTrip);
  await driverRegistry.completeTrip(D1);

  // Invariant checks
  const carolActive = await tripStore.getActiveTripByRiderId("rider_carol");
  assert(carolActive === null, "Carol must no longer have an active trip");

  const d1FinalState = await redis.hgetall(`driver:state:${D1}`);
  assert(
    d1FinalState.status === "available",
    `D1 must be available, got ${d1FinalState.status}`,
  );
  console.log(
    "  [+] PASSED: Completed trip, released rider, and returned driver to available.\n",
  );

  console.log(
    "======================================================================",
  );
  console.log(
    "   ALL INTEGRATION & CONCURRENCY EDGE CASES PASSED! (100%)            ",
  );
  console.log(
    "======================================================================\n",
  );

  await disconnectRedis();
}

runFullIntegrationTest().catch((err) => {
  console.error("FATAL INTEGRATION TEST ERROR:", err);
  disconnectRedis();
  process.exit(1);
});
