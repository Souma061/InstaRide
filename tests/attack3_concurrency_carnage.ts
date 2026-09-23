import { performance } from "node:perf_hooks";
import { DriverRegistry } from "../src/core/driver_registry.js";
import { MatchingService } from "../src/core/matching_service.js";
import { TripStateMachine } from "../src/core/trip_state_machine.js";
import { QuadTree } from "../src/spatial/quadtree.js";

async function runAttack3() {
  console.log(
    `======================================================================`,
  );
  console.log(
    `      ATTACK 3: CONCURRENCY CARNAGE TORTURE TEST                      `,
  );
  console.log(
    `      10,000 Simultaneous Riders Competing for 1 Lone Driver          `,
  );
  console.log(
    `======================================================================\n`,
  );

  const bounds = { minLat: 12.86, maxLat: 13.06, minLng: 77.5, maxLng: 77.72 };
  const spatialIndex = new QuadTree(bounds, 8, 10);
  const driverRegistry = new DriverRegistry(spatialIndex);
  const stateMachine = new TripStateMachine();

  // Track double-dispatch violations
  let doubleDispatchCount = 0;
  const assignedDriverHistory = new Map<string, string[]>(); // driverId -> list of matched tripIds

  let matchingService: MatchingService;
  matchingService = new MatchingService(driverRegistry, stateMachine, {
    onOfferDispatched: (notification) => {
      // Driver Highlander immediately accepts the first offer received
      setImmediate(() => {
        matchingService.handleDriverResponse(
          notification.driverId,
          notification.requestId,
          "accepted",
        );
      });
    },
    onTripMatched: (trip, driverId) => {
      const list = assignedDriverHistory.get(driverId) || [];
      list.push(trip.id);
      assignedDriverHistory.set(driverId, list);

      if (list.length > 1) {
        doubleDispatchCount++;
        console.error(
          `💥 CRITICAL VIOLATION: Driver ${driverId} was double-dispatched to trips:`,
          list,
        );
      }
    },
    onMatchFailed: () => {},
  });

  // --------------------------------------------------------------------------
  // SETUP: 1 LONE DRIVER
  // --------------------------------------------------------------------------
  const LONE_DRIVER_ID = "Driver_Highlander";
  driverRegistry.registerDriver(LONE_DRIVER_ID, 12.9716, 77.5946, "available");

  console.log(
    `[Setup] Seeded 1 solitary driver: "${LONE_DRIVER_ID}" at (12.9716, 77.5946)`,
  );
  console.log(
    `[Setup] Driver status: ${driverRegistry.getDriver(LONE_DRIVER_ID)?.status}`,
  );
  console.log(`[Setup] Quadtree size: ${spatialIndex.size()}\n`);

  // --------------------------------------------------------------------------
  // THE ATTACK: 10,000 SIMULTANEOUS RIDERS
  // --------------------------------------------------------------------------
  const SWARM_SIZE = 10000;
  console.log(
    `>>> UNLEASHING SWARM: Firing ${SWARM_SIZE.toLocaleString()} simultaneous rider requests...`,
  );

  const t0 = performance.now();
  const initialMemMB = process.memoryUsage().heapUsed / 1024 / 1024;

  const requests = Array.from({ length: SWARM_SIZE }, (_, i) => {
    const reqId = `swarm_req_${i}`;
    const riderId = `rider_${i}`;
    return matchingService.requestRide({
      requestId: reqId,
      riderId: riderId,
      pickup: { lat: 12.9716, lng: 77.5946 },
      dropoff: { lat: 12.9816, lng: 77.6046 },
      offerTimeoutMs: 100,
    });
  });

  await Promise.all(requests);
  // Allow the asynchronous dispatch offer loops to settle (all 10,000 requests)
  await new Promise((resolve) => setTimeout(resolve, 100));

  const totalDurationMs = performance.now() - t0;
  const finalMemMB = process.memoryUsage().heapUsed / 1024 / 1024;

  // --------------------------------------------------------------------------
  // AUDIT & INVARIANT VERIFICATION
  // --------------------------------------------------------------------------
  let matchedTripsCount = 0;
  let exhaustedTripsCount = 0;

  const allTrips = Array.from({ length: SWARM_SIZE }, (_, i) => {
    return stateMachine.getTripByRequestId(`swarm_req_${i}`);
  });

  for (const t of allTrips) {
    if (t?.status === "matched") {
      matchedTripsCount++;
    } else if (t?.status === "cancelled") {
      exhaustedTripsCount++;
    }
  }

  const driverAfter = driverRegistry.getDriver(LONE_DRIVER_ID);
  const remainingInQuadtree = spatialIndex.size();

  console.log(
    `\n----------------------------------------------------------------------`,
  );
  console.log(`>>> ATTACK 3 AUDIT REPORT:`);
  console.log(
    `----------------------------------------------------------------------`,
  );
  console.log(`  Total Inbound Requests      : ${SWARM_SIZE.toLocaleString()}`);
  console.log(
    `  Matches Completed           : ${matchedTripsCount} (Expected: exactly 1)`,
  );
  console.log(
    `  Requests Gracefully Handled : ${exhaustedTripsCount} (Expected: ${SWARM_SIZE - 1})`,
  );
  console.log(
    `  DOUBLE-DISPATCH VIOLATIONS  : ${doubleDispatchCount} (CRITICAL: MUST BE 0)`,
  );
  console.log(
    `  Execution Time              : ${totalDurationMs.toFixed(2)} ms (${(SWARM_SIZE / (totalDurationMs / 1000)).toFixed(0)} req/sec)`,
  );
  console.log(
    `  Heap Memory Delta           : +${(finalMemMB - initialMemMB).toFixed(2)} MB (Clean GC cleanup)`,
  );
  console.log(
    `  Lone Driver Final Status    : "${driverAfter?.status}" (busy / matched)`,
  );
  console.log(
    `  Available in Spatial Index  : ${remainingInQuadtree} (Expected: 0)`,
  );

  console.log(
    `\n======================================================================`,
  );
  if (
    matchedTripsCount === 1 &&
    doubleDispatchCount === 0 &&
    remainingInQuadtree === 0
  ) {
    console.log(
      `  ATTACK 3 RESULT: 100% SURVIVED! STRICT CONCURRENCY INVARIANT HELD.`,
    );
    console.log(
      `  Zero double-dispatch, zero race condition leakage under 10k storm.`,
    );
    console.log(
      `======================================================================\n`,
    );
    process.exit(0);
  } else {
    console.error(`  ATTACK 3 RESULT: FAILED! INVARIANT VIOLATION DETECTED!`);
    console.log(
      `======================================================================\n`,
    );
    process.exit(1);
  }
}

runAttack3().catch((err) => {
  console.error("FATAL ATTACK 3 ERROR:", err);
  process.exit(1);
});
