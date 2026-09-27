import {
  Checker,
  DROPOFF,
  PICKUP,
  TEST_BOUNDS,
  WsTap,
  startServer,
} from "./helpers/e2e_harness.js";

const PORT = Number(process.env.E2E_RIDE_PORT) || 3998;
const RUN = `${Date.now().toString(36)}`;

async function main() {
  console.log("=================================================================");
  console.log("  RIDE MATCHING E2E: real HTTP + WebSocket ride lifecycle");
  console.log("=================================================================\n");

  const c = new Checker();
  const api = await startServer(PORT);
  let obs: WsTap | null = null;

  const resetRegion = async () => {
    const r = await api.post("/simulator/reset", {
      bounds: TEST_BOUNDS,
      driverCount: 0,
      cityName: "E2E Region",
    });
    return r.body;
  };

  const spawn = async (id: string, lat: number, lng: number) =>
    (await api.post("/drivers/spawn", { id, lat, lng })).body;

  const ride = (
    riderId: string,
    requestId: string,
    pickup = PICKUP,
    extra: Record<string, unknown> = {},
  ) =>
    api.post("/rides", { riderId, requestId, pickup, dropoff: DROPOFF, ...extra });

  const respond = (driverId: string, requestId: string, response: string) =>
    api.post("/trips/driver-response", { driverId, requestId, response });

  try {
    const boot = await resetRegion();
    c.section("0. Region Reset");
    c.check(
      "Reset empties the fleet and the spatial index",
      boot.totalDrivers === 0 && boot.quadtreeSize === 0,
      `drivers=${boot.totalDrivers} quadtree=${boot.quadtreeSize}`,
    );

    obs = await WsTap.connect(PORT, "observer");
    await obs.waitFor((m) => m.type === "connected", 10_000, "observer connected");

    // ---------------------------------------------------------------- [1]
    c.section("1. Request Validation Over HTTP");
    {
      const badSpawn = await api.post("/drivers/spawn", { lat: 999, lng: 0 });
      c.check("Spawn rejects out-of-range coordinates", badSpawn.status === 400);

      const outOfRegion = await api.post("/drivers/spawn", {
        lat: 1.0,
        lng: 1.0,
      });
      c.check(
        "Spawn rejects coordinates outside the operating region",
        outOfRegion.status === 400,
        `status=${outOfRegion.status} error=${outOfRegion.body?.error}`,
      );

      const noRider = await api.post("/rides", {
        pickup: PICKUP,
        dropoff: DROPOFF,
      });
      c.check("Ride without riderId is rejected", noRider.status === 400);

      const badPickup = await api.post("/rides", {
        riderId: `${RUN}_rider_bad`,
        pickup: { lat: 999, lng: 0 },
        dropoff: DROPOFF,
      });
      c.check(
        "Ride with invalid pickup is rejected before matching",
        badPickup.status === 400,
        `status=${badPickup.status} error=${badPickup.body?.error}`,
      );

      const missingFields = await api.post("/trips/driver-response", {
        driverId: "x",
      });
      c.check(
        "Driver response missing requestId/response is rejected",
        missingFields.status === 400,
      );

      const badResponse = await api.post("/trips/driver-response", {
        driverId: "x",
        requestId: "y",
        response: "maybe",
      });
      c.check(
        "Driver response other than accept/reject is rejected",
        badResponse.status === 400,
        `status=${badResponse.status} error=${badResponse.body?.error}`,
      );

      const ghost = await respond("nobody", "req_ghost", "accepted");
      c.check(
        "Response against an unknown offer reports OFFER_EXPIRED",
        ghost.status === 200 &&
          ghost.body?.success === false &&
          String(ghost.body?.error).includes("OFFER_EXPIRED"),
        `status=${ghost.status} body=${JSON.stringify(ghost.body)}`,
      );

      const ghostTrip = await api.post("/trips/trip_ghost/driver-action", {
        action: "arrived",
        driverId: "x",
      });
      c.check("Driver action on an unknown trip is 404", ghostTrip.status === 404);
    }

    // ---------------------------------------------------------------- [2]
    c.section("2. No Drivers In The Region");
    {
      await resetRegion();
      const before = obs.count((m) => m.type === "match_failed");
      await ride(`${RUN}_rider_empty`, `${RUN}_req_empty`);

      const failed = await obs.waitFor(
        (m) => m.type === "match_failed" && m.requestId === `${RUN}_req_empty`,
        8_000,
        "match_failed for empty region",
      );
      c.check(
        "Empty fleet reports no available drivers",
        failed.reason === "No available drivers in search radius",
        `reason=${failed.reason}`,
      );
      c.check(
        "Exactly one match_failed event for the request",
        obs.count((m) => m.type === "match_failed") === before + 1,
      );
    }

    // ---------------------------------------------------------------- [3]
    c.section("3. Happy Path And Full Trip Lifecycle");
    {
      await resetRegion();
      await spawn("e2e_d1", PICKUP.lat, PICKUP.lng);

      const riderId = `${RUN}_rider_a`;
      const requestId = `${RUN}_req_a`;
      const riderWs = await WsTap.connect(PORT, "rider", riderId);
      const driverWs = await WsTap.connect(PORT, "driver", "e2e_d1");
      await riderWs.waitFor((m) => m.type === "connected", 5_000, "rider connected");
      await driverWs.waitFor((m) => m.type === "connected", 5_000, "driver connected");

      const started = await ride(riderId, requestId);
      c.check(
        "Ride request is accepted with 202 and a matching trip",
        started.status === 202 && started.body?.trip?.status === "matching",
        `status=${started.status} tripStatus=${started.body?.trip?.status}`,
      );
      const tripId: string = started.body.trip.id;

      const offer = await driverWs.waitFor(
        (m) => m.type === "match_request" && m.requestId === requestId,
        8_000,
        "match_request pushed to the driver socket",
      );
      c.check(
        "Driver socket receives match_request with distance and deadline",
        typeof offer.distanceMeters === "number" &&
          offer.distanceMeters < 20 &&
          offer.expiresAt > Date.now(),
        `distance=${offer.distanceMeters} expiresAt=${offer.expiresAt}`,
      );
      c.check(
        "Offer carries the trip route",
        offer.pickup?.lat === PICKUP.lat && offer.dropoff?.lng === DROPOFF.lng,
      );

      const accept = await respond("e2e_d1", requestId, "accepted");
      c.check("Driver accept is acknowledged", accept.body?.success === true);

      const double = await respond("e2e_d1", requestId, "accepted");
      c.check(
        "Duplicate accept reports OFFER_EXPIRED",
        double.body?.success === false &&
          String(double.body?.error).includes("OFFER_EXPIRED"),
        `body=${JSON.stringify(double.body)}`,
      );

      const matchedEvent = await obs.waitFor(
        (m) =>
          m.type === "trip_event" &&
          m.requestId === requestId &&
          m.status === "matched",
        8_000,
        "trip_event matched",
      );
      c.check(
        "Observer sees the trip matched to the right driver",
        matchedEvent.driverId === "e2e_d1",
        `driverId=${matchedEvent.driverId}`,
      );

      const riderStatus = await riderWs.waitFor(
        (m) => m.type === "ride_status" && m.status === "matched",
        5_000,
        "ride_status matched",
      );
      c.check(
        "Rider socket is told the trip is matched",
        riderStatus.driverId === "e2e_d1" && riderStatus.tripId === tripId,
        `driverId=${riderStatus.driverId} tripId=${riderStatus.tripId}`,
      );

      let st = await api.driverStatus("e2e_d1", PICKUP.lat, PICKUP.lng);
      c.check("Assigned driver reports busy", st.status === "busy", `status=${st.status}`);
      c.check(
        "Locked driver is out of the spatial index",
        st.quadtreeSize === 0,
        `quadtree=${st.quadtreeSize}`,
      );

      const wrongDriver = await api.post(`/trips/${tripId}/driver-action`, {
        action: "arrived",
        driverId: "someone_else",
      });
      c.check(
        "Only the assigned driver may act on the trip",
        wrongDriver.status === 403,
        `status=${wrongDriver.status}`,
      );

      const badAction = await api.post(`/trips/${tripId}/driver-action`, {
        action: "teleport",
        driverId: "e2e_d1",
      });
      c.check("Unknown driver action is rejected", badAction.status === 400);

      const arrived = await api.post(`/trips/${tripId}/driver-action`, {
        action: "arrived",
        driverId: "e2e_d1",
      });
      c.check("Driver can mark arrival", arrived.status === 200 && arrived.body?.success === true);

      const startedTrip = await api.post(`/trips/${tripId}/driver-action`, {
        action: "start_trip",
        driverId: "e2e_d1",
      });
      c.check(
        "Driver can start the trip",
        startedTrip.status === 200 && startedTrip.body?.success === true,
        `status=${startedTrip.status} body=${JSON.stringify(startedTrip.body)}`,
      );

      const completed = await api.post(`/trips/${tripId}/driver-action`, {
        action: "complete_trip",
        driverId: "e2e_d1",
      });
      c.check(
        "Driver can complete the trip",
        completed.status === 200 && completed.body?.success === true,
        `status=${completed.status} body=${JSON.stringify(completed.body)}`,
      );

      const statuses = obs
        .ofType("trip_event")
        .filter((m) => m.requestId === requestId)
        .map((m) => m.status);
      c.check(
        "Observer saw the full lifecycle: matching -> matched -> arrived -> in_progress -> completed",
        ["matching", "matched", "arrived", "in_progress", "completed"].every(
          (s) => statuses.includes(s),
        ),
        `statuses=${statuses.join(">")}`,
      );

      st = await api.driverStatus("e2e_d1", PICKUP.lat, PICKUP.lng);
      c.check(
        "Driver returns to available after completion",
        st.status === "available",
        `status=${st.status}`,
      );
      c.check(
        "Driver is back in the spatial index with no lock leak",
        st.quadtreeSize === 1,
        `quadtree=${st.quadtreeSize}`,
      );

      riderWs.close();
      driverWs.close();
    }

    // ---------------------------------------------------------------- [4]
    c.section("4. Rejection Falls Back To The Next Driver");
    {
      await resetRegion();
      await spawn("e2e_near", PICKUP.lat, PICKUP.lng);
      await spawn("e2e_far", PICKUP.lat + 0.0015, PICKUP.lng);

      const riderId = `${RUN}_rider_b`;
      const requestId = `${RUN}_req_b`;
      const res = await ride(riderId, requestId);
      const tripId = res.body.trip.id;

      const first = await obs.waitFor(
        (m) => m.type === "offer_dispatched" && m.requestId === requestId,
        8_000,
        "first offer",
      );
      c.check(
        "Nearest driver is offered first",
        first.driverId === "e2e_near",
        `driverId=${first.driverId}`,
      );

      const reject = await respond("e2e_near", requestId, "rejected");
      c.check("Rejection is acknowledged", reject.body?.success === true);

      const second = await obs.waitFor(
        (m) =>
          m.type === "offer_dispatched" &&
          m.requestId === requestId &&
          m.driverId === "e2e_far",
        8_000,
        "fallback offer",
      );
      c.check(
        "Dispatch falls through to the next nearest driver",
        second.driverId === "e2e_far",
        `driverId=${second.driverId}`,
      );

      await respond("e2e_far", requestId, "accepted");
      const matched = await obs.waitFor(
        (m) =>
          m.type === "trip_event" &&
          m.requestId === requestId &&
          m.status === "matched",
        8_000,
        "trip matched after fallback",
      );
      c.check(
        "Trip is matched to the fallback driver",
        matched.driverId === "e2e_far",
        `driverId=${matched.driverId} trip=${tripId}`,
      );

      const near = await api.driverStatus("e2e_near", PICKUP.lat, PICKUP.lng);
      c.check(
        "Rejecting driver is released back to the pool",
        near.status === "available",
        `status=${near.status}`,
      );
    }

    // ---------------------------------------------------------------- [5]
    c.section("5. Silent Driver Hits The Offer Deadman Switch");
    {
      await resetRegion();
      await spawn("e2e_silent", PICKUP.lat, PICKUP.lng);

      const riderId = `${RUN}_rider_c`;
      const requestId = `${RUN}_req_c`;
      await ride(riderId, requestId, PICKUP, { offerTimeoutMs: 1000 });

      await obs.waitFor(
        (m) => m.type === "offer_dispatched" && m.requestId === requestId,
        8_000,
        "offer dispatched",
      );
      const revoked = await obs.waitFor(
        (m) => m.type === "offer_revoked" && m.requestId === requestId,
        10_000,
        "offer_revoked",
      );
      c.check(
        "Offer is revoked once the driver goes silent",
        revoked.reason === "Offer timed out",
        `reason=${revoked.reason}`,
      );

      const failed = await obs.waitFor(
        (m) => m.type === "match_failed" && m.requestId === requestId,
        10_000,
        "match_failed after timeout",
      );
      c.check(
        "Failure reason names declined or timed-out drivers",
        failed.reason === "All candidate drivers declined or timed out",
        `reason=${failed.reason}`,
      );

      const silent = await api.driverStatus("e2e_silent", PICKUP.lat, PICKUP.lng);
      c.check(
        "Timed-out driver is released back to the pool",
        silent.status === "available",
        `status=${silent.status}`,
      );
      c.check(
        "Released driver is back in the spatial index",
        silent.quadtreeSize === 1,
        `quadtree=${silent.quadtreeSize}`,
      );
    }

    // ---------------------------------------------------------------- [6]
    c.section("6. Rider Cancellation");
    {
      await resetRegion();
      await spawn("e2e_cancel", PICKUP.lat, PICKUP.lng);

      const riderId = `${RUN}_rider_d`;
      const requestId = `${RUN}_req_d`;
      const riderWs = await WsTap.connect(PORT, "rider", riderId);
      await riderWs.waitFor((m) => m.type === "connected", 5_000, "rider connected");

      const res = await ride(riderId, requestId);
      const tripId: string = res.body.trip.id;
      await obs.waitFor(
        (m) => m.type === "offer_dispatched" && m.requestId === requestId,
        8_000,
        "offer before cancel",
      );

      const wrongRider = await api.post(`/rides/${tripId}/cancel`, {
        riderId: `${RUN}_someone_else`,
      });
      c.check(
        "Another rider cannot cancel the trip",
        wrongRider.status === 403,
        `status=${wrongRider.status}`,
      );

      const ghost = await api.post(`/rides/trip_ghost/cancel`, { riderId });
      c.check("Cancelling an unknown trip is 404", ghost.status === 404);

      const cancel = await api.post(`/rides/${tripId}/cancel`, {
        riderId,
        reason: "changed my mind",
      });
      c.check(
        "The trip's own rider can cancel it",
        cancel.status === 200 && cancel.body?.success === true,
        `status=${cancel.status} body=${JSON.stringify(cancel.body)}`,
      );

      const cancelledEvent = await obs.waitFor(
        (m) =>
          m.type === "trip_event" &&
          m.requestId === requestId &&
          m.status === "cancelled",
        8_000,
        "trip cancelled",
      );
      c.check(
        "Cancellation reaches the observer stream",
        cancelledEvent.tripId === tripId,
        `tripId=${cancelledEvent.tripId}`,
      );

      const driver = await api.driverStatus("e2e_cancel", PICKUP.lat, PICKUP.lng);
      c.check(
        "Cancellation releases the driver's lock",
        driver.status === "available" && driver.quadtreeSize === 1,
        `status=${driver.status} quadtree=${driver.quadtreeSize}`,
      );

      const matchedAfterCancel = obs.count(
        (m) =>
          m.type === "trip_event" &&
          m.requestId === requestId &&
          m.status === "matched",
      );
      c.check(
        "Cancelled trip is never matched afterwards",
        matchedAfterCancel === 0,
        `matchedEvents=${matchedAfterCancel}`,
      );

      riderWs.close();
    }

    // ---------------------------------------------------------------- [7]
    c.section("7. Idempotent Re-Submission And Rider Limits");
    {
      await resetRegion();
      await spawn("e2e_idem", PICKUP.lat, PICKUP.lng);

      const riderId = `${RUN}_rider_e`;
      const requestId = `${RUN}_req_e`;

      const first = await ride(riderId, requestId);
      c.check("First submission is accepted", first.status === 202);
      const tripId: string = first.body.trip.id;

      const replay = await ride(riderId, requestId);
      c.check(
        "Same requestId replays the original trip",
        replay.status === 202 && replay.body.trip.id === tripId,
        `status=${replay.status} tripId=${replay.body?.trip?.id} want=${tripId}`,
      );

      const blocked = await ride(riderId, `${RUN}_req_e2`);
      c.check(
        "A rider with an open trip cannot start a second one",
        blocked.status === 409,
        `status=${blocked.status} error=${blocked.body?.error}`,
      );

      const cancel = await api.post(`/rides/${tripId}/cancel`, { riderId });
      c.check(
        "Cleanup cancel succeeds",
        cancel.status === 200 && cancel.body?.success === true,
      );
    }

    // ---------------------------------------------------------------- [8]
    c.section("8. Concurrent Riders Contend For One Driver");
    {
      await resetRegion();
      await spawn("e2e_solo", PICKUP.lat, PICKUP.lng);

      const obsBefore = obs.ofType("offer_dispatched").length;
      const riderA = `${RUN}_rider_f1`;
      const riderB = `${RUN}_rider_f2`;
      const reqA = `${RUN}_req_f1`;
      const reqB = `${RUN}_req_f2`;

      const [a, b] = await Promise.all([
        ride(riderA, reqA),
        ride(riderB, reqB),
      ]);
      c.check("Both riders are accepted into matching", a.status === 202 && b.status === 202);

      const failedId = await obs.waitFor(
        (m) => m.type === "match_failed" && (m.requestId === reqA || m.requestId === reqB),
        8_000,
        "one rider must lose the race",
      );

      // The loser's match_failed can reach the observer before the winner's
      // offer_dispatched (the offer goes out after a Redis round-trip), so
      // wait for it explicitly. Timing out here means nobody was ever offered
      // the driver — a real dispatch bug, not a test race.
      await obs.waitFor(
        (m) => m.type === "offer_dispatched" && m.driverId === "e2e_solo",
        8_000,
        "winner's offer for the contended driver",
      );

      const offers = obs
        .ofType("offer_dispatched")
        .slice(obsBefore)
        .filter((m) => m.driverId === "e2e_solo");
      c.check(
        "The single driver is offered to exactly one rider",
        offers.length === 1,
        `offers=${offers.length}`,
      );
      c.check(
        "The losing rider is the one reported as failed",
        offers.length === 1 && failedId.requestId !== offers[0].requestId,
        `failed=${failedId.requestId} offered=${offers[0]?.requestId}`,
      );

      const offerId: string | undefined = offers[0]?.requestId;
      if (offerId) {
        const accept = await respond("e2e_solo", offerId, "accepted");
        c.check("The winning rider's accept succeeds", accept.body?.success === true);

        await obs.waitFor(
          (m) =>
            m.type === "trip_event" &&
            m.requestId === offerId &&
            m.status === "matched",
          8_000,
          "winning trip matched",
        );
      }

      const solo = await api.driverStatus("e2e_solo", PICKUP.lat, PICKUP.lng);
      c.check(
        "Contended driver ends busy rather than double-assigned",
        solo.status === "busy",
        `status=${solo.status}`,
      );
      c.check(
        "Committed driver is held out of the spatial index",
        solo.quadtreeSize === 0,
        `quadtree=${solo.quadtreeSize}`,
      );
    }
  } finally {
    obs?.close();
    await api.stop();
  }

  c.done();
}

main().catch((err) => {
  console.error("E2E ride matching runner error:", err);
  process.exit(1);
});
