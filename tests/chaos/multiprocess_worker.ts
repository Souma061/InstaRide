import { DriverRegistry } from "../../src/core/driver_registry.js";
import { MatchingService } from "../../src/core/matching_service.js";
import { RedisDriverLock } from "../../src/core/redis_driver_lock.js";
import { RedisTripStore } from "../../src/core/redis_trip_store.js";
import { TripStateMachine } from "../../src/core/trip_state_machine.js";
import { connectRedis, redis } from "../../src/infra/redis_client.js";
import { QuadTree } from "../../src/spatial/quadtree.js";

const processIndex = process.argv[2];
const requestCount = parseInt(process.argv[3], 10);

async function run() {
  await connectRedis();

  // Process-local Quadtree with same 20 drivers in Koramangala
  const spatial = new QuadTree(
    { minLat: 12.9, maxLat: 13.0, minLng: 77.6, maxLng: 77.7 },
    8,
    4,
  );
  for (let i = 1; i <= 20; i++) {
    spatial.insert(
      `Driver_${i}`,
      12.93 + (i % 5) * 0.005,
      77.62 + (i % 4) * 0.005,
    );
  }

  const lock = new RedisDriverLock();
  const store = new RedisTripStore();
  const registry = new DriverRegistry(spatial, lock);
  for (let i = 1; i <= 20; i++) {
    registry.registerDriver(
      `Driver_${i}`,
      12.93 + (i % 5) * 0.005,
      77.62 + (i % 4) * 0.005,
      "available",
    );
  }
  const sm = new TripStateMachine();

  // Metrics to measure genuine contention
  let locksAttempted = 0;
  let locksAcquired = 0;
  let locksRejected = 0;

  // Wrap acquireLock to count contention
  const originalAcquire = registry.acquireLock.bind(registry);
  registry.acquireLock = async (driverId, reqId, ttl) => {
    locksAttempted++;
    const ok = await originalAcquire(driverId, reqId, ttl);
    if (ok) {
      locksAcquired++;
    } else {
      locksRejected++;
    }
    return ok;
  };

  let matched = 0;
  let failed = 0;
  let pendingCount = requestCount;

  const checkDone = () => {
    if (pendingCount === 0) {
      if (process.send) {
        process.send({
          processIndex,
          matched,
          failed,
          locksAttempted,
          locksAcquired,
          locksRejected,
        });
      }
      setTimeout(() => process.exit(0), 100);
    }
  };

  const matching = new MatchingService(
    registry,
    sm,
    {
      onOfferDispatched: (notif) => {
        // Fast randomized driver reaction time (2-15ms)
        const delay = 2 + Math.floor(Math.random() * 13);
        setTimeout(
          () =>
            matching.handleDriverResponse(
              notif.driverId,
              notif.requestId,
              "accepted",
            ),
          delay,
        );
      },
      onTripMatched: () => {
        matched++;
        pendingCount--;
        checkDone();
      },
      onMatchFailed: () => {
        failed++;
        pendingCount--;
        checkDone();
      },
    },
    store,
  );

  // --- REDIS HIGH-PRECISION TIMESTAMP BARRIER ---
  // 1. Announce ready
  await redis.sadd("test:barrier:ready", processIndex);

  // 2. Poll until orchestrator writes the target firing timestamp
  let targetTime = 0;
  while (!targetTime) {
    const raw = await redis.get("test:barrier:target_time");
    if (raw) targetTime = parseInt(raw, 10);
    else await new Promise((r) => setTimeout(r, 5));
  }

  // 3. Sleep until 15ms before target, then spin-wait to synchronize on the exact sub-millisecond
  const sleepMs = targetTime - Date.now() - 15;
  if (sleepMs > 0) {
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  while (Date.now() < targetTime) {
    // sub-millisecond spin-wait
  }

  // --- SYNCHRONIZED FIRING ---
  // All 3 processes burst concurrently and interleave socket writes to Redis
  for (let i = 0; i < requestCount; i++) {
    const lat = 12.93 + (i % 5) * 0.005;
    const lng = 77.62 + (i % 4) * 0.005;
    if (i > 0 && i % 3 === 0) {
      await new Promise((r) => setTimeout(r, Math.random() * 4));
    }
    void matching.requestRide({
      requestId: `req_p${processIndex}_${i}`,
      riderId: `rider_p${processIndex}_${i}`,
      pickup: { lat, lng },
      dropoff: { lat: 12.98, lng: 77.65 },
      offerTimeoutMs: 500,
      k: 20,
      maxRadiusMeters: 10000,
    });
  }

  // Safety fallback if some loop hangs
  setTimeout(() => {
    if (process.send) {
      process.send({
        processIndex,
        matched,
        failed,
        locksAttempted,
        locksAcquired,
        locksRejected,
      });
    }
    process.exit(0);
  }, 7000);
}

run().catch((err) => {
  console.error(`Worker ${processIndex} error:`, err);
  process.exit(1);
});
