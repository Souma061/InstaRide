import { DriverRegistry } from "../src/core/driver_registry.js";
import {
  MatchingService,
  MatchingServiceEvents,
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

/** Fresh state machine + registry + service so sections never share trips. */
function makeFixture(events: MatchingServiceEvents = {}) {
  const tree = new QuadTree(SF_BOUNDS);
  const registry = new DriverRegistry(tree);
  const sm = new TripStateMachine();
  const matching = new MatchingService(registry, sm, events);
  return { tree, registry, sm, matching };
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

  // 8. The candidate list must be re-read between offers, so a driver that
  // becomes available after dispatch started is still reachable in this trip.
  console.log("\n[8. Re-Query Between Offers]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();

    const offeredTo: string[] = [];
    let matchedDriver: string | null = null;

    const matching = new MatchingService(registry, sm, {
      onOfferDispatched: (notif) => {
        offeredTo.push(notif.driverId);
      },
      onTripMatched: (_trip, driverId) => {
        matchedDriver = driverId;
      },
    });

    // Only driver_silent exists when the ride is requested, and it never answers.
    registry.registerDriver("driver_silent", 37.7749, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_requery",
      riderId: "rider_hank",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 300,
    });

    await sleep(20);
    assert(
      offeredTo.includes("driver_silent"),
      "Silent driver offered first",
      `offered=${offeredTo.join(",")}`,
    );

    // Comes online while the loop is still waiting out driver_silent.
    registry.registerDriver("driver_late", 37.775, -122.4194, "available");

    await sleep(500);
    assert(
      offeredTo.includes("driver_late"),
      "Driver appearing mid-loop is still offered",
      `offered=${offeredTo.join(",")}`,
    );

    matching.handleDriverResponse("driver_late", "req_requery", "accepted");
    await sleep(30);
    assert(
      matchedDriver === "driver_late",
      "Late driver matched the trip",
      `matched=${matchedDriver}`,
    );
  }

  // 9. Trip creation rejections and idempotent re-submission.
  console.log("\n[9. Request Validation & Idempotent Re-Submission]");
  {
    const offeredTo: string[] = [];
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => offeredTo.push(notif.driverId),
    });
    registry.registerDriver("driver_validate", 37.7749, -122.4194, "available");

    const badCoords = await matching.requestRide({
      requestId: "req_bad_coords",
      riderId: "rider_ivy",
      pickup: { lat: 999, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
    });
    assert(
      !badCoords.success &&
        (badCoords.error ?? "").includes("Invalid coordinates"),
      "Out-of-range coordinates are rejected before matching starts",
      `error=${badCoords.error}`,
    );

    const first = await matching.requestRide({
      requestId: "req_idem",
      riderId: "rider_ivy",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 1000,
    });
    assert(first.success, "First submission is accepted", `error=${first.error}`);

    const replay = await matching.requestRide({
      requestId: "req_idem",
      riderId: "rider_ivy",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 1000,
    });
    assert(
      replay.success && replay.trip?.id === first.trip?.id,
      "Replay returns the original trip instead of a duplicate",
      `got=${replay.trip?.id} want=${first.trip?.id}`,
    );

    await sleep(60);
    assert(
      offeredTo.length === 1,
      "Replay does not start a second dispatch loop",
      `offered=${offeredTo.join(",")}`,
    );

    const wrongRider = await matching.requestRide({
      requestId: "req_idem",
      riderId: "rider_intruder",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
    });
    assert(
      !wrongRider.success &&
        (wrongRider.error ?? "").includes(
          "already associated with another rider",
        ),
      "Same requestId under a different rider is rejected",
      `error=${wrongRider.error}`,
    );

    const busyRider = await matching.requestRide({
      requestId: "req_rider_busy",
      riderId: "rider_ivy",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
    });
    assert(
      !busyRider.success &&
        (busyRider.error ?? "").includes("already has an active trip"),
      "Rider already holding a trip cannot open a second one",
      `error=${busyRider.error}`,
    );
  }

  // 10. Every rejection path through handleDriverResponse.
  console.log("\n[10. Driver Response Guard Rails]");
  {
    const offeredTo: string[] = [];
    let matchedDriver: string | null = null;
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => offeredTo.push(notif.driverId),
      onTripMatched: (_trip, driverId) => {
        matchedDriver = driverId;
      },
    });
    registry.registerDriver("driver_guard_a", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_guard_b", 37.776, -122.4194, "available");

    const invalid = matching.handleDriverResponse(
      "driver_guard_a",
      "req_guard",
      "maybe",
    );
    assert(
      !invalid.success &&
        (invalid.error ?? "").includes("INVALID_RESPONSE"),
      "Payload other than accepted/rejected is rejected",
      `error=${invalid.error}`,
    );

    const unknown = matching.handleDriverResponse(
      "driver_guard_a",
      "req_never_opened",
      "accepted",
    );
    assert(
      !unknown.success && (unknown.error ?? "").includes("OFFER_EXPIRED"),
      "Response against an unknown requestId is rejected",
      `error=${unknown.error}`,
    );

    await matching.requestRide({
      requestId: "req_guard",
      riderId: "rider_jane",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 1000,
    });
    await sleep(20);
    assert(
      offeredTo[0] === "driver_guard_a",
      "Nearest driver holds the open offer",
      `offered=${offeredTo.join(",")}`,
    );

    const impostor = matching.handleDriverResponse(
      "driver_guard_b",
      "req_guard",
      "accepted",
    );
    assert(
      !impostor.success && (impostor.error ?? "").includes("OFFER_EXPIRED"),
      "Second driver cannot answer the first driver's offer",
      `error=${impostor.error}`,
    );
    assert(
      matchedDriver === null,
      "Impostor response does not match the trip",
      `matched=${matchedDriver}`,
    );

    const holder = matching.handleDriverResponse(
      "driver_guard_a",
      "req_guard",
      "accepted",
    );
    assert(holder.success, "Offer holder response is accepted");
    await sleep(30);
    assert(
      matchedDriver === "driver_guard_a",
      "Trip matched with the offer holder",
      `matched=${matchedDriver}`,
    );
    assert(
      matching.getActiveOffer("req_guard") === undefined,
      "Active offer is cleared once accepted",
    );

    const repeat = matching.handleDriverResponse(
      "driver_guard_a",
      "req_guard",
      "accepted",
    );
    assert(
      !repeat.success && (repeat.error ?? "").includes("OFFER_EXPIRED"),
      "Repeat response after the offer closed is rejected",
      `error=${repeat.error}`,
    );
  }

  // 11. All candidates reject: reason string, no repeats, locks released.
  console.log("\n[11. Every Candidate Declines]");
  {
    const offeredTo: string[] = [];
    const revoked: string[] = [];
    let matchedDriver: string | null = null;
    let failReason: string | null = null;
    const { registry, sm, matching } = makeFixture({
      onOfferDispatched: (notif) => offeredTo.push(notif.driverId),
      onOfferRevoked: (driverId) => revoked.push(driverId),
      onTripMatched: (_trip, driverId) => {
        matchedDriver = driverId;
      },
      onMatchFailed: (_requestId, reason) => {
        failReason = reason;
      },
    });

    const pool = ["driver_no1", "driver_no2", "driver_no3"];
    for (const [i, id] of pool.entries()) {
      registry.registerDriver(id, 37.7749 + i * 0.0005, -122.4194, "available");
    }

    await matching.requestRide({
      requestId: "req_all_decline",
      riderId: "rider_kate",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 80,
    });

    const rejectionPump = setInterval(() => {
      const offer = matching.getActiveOffer("req_all_decline");
      if (offer) {
        matching.handleDriverResponse(
          offer.driverId,
          "req_all_decline",
          "rejected",
        );
      }
    }, 15);

    await sleep(500);
    clearInterval(rejectionPump);

    assert(
      matchedDriver === null,
      "No match is recorded when every candidate declines",
      `matched=${matchedDriver}`,
    );
    assert(
      failReason === "All candidate drivers declined or timed out",
      "Failure reason identifies declined drivers",
      `reason=${failReason}`,
    );
    assert(
      offeredTo.length >= 2,
      "Dispatch advanced past the first candidate",
      `offered=${offeredTo.join(",")}`,
    );
    assert(
      new Set(offeredTo).size === offeredTo.length,
      "No candidate is offered the same trip twice",
      `offered=${offeredTo.join(",")}`,
    );
    assert(
      revoked.length === 0,
      "Explicit rejection does not emit offer_revoked",
      `revoked=${revoked.join(",")}`,
    );
    assert(
      pool.every(
        (id) =>
          registry.getDriver(id)?.status === "available" &&
          registry.getDriver(id)?.lockToken === undefined,
      ),
      "Every candidate is released back to available",
      `pool=${pool.map((id) => registry.getDriver(id)?.status).join(",")}`,
    );
    assert(
      sm.getTripByRequestId("req_all_decline")?.status === "cancelled",
      "Trip is cancelled once candidates are exhausted",
      `status=${sm.getTripByRequestId("req_all_decline")?.status}`,
    );
  }

  // 12. Offer order follows ascending distance; notification payload.
  console.log("\n[12. Nearest-First Offer Ordering]");
  {
    const notifications: OfferNotification[] = [];
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => notifications.push(notif),
    });
    registry.registerDriver("driver_far", 37.79, -122.4194, "available");
    registry.registerDriver("driver_near", 37.776, -122.4194, "available");
    registry.registerDriver("driver_closest", 37.7749, -122.4194, "available");

    const submittedAt = Date.now();
    const req = await matching.requestRide({
      requestId: "req_order",
      riderId: "rider_liam",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 60,
    });

    await sleep(450);
    const order = notifications.map((n) => n.driverId).join(",");
    assert(
      order === "driver_closest,driver_near,driver_far",
      "Offers go to the nearest candidate first",
      `offered=${order}`,
    );

    const note = notifications[0];
    assert(note !== undefined, "An offer notification was emitted");
    assert(
      note?.requestId === "req_order",
      "Notification carries the requestId",
      `got=${note?.requestId}`,
    );
    assert(
      note?.tripId === req.trip?.id,
      "Notification carries the trip id",
      `got=${note?.tripId} want=${req.trip?.id}`,
    );
    assert(
      note?.pickup.lat === 37.7749 && note?.dropoff.lat === 37.7833,
      "Notification carries pickup and dropoff",
    );
    assert(
      (note?.distanceMeters ?? 0) < 20,
      "Closest candidate is reported as ~0 m away",
      `got=${note?.distanceMeters}`,
    );
    assert(
      (note?.expiresAt ?? 0) >= submittedAt + 60,
      "expiresAt honours offerTimeoutMs",
      `got=${note?.expiresAt} submitted=${submittedAt}`,
    );
  }

  // 13. maxRadiusMeters and k both bound the candidate set.
  console.log("\n[13. Search Radius And k Cap]");
  {
    const offeredTo: string[] = [];
    const failReasons: string[] = [];
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => offeredTo.push(notif.driverId),
      onMatchFailed: (_requestId, reason) => failReasons.push(reason),
    });
    // ~122 m north of the pickup point.
    registry.registerDriver("driver_outside", 37.776, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_radius",
      riderId: "rider_mia",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      maxRadiusMeters: 50,
      offerTimeoutMs: 80,
    });
    await sleep(40);
    assert(
      offeredTo.length === 0,
      "Candidate outside maxRadiusMeters is never offered",
      `offered=${offeredTo.join(",")}`,
    );
    assert(
      failReasons[0] === "No available drivers in search radius",
      "Radius miss is reported as no drivers in radius",
      `reason=${failReasons[0]}`,
    );

    // Same driver, same rider, radius raised above the actual distance.
    await matching.requestRide({
      requestId: "req_radius_ok",
      riderId: "rider_mia",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 80,
    });
    await sleep(40);
    assert(
      offeredTo[0] === "driver_outside",
      "Same candidate is offered once the radius covers it",
      `offered=${offeredTo.join(",")}`,
    );
    await matching.cancelRide("req_radius_ok", "rider", "section teardown");

    const kOffered: string[] = [];
    let kFailReason: string | null = null;
    const capped = makeFixture({
      onOfferDispatched: (notif) => kOffered.push(notif.driverId),
      onMatchFailed: (_requestId, reason) => {
        kFailReason = reason;
      },
    });
    for (const i of [0, 1, 2]) {
      capped.registry.registerDriver(
        `driver_k${i}`,
        37.7749 + i * 0.0005,
        -122.4194,
        "available",
      );
    }
    await capped.matching.requestRide({
      requestId: "req_kcap",
      riderId: "rider_noah",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      k: 1,
      offerTimeoutMs: 60,
    });
    await sleep(250);
    assert(
      kOffered.length === 1,
      "k limits dispatch to a single candidate",
      `offered=${kOffered.join(",")}`,
    );
    assert(
      kFailReason !== null,
      "Trip fails once the k budget is spent",
      `reason=${kFailReason}`,
    );
  }

  // 14. Two riders racing for one driver: exactly one dispatch wins.
  console.log("\n[14. Two Riders Contend For One Driver]");
  {
    const offeredTo: string[] = [];
    const matchedFor: string[] = [];
    const failedFor: string[] = [];
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => offeredTo.push(notif.driverId),
      onTripMatched: (_trip, driverId) => matchedFor.push(driverId),
      onMatchFailed: (requestId) => failedFor.push(requestId),
    });
    registry.registerDriver("driver_only", 37.7749, -122.4194, "available");

    const pickup = { lat: 37.7749, lng: -122.4194 };
    const dropoff = { lat: 37.7833, lng: -122.4167 };
    const [a, b] = await Promise.all([
      matching.requestRide({
        requestId: "req_racer_a",
        riderId: "rider_olivia",
        pickup,
        dropoff,
        offerTimeoutMs: 400,
      }),
      matching.requestRide({
        requestId: "req_racer_b",
        riderId: "rider_pedro",
        pickup,
        dropoff,
        offerTimeoutMs: 400,
      }),
    ]);
    assert(a.success && b.success, "Both riders entered matching");

    await sleep(60);
    assert(
      offeredTo.length === 1,
      "Only one rider is offered the single driver",
      `offered=${offeredTo.join(",")}`,
    );
    assert(
      failedFor.length === 1,
      "The losing rider is failed exactly once",
      `failed=${failedFor.join(",")}`,
    );

    const offer =
      matching.getActiveOffer("req_racer_a") ??
      matching.getActiveOffer("req_racer_b");
    assert(offer !== undefined, "The winning rider still holds an offer");

    matching.handleDriverResponse(
      "driver_only",
      offer!.requestId,
      "accepted",
    );
    await sleep(40);
    assert(
      matchedFor.length === 1,
      "Trip is matched exactly once",
      `matched=${matchedFor.join(",")}`,
    );
    assert(
      registry.getDriver("driver_only")?.status === "busy",
      "Single driver ends up busy, never double-assigned",
      `status=${registry.getDriver("driver_only")?.status}`,
    );
  }

  // 15. Lease disappears between offer and commit (the commit-failure path).
  console.log("\n[15. Lock Lease Lost Before Commit]");
  {
    const offeredTo: string[] = [];
    const revoked: string[] = [];
    let matchedDriver: string | null = null;
    let failReason: string | null = null;
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => offeredTo.push(notif.driverId),
      onOfferRevoked: (driverId, _requestId, reason) =>
        revoked.push(`${driverId}:${reason}`),
      onTripMatched: (_trip, driverId) => {
        matchedDriver = driverId;
      },
      onMatchFailed: (_requestId, reason) => {
        failReason = reason;
      },
    });
    registry.registerDriver("driver_lease", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_lease_bk", 37.7756, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_lease",
      riderId: "rider_quinn",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 800,
    });
    await sleep(20);
    assert(
      offeredTo[0] === "driver_lease",
      "First candidate holds the open offer",
      `offered=${offeredTo.join(",")}`,
    );

    // Lease expires under the driver while the offer window is still open.
    await registry.releaseLock("driver_lease", "req_lease");
    const late = matching.handleDriverResponse(
      "driver_lease",
      "req_lease",
      "accepted",
    );
    assert(late.success, "Offer still resolves after the lease is gone");

    await sleep(80);
    assert(
      revoked.includes("driver_lease:lock_expired_before_commit"),
      "Commit failure is reported as lock_expired_before_commit",
      `revoked=${revoked.join(",")}`,
    );
    assert(
      offeredTo[1] === "driver_lease_bk",
      "Dispatch falls through to the backup candidate",
      `offered=${offeredTo.join(",")}`,
    );

    matching.handleDriverResponse(
      "driver_lease_bk",
      "req_lease",
      "accepted",
    );
    await sleep(60);
    assert(
      matchedDriver === "driver_lease_bk",
      "Backup candidate matches after the lost lease",
      `matched=${matchedDriver}`,
    );
    assert(
      failReason === null,
      "No match failure once a backup accepts",
      `reason=${failReason}`,
    );
    assert(
      registry.getDriver("driver_lease")?.status === "available",
      "Lease-lost driver is returned to the pool",
      `status=${registry.getDriver("driver_lease")?.status}`,
    );
  }

  // 16. Registry commits but the state machine refuses: driver must roll back.
  console.log("\n[16. Match Rollback When The Driver Is Already Assigned]");
  {
    let matchedAny = false;
    let failReason: string | null = null;
    const { registry, sm, matching } = makeFixture({
      onTripMatched: () => {
        matchedAny = true;
      },
      onMatchFailed: (_requestId, reason) => {
        failReason = reason;
      },
    });

    // Diverge the two subsystems: the state machine already believes the
    // driver owns another trip while the registry still lists it as free.
    const other = sm.createTrip({
      requestId: "req_other_owner",
      riderId: "rider_other",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
    });
    sm.startMatching(other.trip!.id);
    const owner = sm.setMatched(other.trip!.id, "driver_conflict");
    assert(owner.success, "Setup: driver is assigned elsewhere in the SM");
    registry.registerDriver("driver_conflict", 37.7749, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_rollback",
      riderId: "rider_rory",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 300,
    });
    await sleep(20);
    assert(
      matching.getActiveOffer("req_rollback") !== undefined,
      "Driver still receives the offer",
    );

    matching.handleDriverResponse(
      "driver_conflict",
      "req_rollback",
      "accepted",
    );
    await sleep(150);

    assert(
      matchedAny === false,
      "Rollback prevents an invalid match",
      `matchedAny=${matchedAny}`,
    );
    assert(
      failReason === "All candidate drivers declined or timed out",
      "Trip stays unmatched after the rollback",
      `reason=${failReason}`,
    );
    const rolledBack = registry.getDriver("driver_conflict");
    assert(
      rolledBack?.status === "available" && rolledBack?.lockToken === undefined,
      "Rolled-back driver is restored to the pool",
      `status=${rolledBack?.status} lock=${rolledBack?.lockToken}`,
    );
  }

  // 17. Region reset cancels in-flight offers without a phantom match failure.
  console.log("\n[17. Region Reset Cancels In-Flight Work]");
  {
    const revoked: string[] = [];
    let failReason: string | null = null;
    const { registry, sm, matching } = makeFixture({
      onOfferRevoked: (driverId) => revoked.push(driverId),
      onMatchFailed: (_requestId, reason) => {
        failReason = reason;
      },
    });
    registry.registerDriver("driver_reset", 37.7749, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_reset",
      riderId: "rider_sam",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 1500,
    });
    await sleep(20);
    assert(
      matching.getActiveOffer("req_reset") !== undefined,
      "Offer is open before the reset",
    );

    await matching.reset("Operating region was reset");

    assert(
      revoked.includes("driver_reset"),
      "Reset revokes the open offer",
      `revoked=${revoked.join(",")}`,
    );
    assert(
      matching.getActiveOffer("req_reset") === undefined,
      "Reset clears the active offer",
    );
    const resetDriver = registry.getDriver("driver_reset");
    assert(
      resetDriver?.status === "available" && resetDriver?.lockToken === undefined,
      "Reset releases the driver lock",
      `status=${resetDriver?.status} lock=${resetDriver?.lockToken}`,
    );
    assert(
      sm.getTripByRequestId("req_reset")?.status === "cancelled",
      "Reset cancels the active trip",
      `status=${sm.getTripByRequestId("req_reset")?.status}`,
    );
    assert(
      failReason === null,
      "Reset does not report a match failure",
      `reason=${failReason}`,
    );
  }

  // 18. Rematch is only legal from a rematchable trip state.
  console.log("\n[18. Rematch Guard Rails]");
  {
    const { registry, matching } = makeFixture();
    registry.registerDriver("driver_rm", 37.7749, -122.4194, "available");

    const missing = await matching.rematch("trip_does_not_exist", "n/a");
    assert(
      !missing.success && (missing.error ?? "").includes("not found"),
      "Rematch of an unknown trip fails",
      `error=${missing.error}`,
    );

    const req = await matching.requestRide({
      requestId: "req_rematch_guard",
      riderId: "rider_tom",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 500,
    });
    await sleep(20);

    const early = await matching.rematch(req.trip!.id, "too early");
    assert(
      !early.success &&
        (early.error ?? "").includes("already being matched"),
      "Rematch while the trip is still matching is rejected",
      `error=${early.error}`,
    );

    matching.handleDriverResponse("driver_rm", "req_rematch_guard", "accepted");
    await sleep(40);
    await matching.cancelRide("req_rematch_guard", "rider", "changed my mind");

    const afterCancel = await matching.rematch(req.trip!.id, "too late");
    assert(
      !afterCancel.success,
      "Rematch of a cancelled trip is rejected",
      `error=${afterCancel.error}`,
    );
  }

  // 19. cancelRide against missing, matched, and already-cancelled trips.
  console.log("\n[19. cancelRide Edge Cases]");
  {
    const { registry, sm, matching } = makeFixture();
    registry.registerDriver("driver_cx", 37.7749, -122.4194, "available");

    const unknown = await matching.cancelRide("req_never_existed", "rider");
    assert(
      unknown.success,
      "Cancelling an unknown requestId is a no-op success",
      `error=${unknown.error}`,
    );

    await matching.requestRide({
      requestId: "req_cancel_edge",
      riderId: "rider_uma",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 500,
    });
    await sleep(20);
    matching.handleDriverResponse("driver_cx", "req_cancel_edge", "accepted");
    await sleep(40);
    assert(
      sm.getTripByRequestId("req_cancel_edge")?.status === "matched",
      "Setup: trip reaches matched",
      `status=${sm.getTripByRequestId("req_cancel_edge")?.status}`,
    );

    const first = await matching.cancelRide(
      "req_cancel_edge",
      "rider",
      "changed my mind",
    );
    assert(first.success, "Cancelling a matched trip succeeds");
    const cx = registry.getDriver("driver_cx");
    assert(
      cx?.status === "available" && cx?.lockToken === undefined,
      "Cancelling a matched trip releases the driver",
      `status=${cx?.status} lock=${cx?.lockToken}`,
    );

    const second = await matching.cancelRide("req_cancel_edge", "rider");
    assert(
      second.success,
      "Cancelling an already-cancelled trip is an idempotent no-op",
      `error=${second.error}`,
    );
    assert(
      sm.getTripByRequestId("req_cancel_edge")?.status === "cancelled",
      "Double cancel leaves the trip cancelled",
      `status=${sm.getTripByRequestId("req_cancel_edge")?.status}`,
    );
    const released = registry.getDriver("driver_cx");
    assert(
      released?.status === "available" && released?.lockToken === undefined,
      "Double cancel leaves the driver released",
      `status=${released?.status} lock=${released?.lockToken}`,
    );
  }

  // 20. Rider cancel mid-offer must stop the fallback chain entirely.
  console.log("\n[20. Rider Cancel Stops The Fallback Loop]");
  {
    const offeredTo: string[] = [];
    let matchedDriver: string | null = null;
    let failReason: string | null = null;
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => offeredTo.push(notif.driverId),
      onTripMatched: (_trip, driverId) => {
        matchedDriver = driverId;
      },
      onMatchFailed: (_requestId, reason) => {
        failReason = reason;
      },
    });
    registry.registerDriver("driver_wait1", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_wait2", 37.776, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_stop",
      riderId: "rider_vic",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 600,
    });
    await sleep(20);
    assert(
      offeredTo.length === 1,
      "First candidate is offered",
      `offered=${offeredTo.join(",")}`,
    );

    await matching.cancelRide("req_stop", "rider", "no longer needed");
    await sleep(700);

    assert(
      offeredTo.length === 1,
      "No fallback offer is issued after the rider cancels",
      `offered=${offeredTo.join(",")}`,
    );
    assert(
      failReason === null,
      "Cancellation is not reported as a match failure",
      `reason=${failReason}`,
    );
    assert(
      matchedDriver === null,
      "No match is recorded after cancellation",
      `matched=${matchedDriver}`,
    );
    const unused = registry.getDriver("driver_wait2");
    assert(
      unused?.status === "available" && unused?.lockToken === undefined,
      "Unused candidate is never locked",
      `status=${unused?.status}`,
    );
  }

  // 21. Staleness eviction drops the lease under an open offer.
  console.log("\n[21. Driver Evicted While Offer Is Open]");
  {
    const revoked: string[] = [];
    let matchedDriver: string | null = null;
    const { registry, matching } = makeFixture({
      onOfferRevoked: (driverId, _requestId, reason) =>
        revoked.push(`${driverId}:${reason}`),
      onTripMatched: (_trip, driverId) => {
        matchedDriver = driverId;
      },
    });
    registry.registerDriver("driver_stale", 37.7749, -122.4194, "available");
    registry.registerDriver("driver_fresh", 37.7757, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_evict",
      riderId: "rider_wes",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 700,
    });
    await sleep(20);
    assert(
      matching.getActiveOffer("req_evict") !== undefined,
      "Offer is open before eviction",
    );

    // driver_stale stopped heartbeating 5s ago; driver_fresh is current.
    registry.getDriver("driver_stale")!.lastSeen = Date.now() - 5_000;
    const evicted = registry.evictStaleDrivers(1_000);
    assert(
      evicted.length === 1 && evicted[0] === "driver_stale",
      "Only the silent driver is evicted",
      `evicted=${evicted.join(",")}`,
    );

    const accept = matching.handleDriverResponse(
      "driver_stale",
      "req_evict",
      "accepted",
    );
    assert(accept.success, "Late accept still reaches the commit path");

    await sleep(80);
    assert(
      revoked.includes("driver_stale:lock_expired_before_commit"),
      "Evicted driver fails the commit",
      `revoked=${revoked.join(",")}`,
    );
    assert(
      matchedDriver === null,
      "Evicted driver cannot take the trip",
      `matched=${matchedDriver}`,
    );

    matching.handleDriverResponse("driver_fresh", "req_evict", "accepted");
    await sleep(60);
    assert(
      matchedDriver === "driver_fresh",
      "Fresh driver picks up the trip after eviction",
      `matched=${matchedDriver}`,
    );
    assert(
      registry.getDriver("driver_stale")?.status === "offline",
      "Evicted driver stays offline",
      `status=${registry.getDriver("driver_stale")?.status}`,
    );
  }

  // 22. What the gateway actually receives with an offer.
  console.log("\n[22. Offer Notification Payload]");
  {
    let note: OfferNotification | undefined;
    const { registry, matching } = makeFixture({
      onOfferDispatched: (notif) => {
        note = notif;
      },
    });
    // ~122 m north of the pickup point.
    registry.registerDriver("driver_payload", 37.776, -122.4194, "available");

    const submittedAt = Date.now();
    const req = await matching.requestRide({
      requestId: "req_payload",
      riderId: "rider_zoe",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.7833, lng: -122.4167 },
      offerTimeoutMs: 2000,
    });
    await sleep(20);

    assert(note !== undefined, "Offer notification was emitted");
    assert(
      note?.requestId === "req_payload",
      "Notification carries the requestId",
      `got=${note?.requestId}`,
    );
    assert(
      note?.tripId === req.trip?.id,
      "Notification carries the trip id",
      `got=${note?.tripId} want=${req.trip?.id}`,
    );
    assert(
      note?.pickup.lat === 37.7749 && note?.dropoff.lat === 37.7833,
      "Notification carries pickup and dropoff",
    );
    assert(
      (note?.distanceMeters ?? 0) >= 110 && (note?.distanceMeters ?? 0) <= 135,
      "distanceMeters matches the haversine distance",
      `got=${note?.distanceMeters}`,
    );
    assert(
      (note?.expiresAt ?? 0) >= submittedAt + 2000,
      "expiresAt honours offerTimeoutMs",
      `got=${note?.expiresAt} submitted=${submittedAt}`,
    );

    await matching.cancelRide("req_payload", "rider", "section teardown");
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
