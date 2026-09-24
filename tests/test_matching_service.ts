import { DriverRegistry } from "../src/core/driver_registry.js";
import {
  MatchingService,
  OfferNotification,
} from "../src/core/matching_service.js";
import { Trip, TripStateMachine } from "../src/core/trip_state_machine.js";
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
  "             MATCHING SERVICE ORCHESTRATOR VERIFICATION               ",
);
console.log(
  "======================================================================\n",
);

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  // 1. Happy Path Match
  console.log("[1. Happy Path Dispatch & Acceptance]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    let dispatchedOffer: OfferNotification | null = null;
    let matchedTrip: Trip | null = null;

    const matching = new MatchingService(registry, sm, {
      onOfferDispatched: (notif) => {
        dispatchedOffer = notif;
      },
      onTripMatched: (trip) => {
        matchedTrip = trip;
      },
    });

    registry.registerDriver("driver_prime", 37.7749, -122.4194, "available");

    const req = await matching.requestRide({
      requestId: "req_happy",
      riderId: "rider_alice",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 200,
    });

    assert(
      req.success && req.trip?.status === "matching",
      "requestRide initializes trip in matching state",
    );
    await sleep(20);

    assert(
      dispatchedOffer !== null &&
        (dispatchedOffer as OfferNotification).driverId === "driver_prime",
      "Driver prime received match_request offer",
    );

    const acceptRes = matching.handleDriverResponse(
      "driver_prime",
      "req_happy",
      "accepted",
    );
    assert(acceptRes.success, "handleDriverResponse accepted by prime");

    await sleep(30);
    assert(
      matchedTrip !== null &&
        (matchedTrip as Trip).status === "matched" &&
        (matchedTrip as Trip).driverId === "driver_prime",
      "Trip transitioned to matched with driver_prime",
    );
    assert(
      registry.getDriver("driver_prime")?.status === "busy",
      "Driver status committed to busy",
    );
  }

  // 2. Rejection Fallback to Candidate #2
  console.log("\n[2. Driver Rejection & Fallback Loop]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    const offeredDrivers: string[] = [];
    let matchedDriver: string | null = null;

    const matching = new MatchingService(registry, sm, {
      onOfferDispatched: (notif) => {
        offeredDrivers.push(notif.driverId);
      },
      onTripMatched: (trip, driverId) => {
        matchedDriver = driverId;
      },
    });

    // Place D1 very close, D2 slightly further
    registry.registerDriver("driver_d1", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_d2", 37.776, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_reject_fallback",
      riderId: "rider_bob",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 500,
    });

    await sleep(20);
    assert(
      offeredDrivers[0] === "driver_d1",
      "Candidate #1 (driver_d1) offered first",
    );

    // D1 rejects offer!
    const rejectRes = matching.handleDriverResponse(
      "driver_d1",
      "req_reject_fallback",
      "rejected",
    );
    assert(rejectRes.success, "Driver D1 rejection handled");

    await sleep(30);
    assert(
      registry.getDriver("driver_d1")?.status === "available" &&
        registry.getDriver("driver_d1")?.lockToken === undefined,
      "Driver D1 lock released and restored to available",
    );
    assert(
      offeredDrivers[1] === "driver_d2",
      "Fallback immediately offered to Candidate #2 (driver_d2)",
    );

    // D2 accepts
    matching.handleDriverResponse(
      "driver_d2",
      "req_reject_fallback",
      "accepted",
    );
    await sleep(30);

    assert(
      matchedDriver === "driver_d2",
      "Trip successfully matched with Candidate #2",
    );
  }

  // 3. Timeout Fallback (15s deadman switch simulated)
  console.log("\n[3. Offer Timeout Fallback (Deadman Switch)]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    const offeredDrivers: string[] = [];
    const revokedDrivers: string[] = [];
    let matchedDriver: string | null = null;

    const matching = new MatchingService(registry, sm, {
      onOfferDispatched: (notif) => {
        offeredDrivers.push(notif.driverId);
      },
      onOfferRevoked: (driverId) => {
        revokedDrivers.push(driverId);
      },
      onTripMatched: (trip, driverId) => {
        matchedDriver = driverId;
      },
    });

    registry.registerDriver("driver_slow", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_backup", 37.7755, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_timeout",
      riderId: "rider_charlie",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 100, // fast simulated timeout
    });

    await sleep(20);
    assert(
      offeredDrivers[0] === "driver_slow",
      "Offer dispatched to slow driver",
    );

    // Don't respond, let it time out
    await sleep(150);

    assert(
      revokedDrivers.includes("driver_slow"),
      "Slow driver offer revoked due to timeout",
    );
    assert(
      offeredDrivers[1] === "driver_backup",
      "Offer automatically advanced to backup driver",
    );

    // Backup driver accepts
    matching.handleDriverResponse("driver_backup", "req_timeout", "accepted");
    await sleep(30);

    assert(
      matchedDriver === "driver_backup",
      "Backup driver won trip after slow driver timed out",
    );
  }

  // 4. Late 15.002s Accept Race Rejection
  console.log("\n[4. 15.002s Late Accept Race Rejection]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    const matching = new MatchingService(registry, sm);
    registry.registerDriver("driver_late", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_runnerup", 37.7755, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_late_race",
      riderId: "rider_david",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 100,
    });

    // Wait until offer expires
    await sleep(150);

    // Driver_late attempts to accept after expiration
    const lateResponse = matching.handleDriverResponse(
      "driver_late",
      "req_late_race",
      "accepted",
    );
    assert(!lateResponse.success, "Late accept after timeout rejected");
    assert(
      lateResponse.error?.includes("OFFER_EXPIRED") ?? false,
      "Late accept returns OFFER_EXPIRED error to driver",
    );
  }

  // 5. Rider Cancellation During Active Offer
  console.log("\n[5. Rider Cancellation Revocation]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    let revokedDriver: string | null = null;

    const matching = new MatchingService(registry, sm, {
      onOfferRevoked: (driverId) => {
        revokedDriver = driverId;
      },
    });

    registry.registerDriver("driver_active", 37.7749, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_cancel",
      riderId: "rider_eva",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 1000,
    });

    await sleep(20);
    assert(
      matching.getActiveOffer("req_cancel") !== undefined,
      "Active offer exists for driver_active",
    );

    // Rider cancels before driver can respond
    const cancelRes = await matching.cancelRide(
      "req_cancel",
      "rider",
      "Change of plans",
    );
    assert(cancelRes.success, "cancelRide returns success");

    await sleep(20);
    assert(
      revokedDriver === "driver_active",
      "offer_revoked emitted to driver_active",
    );
    assert(
      registry.getDriver("driver_active")?.status === "available" &&
        registry.getDriver("driver_active")?.lockToken === undefined,
      "driver_active lock released and restored to available in Quadtree",
    );
    assert(
      sm.getTripByRequestId("req_cancel")?.status === "cancelled",
      "Trip status marked cancelled in state machine",
    );
  }

  // 6. No Drivers Available in Radius
  console.log("\n[6. No Available Drivers In Radius]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    let failedReason: string | null = null;
    const matching = new MatchingService(registry, sm, {
      onMatchFailed: (reqId, reason) => {
        failedReason = reason;
      },
    });

    // Empty registry
    await matching.requestRide({
      requestId: "req_empty",
      riderId: "rider_frank",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
    });

    await sleep(30);
    assert(
      failedReason !== null,
      "onMatchFailed emitted when no drivers exist",
    );
    assert(
      sm.getTripByRequestId("req_empty")?.status === "cancelled",
      "Trip cancelled when no candidates exist",
    );
  }

  // 7. Auto-Rematch Workflow
  console.log("\n[7. Auto-Rematch On Driver Breakdown]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    let matchedCount = 0;
    let lastMatchedDriver: string | null = null;

    const matching = new MatchingService(registry, sm, {
      onTripMatched: (trip, driverId) => {
        matchedCount++;
        lastMatchedDriver = driverId;
      },
    });

    registry.registerDriver("driver_1st", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_2nd", 37.776, -122.4194, "available");

    const req = await matching.requestRide({
      requestId: "req_rematch_test",
      riderId: "rider_grace",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 500,
    });

    await sleep(20);
    matching.handleDriverResponse("driver_1st", "req_rematch_test", "accepted");
    await sleep(30);

    assert(lastMatchedDriver === "driver_1st", "First driver matched");
    sm.driverEnRoute(req.trip!.id);

    // Driver 1st breaks down -> trigger rematch
    const rematchRes = await matching.rematch(
      req.trip!.id,
      "Engine breakdown",
      { offerTimeoutMs: 500 },
    );
    assert(rematchRes.success, "Rematch initiated successfully");

    await sleep(30);
    // Driver 2nd accepts the rematched ride
    matching.handleDriverResponse("driver_2nd", "req_rematch_test", "accepted");
    await sleep(30);

    assert(
      matchedCount === 2 && lastMatchedDriver === "driver_2nd",
      "Trip successfully rematched to driver_2nd",
    );
  }

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
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
