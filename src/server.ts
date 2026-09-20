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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// San Francisco Bounding Box
export const SF_BOUNDS: GeoBounds = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
});

// Register WebSocket plugin
await fastify.register(websocket);

// 1. Initialize Core Spatial & Concurrency Pipeline
const spatialIndex = new QuadTree(SF_BOUNDS, 8, 7);
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

// --- HTTP REST ROUTES ---

// Serve the live visualizer UI directly at root /
fastify.get("/", async (req, reply) => {
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
    totalDrivers: driverRegistry.totalDrivers,
    quadtreeSize: spatialIndex.size,
    observers: wsManager.observerCount,
    timestamp: new Date().toISOString(),
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

  const result = await matchingService.requestRide({
    requestId: body.requestId || `req_${Date.now()}`,
    riderId: body.riderId,
    pickup: body.pickup,
    dropoff: body.dropoff,
    offerTimeoutMs: body.offerTimeoutMs ?? 15_000,
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
