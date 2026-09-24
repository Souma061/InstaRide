import { DriverRegistry } from "../../src/core/driver_registry.js";
import { MatchingService } from "../../src/core/matching_service.js";
import { RedisDriverLock } from "../../src/core/redis_driver_lock.js";
import { RedisTripStore } from "../../src/core/redis_trip_store.js";
import { TripStateMachine } from "../../src/core/trip_state_machine.js";
import { connectRedis } from "../../src/infra/redis_client.js";
import { QuadTree } from "../../src/spatial/quadtree.js";

const mode = process.argv[2]; // "mid-offer" | "mid-trip"

async function run() {
  await connectRedis();

  const spatial = new QuadTree(
    { minLat: 12.9, maxLat: 13.0, minLng: 77.6, maxLng: 77.7 },
    8,
    4,
  );
  spatial.insert("Driver_Victim", 12.935, 77.625);

  const lock = new RedisDriverLock();
  const store = new RedisTripStore();
  const registry = new DriverRegistry(spatial, lock);
  registry.registerDriver("Driver_Victim", 12.935, 77.625, "available");
  const sm = new TripStateMachine();

  let activeRequestId = "";

  const matching = new MatchingService(
    registry,
    sm,
    {
      onOfferDispatched: (notif) => {
        activeRequestId = notif.requestId;
        if (mode === "mid-offer") {
          // Tell parent orchestrator: driver is locked, READY TO BE KILLED!
          if (process.send) {
            process.send({
              event: "locked_mid_offer",
              driverId: notif.driverId,
              requestId: notif.requestId,
            });
          }
          // Do not accept or reject; wait to be killed
        } else if (mode === "mid-trip") {
          // Accept immediately to advance trip into matched state
          setTimeout(() => {
            matching.handleDriverResponse(
              notif.driverId,
              notif.requestId,
              "accepted",
            );
          }, 10);
        }
      },
      onTripMatched: (trip, driverId) => {
        if (mode === "mid-trip") {
          // Advance trip to in_progress
          sm.driverEnRoute(trip.id, driverId);
          sm.driverArrived(trip.id, driverId);
          sm.startTrip(trip.id, driverId);
          if (process.send) {
            process.send({
              event: "trip_in_progress",
              tripId: trip.id,
              driverId,
              riderId: trip.riderId,
            });
          }
          // Now wait to be killed mid-trip!
        }
      },
    },
    store,
  );

  await matching.requestRide({
    requestId: `req_victim_${mode}`,
    riderId: `rider_victim_${mode}`,
    pickup: { lat: 12.935, lng: 77.625 },
    dropoff: { lat: 12.98, lng: 77.65 },
    offerTimeoutMs: 500, // Short 500ms timeout for testing TTL auto-expiry
    k: 4,
    maxRadiusMeters: 5000,
  });
}

run().catch((err) => {
  console.error("Crash worker error:", err);
  process.exit(1);
});
