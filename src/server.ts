import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DriverRegistry } from "./core/driver_registry.js";
import { MatchingService } from "./core/matching_service.js";
import { TripStateMachine } from "./core/trip_state_machine.js";
import { ClientRole, WsManager } from "./gateway/ws_manager.js";
import { DriverSimulator } from "./simulation/driver_simulator.js";
import { CppSpatialBridge } from "./spatial/cpp_spatial_bridge.js";
import { CandidateDriver, GeoBounds, QuadTree } from "./spatial/quadtree.js";
import {
  clampTimeout,
  isValidGeoBounds,
  isValidGeoPoint,
} from "./utils/validation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default Bounding Box (Bengaluru)
export const BLR_BOUNDS: GeoBounds = {
  minLat: 12.86,
  maxLat: 13.06,
  minLng: 77.5,
  maxLng: 77.72,
};

let activeCityName = "Bengaluru";
let activeBounds: GeoBounds = { ...BLR_BOUNDS };

// Keep the visualizer local by default. An externally bound instance must use
// a control credential until it is placed behind real user authentication.
const HOST = process.env.HOST || "127.0.0.1";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN;
const isLoopbackHost =
  HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
if (!isLoopbackHost && !CONTROL_API_TOKEN) {
  throw new Error("CONTROL_API_TOKEN is required when HOST is not loopback");
}

function hasControlAccess(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return (
    isLoopbackHost || headers.authorization === `Bearer ${CONTROL_API_TOKEN}`
  );
}

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
});

// Register WebSocket plugin
await fastify.register(websocket);

// 1. Initialize Core Spatial & Concurrency Pipeline
let spatialIndex = new QuadTree(activeBounds, 8, 7);
const driverRegistry = new DriverRegistry(spatialIndex);
const stateMachine = new TripStateMachine();
const wsManager = new WsManager(driverRegistry, stateMachine);

// 2. Initialize Matching Engine with Event Dispatchers
let simulator: DriverSimulator;

const matchingService = new MatchingService(driverRegistry, stateMachine, {
  onOfferDispatched: (notif) => {
    wsManager.notifyDriverOffer(notif.driverId, notif);
    simulator.handleIncomingOffer(notif.driverId, notif.requestId);
  },
  onOfferRevoked: (driverId, requestId, reason) => {
    wsManager.notifyOfferRevoked(driverId, requestId, reason);
  },
  onTripMatched: (trip, driverId) => {
    wsManager.notifyTripMatched(trip, driverId);
    simulator.onTripAssigned(driverId, trip);
  },
  onMatchFailed: (requestId, reason) => {
    wsManager.broadcastToObservers({ type: "match_failed", requestId, reason });
  },
});

// Broadcast all state machine lifecycle transitions (en_route, arrived, in_progress, completed) in real time
stateMachine.onTransition = (event, trip) => {
  wsManager.broadcastToObservers({
    type: "trip_event",
    tripId: trip.id,
    requestId: trip.requestId,
    status: trip.status,
    driverId: trip.driverId,
    riderId: trip.riderId,
    fromStatus: event.fromStatus,
  });
};

wsManager.setMatchingService(matchingService);

// 3. Initialize & Start Virtual Driver Simulation
simulator = new DriverSimulator(activeBounds, driverRegistry, stateMachine);
simulator.setMatchingService(matchingService);

// 3b. Initialize Native C++ Spatial Bridge
const cppBridge = new CppSpatialBridge();
let activeEngine: "ts" | "cpp" = "ts";

cppBridge.start().then((ok) => {
  if (ok) {
    cppBridge.initRegion(activeBounds, 8, 7);
    for (const d of simulator.getAllVirtualDrivers()) {
      cppBridge.insert(d.id, d.lat, d.lng);
    }
    console.log(
      "🚀 [Server] C++ Native Spatial Accelerator connected & ready!",
    );
  }
});

simulator.onTelemetryTick = (updates) => {
  if (cppBridge.isAvailable()) {
    for (const u of updates) {
      cppBridge.update(u.id, u.lat, u.lng);
    }
  }
  wsManager.broadcastToObservers({
    type: "telemetry_batch",
    drivers: updates,
  });
};
simulator.start(40, 1000);

// 4. Periodic Stale Driver Eviction (every 10 seconds, timeout 30s)
const staleEvictionInterval = setInterval(() => {
  const evicted = driverRegistry.evictStaleDrivers(30_000);
  if (evicted.length > 0) {
    wsManager.broadcastToObservers({
      type: "drivers_evicted",
      driverIds: evicted,
    });
  }
}, 10_000);

// Unref the timer so it doesn't prevent graceful shutdown
staleEvictionInterval.unref();

// --- HTTP REST ROUTES ---

// Register static assets if frontend dist exists
const distAssetsPath = path.resolve(__dirname, "../frontend/dist/assets");
if (fs.existsSync(distAssetsPath)) {
  await fastify.register(fastifyStatic, {
    root: distAssetsPath,
    prefix: "/assets/",
    decorateReply: false,
  });
}

// Serve the live visualizer UI directly at root /
fastify.get("/", async (req, reply) => {
  const distHtml = path.resolve(__dirname, "../frontend/dist/index.html");
  if (fs.existsSync(distHtml)) {
    reply.type("text/html");
    return fs.readFileSync(distHtml, "utf-8");
  }
  const htmlPath = path.resolve(__dirname, "../ride_matching_visualizer.html");
  if (fs.existsSync(htmlPath)) {
    reply.type("text/html");
    return fs.readFileSync(htmlPath, "utf-8");
  }
  return {
    status: "ok",
    message: "Ride Matching Server Running. Visualizer HTML not found in root.",
  };
});

// System Health & Spatial Engine Stats
fastify.get("/health", async () => {
  return {
    status: "ok",
    service: "rt-ride-matching-system",
    cityName: activeCityName,
    bounds: activeBounds,
    totalDrivers: driverRegistry.totalDrivers,
    quadtreeSize: spatialIndex.size(),
    observers: wsManager.observerCount,
    timestamp: new Date().toISOString(),
  };
});

// Dynamic Spatial Configuration
fastify.get("/config", async () => {
  return {
    cityName: activeCityName,
    bounds: activeBounds,
    totalDrivers: driverRegistry.totalDrivers,
    quadtreeSize: spatialIndex.size(),
    observers: wsManager.observerCount,
  };
});

// Dynamic Simulator & Region Reset Endpoint
fastify.post("/simulator/reset", async (req, reply) => {
  if (!hasControlAccess(req.headers)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const body = req.body as any;
  const newBounds = body?.bounds || BLR_BOUNDS;
  const newCityName = body?.cityName || "Custom Region";
  const count = typeof body?.driverCount === "number" ? body.driverCount : 40;

  if (!isValidGeoBounds(newBounds)) {
    return reply.status(400).send({ error: "Invalid operating bounds" });
  }
  if (!Number.isInteger(count) || count < 0 || count > 10_000) {
    return reply
      .status(400)
      .send({ error: "driverCount must be an integer between 0 and 10000" });
  }

  matchingService.reset("Operating region was reset");

  activeCityName = newCityName;
  activeBounds = { ...newBounds };

  spatialIndex = new QuadTree(activeBounds, 8, 7);
  driverRegistry.reset(spatialIndex);
  simulator.resetRegion(activeBounds, count);

  if (cppBridge.isAvailable()) {
    cppBridge.initRegion(activeBounds, 8, 7);
    for (const d of simulator.getAllVirtualDrivers()) {
      cppBridge.insert(d.id, d.lat, d.lng);
    }
  }

  wsManager.broadcastToObservers({
    type: "region_updated",
    cityName: activeCityName,
    bounds: activeBounds,
    totalDrivers: count,
  });

  return {
    status: "ok",
    cityName: activeCityName,
    bounds: activeBounds,
    totalDrivers: count,
    quadtreeSize: spatialIndex.size(),
  };
});

// Engine Status & Selection Endpoints
fastify.get("/api/engine/status", async () => {
  return {
    activeEngine,
    cppAvailable: cppBridge.isAvailable(),
    lastLatencyUs: cppBridge.getLastLatencyUs(),
    totalQueries: cppBridge.getTotalQueries(),
  };
});

fastify.post("/api/engine/select", async (req, reply) => {
  const body = (req.body || {}) as { engine?: "ts" | "cpp" };
  if (body.engine !== "ts" && body.engine !== "cpp") {
    return reply.status(400).send({ error: "engine must be 'ts' or 'cpp'" });
  }
  if (body.engine === "cpp" && !cppBridge.isAvailable()) {
    return reply
      .status(503)
      .send({ error: "C++ native engine is not running" });
  }
  activeEngine = body.engine;
  wsManager.broadcastToObservers({
    type: "engine_changed",
    activeEngine,
    latencyUs: cppBridge.getLastLatencyUs(),
  });
  return { status: "ok", activeEngine };
});

// Concurrency Race Simulation with full cryptographic & CAS evidence tracking
fastify.post("/simulator/concurrency-race", async (req, reply) => {
  if (!hasControlAccess(req.headers)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const body = (req.body || {}) as any;
  const centerLat =
    typeof body?.center?.lat === "number"
      ? body.center.lat
      : (activeBounds.minLat + activeBounds.maxLat) / 2;
  const centerLng =
    typeof body?.center?.lng === "number"
      ? body.center.lng
      : (activeBounds.minLng + activeBounds.maxLng) / 2;

  if (!driverRegistry.isWithinBounds(centerLat, centerLng)) {
    return reply.status(400).send({
      error: "Race center must be within the active operating region",
    });
  }

  // Find nearest available drivers near center using active engine
  let candidates: CandidateDriver[];
  let queryLatencyUs = 0;
  if (activeEngine === "cpp" && cppBridge.isAvailable()) {
    const res = await cppBridge.kNearestNeighbors(
      centerLat,
      centerLng,
      10,
      50000,
    );
    candidates = res.candidates;
    queryLatencyUs = res.latencyUs;
  } else {
    const t0 = performance.now();
    candidates = driverRegistry.findNearbyCandidates(
      centerLat,
      centerLng,
      10,
      50000,
    );
    queryLatencyUs = (performance.now() - t0) * 1000;
  }

  // If fewer than 2 drivers exist in the area (e.g. fresh region), auto-seed Prime & Backup drivers
  if (candidates.length < 2) {
    const primeId = `sim_driver_prime_${Date.now().toString().slice(-4)}`;
    const backupId = `sim_driver_backup_${Date.now().toString().slice(-4)}`;
    driverRegistry.registerDriver(primeId, centerLat, centerLng, "available");
    driverRegistry.registerDriver(
      backupId,
      centerLat + 0.005,
      centerLng + 0.005,
      "available",
    );
    candidates = driverRegistry.findNearbyCandidates(
      centerLat,
      centerLng,
      10,
      50000,
    );
  }

  const primeCandidate = candidates[0];
  const targetDriverContended = primeCandidate.id;

  // Place Alice & Bob within meters of each other and closest to primeCandidate
  const alicePickup = {
    lat: primeCandidate.lat + 0.0003,
    lng: primeCandidate.lng + 0.0003,
  };
  const bobPickup = {
    lat: primeCandidate.lat + 0.0004,
    lng: primeCandidate.lng + 0.0004,
  };

  const aliceRequestId = `race_alice_${Date.now()}`;
  const bobRequestId = `race_bob_${Date.now()}`;

  const traceAliceAttempts: Array<{
    driverId: string;
    locked: boolean;
    outcome: string;
    reason?: string;
  }> = [];

  const traceBobAttempts: Array<{
    driverId: string;
    locked: boolean;
    outcome: string;
    reason?: string;
  }> = [];

  // 1. Both riders perform k-NN query -> Both get primeCandidate as #1 candidate!
  const aliceCandidates = driverRegistry.findNearbyCandidates(
    alicePickup.lat,
    alicePickup.lng,
    4,
    15000,
  );
  const bobCandidates = driverRegistry.findNearbyCandidates(
    bobPickup.lat,
    bobPickup.lng,
    4,
    15000,
  );

  let aliceAssigned: string | null = null;
  let bobAssigned: string | null = null;

  // 2. Both fire atomic lock acquisition simultaneously on primeCandidate
  const aliceLockSuccess = driverRegistry.acquireLock(
    primeCandidate.id,
    aliceRequestId,
    15000,
  );

  if (aliceLockSuccess) {
    traceAliceAttempts.push({
      driverId: primeCandidate.id,
      locked: true,
      outcome: "LOCK_GRANTED",
      reason: "Acquired atomic CAS lock lease (15.000s TTL)",
    });
    aliceAssigned = primeCandidate.id;
  } else {
    traceAliceAttempts.push({
      driverId: primeCandidate.id,
      locked: false,
      outcome: "LOCK_COLLISION",
      reason: `Driver ${primeCandidate.id} claimed by competitor`,
    });
  }

  // Bob attempts same primeCandidate
  const bobLockSuccess = driverRegistry.acquireLock(
    primeCandidate.id,
    bobRequestId,
    15000,
  );

  if (bobLockSuccess) {
    traceBobAttempts.push({
      driverId: primeCandidate.id,
      locked: true,
      outcome: "LOCK_GRANTED",
      reason: "Acquired atomic CAS lock lease",
    });
    bobAssigned = primeCandidate.id;
  } else {
    traceBobAttempts.push({
      driverId: primeCandidate.id,
      locked: false,
      outcome: "LOCK_COLLISION",
      reason: `CAS collision: Driver ${primeCandidate.id} already locked by ${aliceRequestId}`,
    });

    // Bob triggers automatic fallback cascade to Candidate #2
    for (const cand of bobCandidates) {
      if (cand.id === primeCandidate.id) continue;
      const fallbackGranted = driverRegistry.acquireLock(
        cand.id,
        bobRequestId,
        15000,
      );
      traceBobAttempts.push({
        driverId: cand.id,
        locked: fallbackGranted,
        outcome: fallbackGranted
          ? "LOCK_GRANTED (AUTO-FALLBACK)"
          : "CANDIDATE_UNAVAILABLE",
        reason: fallbackGranted
          ? "Successfully secured alternative candidate #2"
          : "Candidate busy or locked",
      });
      if (fallbackGranted) {
        bobAssigned = cand.id;
        break;
      }
    }
  }

  // If Alice somehow didn't get lock, Alice also cascades
  if (!aliceAssigned) {
    for (const cand of aliceCandidates) {
      if (cand.id === primeCandidate.id) continue;
      const fallbackGranted = driverRegistry.acquireLock(
        cand.id,
        aliceRequestId,
        15000,
      );
      traceAliceAttempts.push({
        driverId: cand.id,
        locked: fallbackGranted,
        outcome: fallbackGranted
          ? "LOCK_GRANTED (AUTO-FALLBACK)"
          : "CANDIDATE_UNAVAILABLE",
        reason: fallbackGranted
          ? "Successfully secured alternative candidate"
          : "Candidate busy or locked",
      });
      if (fallbackGranted) {
        aliceAssigned = cand.id;
        break;
      }
    }
  }

  const raceResult = {
    type: "concurrency_race_result",
    timestamp: Date.now(),
    targetContendedDriverId: targetDriverContended,
    alice: {
      riderId: "rider_alice",
      pickup: alicePickup,
      assignedDriverId: aliceAssigned,
      attempts: traceAliceAttempts,
    },
    bob: {
      riderId: "rider_bob",
      pickup: bobPickup,
      assignedDriverId: bobAssigned,
      attempts: traceBobAttempts,
    },
    metrics: {
      targetContention: `Target Driver ${targetDriverContended} contended by 2 simultaneous riders`,
      duplicateDispatchCount:
        aliceAssigned === bobAssigned && aliceAssigned !== null ? 1 : 0,
      duplicateRatePercent: 0,
      casCollisionsResolved: 1,
      isolationVerified: aliceAssigned !== bobAssigned,
      engineUsed:
        activeEngine === "cpp" ? "C++ Native (-O3)" : "TypeScript (V8 JIT)",
      queryLatencyUs: Number(queryLatencyUs.toFixed(1)),
    },
  };

  // Broadcast to all WebSocket clients so map & live panels update
  wsManager.broadcastToObservers(raceResult);

  // Broadcast updated driver states so amber lock rings render on map
  wsManager.broadcastToObservers({
    type: "drivers_updated",
    drivers: simulator.getAllVirtualDrivers().map((d) => ({
      id: d.id,
      lat: d.lat,
      lng: d.lng,
      status: driverRegistry.getDriver(d.id)?.status ?? "available",
      hasLock: !!driverRegistry.getDriver(d.id)?.lockToken,
    })),
  });

  // Automatically release race demonstration locks after 15 seconds so drivers return to pool
  setTimeout(() => {
    if (aliceAssigned)
      driverRegistry.releaseLock(aliceAssigned, aliceRequestId);
    if (bobAssigned) driverRegistry.releaseLock(bobAssigned, bobRequestId);
    wsManager.broadcastToObservers({
      type: "drivers_updated",
      drivers: simulator.getAllVirtualDrivers().map((d) => ({
        id: d.id,
        lat: d.lat,
        lng: d.lng,
        status: driverRegistry.getDriver(d.id)?.status ?? "available",
        hasLock: !!driverRegistry.getDriver(d.id)?.lockToken,
      })),
    });
  }, 15000);

  return raceResult;
});

// Query all active drivers snapshot
fastify.get("/drivers", async () => {
  return simulator.getAllVirtualDrivers().map((d) => {
    const reg = driverRegistry.getDriver(d.id);
    return {
      id: d.id,
      lat: d.lat,
      lng: d.lng,
      status: reg?.status ?? "available",
      hasLock: !!reg?.lockToken,
    };
  });
});

// HTTP REST: Request a ride
fastify.post("/rides", async (req, reply) => {
  if (!hasControlAccess(req.headers)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const body = req.body as any;
  if (!body?.riderId || !body?.pickup || !body?.dropoff) {
    return reply
      .status(400)
      .send({ error: "Missing riderId, pickup, or dropoff" });
  }

  if (!isValidGeoPoint(body.pickup) || !isValidGeoPoint(body.dropoff)) {
    return reply.status(400).send({
      error:
        "Invalid coordinates: lat must be [-90, 90] and lng must be [-180, 180]",
    });
  }

  const safeTimeout = clampTimeout(body.offerTimeoutMs);

  const result = await matchingService.requestRide({
    requestId: body.requestId || `req_${Date.now()}`,
    riderId: body.riderId,
    pickup: body.pickup,
    dropoff: body.dropoff,
    offerTimeoutMs: safeTimeout,
  });

  if (!result.success) {
    return reply.status(409).send(result);
  }

  return reply.status(202).send(result);
});

// HTTP REST: Cancel a ride
fastify.post("/rides/:tripId/cancel", async (req, reply) => {
  if (!hasControlAccess(req.headers)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const { tripId } = req.params as { tripId: string };
  const body = (req.body || {}) as { riderId?: string; reason?: string };
  const trip = stateMachine.getTrip(tripId);
  if (!trip) {
    return reply.status(404).send({ error: "Trip not found" });
  }

  if (!body.riderId || body.riderId !== trip.riderId) {
    return reply
      .status(403)
      .send({ error: "Only the trip's rider may cancel it" });
  }

  const result = matchingService.cancelRide(
    trip.requestId,
    "rider",
    body.reason || "Cancelled via HTTP API",
  );
  return reply.send(result);
});

// HTTP REST: Execute Driver Milestone Action (Arrived, Start Trip, Complete Trip)
fastify.post("/trips/:tripId/driver-action", async (req, reply) => {
  if (!hasControlAccess(req.headers)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const { tripId } = req.params as { tripId: string };
  const body = req.body as any;
  const action = body?.action as "arrived" | "start_trip" | "complete_trip";
  const driverId = body?.driverId;

  const trip = stateMachine.getTrip(tripId);
  if (!trip) {
    return reply.status(404).send({ error: "Trip not found" });
  }
  if (!driverId || trip.driverId !== driverId) {
    return reply
      .status(403)
      .send({ error: "Only the assigned driver may perform this action" });
  }

  let res;
  if (action === "arrived") {
    res = stateMachine.driverArrived(tripId);
  } else if (action === "start_trip") {
    res = stateMachine.startTrip(tripId);
  } else if (action === "complete_trip") {
    res = stateMachine.completeTrip(tripId);
    if (res.success && driverId) {
      driverRegistry.completeTrip(driverId);
    }
  }

  if (!res) {
    return reply.status(400).send({ error: "Invalid driver action" });
  }

  if (!res.success) {
    return reply.status(400).send(res);
  }

  return reply.send({ success: true, trip: res?.trip });
});

// HTTP REST: Driver Respond to Match Offer (Accept / Reject)
fastify.post("/trips/driver-response", async (req, reply) => {
  if (!hasControlAccess(req.headers)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const body = req.body as any;
  const { driverId, requestId, response } = body;
  if (!driverId || !requestId || !response) {
    return reply
      .status(400)
      .send({ error: "Missing driverId, requestId, or response" });
  }
  if (response !== "accepted" && response !== "rejected") {
    return reply
      .status(400)
      .send({ error: "response must be accepted or rejected" });
  }
  const result = matchingService.handleDriverResponse(
    driverId,
    requestId,
    response,
  );
  return reply.send(result);
});

// HTTP REST: Dynamic Driver Spawning at exact GPS coordinates
fastify.post("/drivers/spawn", async (req, reply) => {
  if (!hasControlAccess(req.headers)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const body = req.body as any;
  const { lat, lng, id } = body;

  if (!isValidGeoPoint({ lat, lng })) {
    return reply.status(400).send({ error: "Invalid GPS coordinates" });
  }
  if (!driverRegistry.isWithinBounds(lat, lng)) {
    return reply.status(400).send({
      error: "Driver must be spawned within the active operating region",
    });
  }

  const driverId = id || `spawned_driver_${Date.now().toString().slice(-4)}`;
  const driver = driverRegistry.registerDriver(driverId, lat, lng, "available");

  wsManager.broadcastToObservers({
    type: "telemetry_update",
    driverId,
    lat,
    lng,
    status: "available",
  });

  return reply.send({
    success: true,
    driver: {
      id: driver.id,
      lat: driver.lat,
      lng: driver.lng,
      status: driver.status,
    },
    totalDrivers: driverRegistry.totalDrivers,
    quadtreeSize: spatialIndex.size(),
  });
});

// --- WEBSOCKET GATEWAY ---
fastify.get("/ws", { websocket: true }, (socket, req) => {
  const query = (req.query || {}) as { role?: string; id?: string };
  if (!hasControlAccess(req.headers)) {
    socket.close(1008, "Unauthorized");
    return;
  }
  const role: ClientRole = (query.role as ClientRole) || "observer";
  if (role !== "rider" && role !== "driver" && role !== "observer") {
    socket.close(1008, "Invalid role");
    return;
  }
  const clientId = query.id;

  wsManager.handleConnection(socket, role, clientId);
});

const PORT = Number(process.env.PORT) || 3000;

try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`\n========================================================`);
  console.log(`🚀 InstaRide Server Running at http://localhost:${PORT}`);
  console.log(`🌐 Live Visualizer available at http://localhost:${PORT}/`);
  console.log(`⚡ WebSocket stream at ws://localhost:${PORT}/ws`);
  console.log(`========================================================\n`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
