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
import { GeoBounds, QuadTree } from "./spatial/quadtree.js";
import { clampTimeout, isValidGeoPoint } from "./utils/validation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default San Francisco Bounding Box
export const SF_BOUNDS: GeoBounds = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

let activeCityName = "San Francisco";
let activeBounds: GeoBounds = { ...SF_BOUNDS };

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
simulator = new DriverSimulator(SF_BOUNDS, driverRegistry, stateMachine);
simulator.setMatchingService(matchingService);
simulator.onTelemetryTick = (updates) => {
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
  const body = req.body as any;
  const newBounds = body?.bounds || SF_BOUNDS;
  const newCityName = body?.cityName || "Custom Region";
  const count = typeof body?.driverCount === "number" ? body.driverCount : 40;

  activeCityName = newCityName;
  activeBounds = { ...newBounds };

  spatialIndex = new QuadTree(activeBounds, 8, 7);
  driverRegistry.reset(spatialIndex);
  simulator.resetRegion(activeBounds, count);

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
  const { tripId } = req.params as { tripId: string };
  const trip = stateMachine.getTrip(tripId);
  if (!trip) {
    return reply.status(404).send({ error: "Trip not found" });
  }

  const result = matchingService.cancelRide(
    trip.requestId,
    "rider",
    "Cancelled via HTTP API",
  );
  return reply.send(result);
});

// HTTP REST: Execute Driver Milestone Action (Arrived, Start Trip, Complete Trip)
fastify.post("/trips/:tripId/driver-action", async (req, reply) => {
  const { tripId } = req.params as { tripId: string };
  const body = req.body as any;
  const action = body?.action as "arrived" | "start_trip" | "complete_trip";
  const driverId = body?.driverId;

  const trip = stateMachine.getTrip(tripId);
  if (!trip) {
    return reply.status(404).send({ error: "Trip not found" });
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

  if (res && !res.success) {
    return reply.status(400).send(res);
  }

  return reply.send({ success: true, trip: res?.trip });
});

// HTTP REST: Driver Respond to Match Offer (Accept / Reject)
fastify.post("/trips/driver-response", async (req, reply) => {
  const body = req.body as any;
  const { driverId, requestId, response } = body;
  if (!driverId || !requestId || !response) {
    return reply
      .status(400)
      .send({ error: "Missing driverId, requestId, or response" });
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
  const body = req.body as any;
  const { lat, lng, id } = body;

  if (!isValidGeoPoint({ lat, lng })) {
    return reply.status(400).send({ error: "Invalid GPS coordinates" });
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
  const role: ClientRole = (query.role as ClientRole) || "observer";
  const clientId = query.id;

  wsManager.handleConnection(socket, role, clientId);
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

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
