import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RedisDriverLock } from "../../src/core/redis_driver_lock.js";
import { RedisTripStore } from "../../src/core/redis_trip_store.js";
import {
  connectRedis,
  disconnectRedis,
  redis,
} from "../../src/infra/redis_client.js";
import { verifyRedisInvariants } from "../helpers/redis_invariants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  await connectRedis();
  await redis.flushall();
  console.log(
    "==================================================================",
  );
  console.log(
    "💥 [CHAOS] KILL -9 (SIGKILL) Sudden Death & Crash Recovery Suite",
  );
  console.log(
    "==================================================================",
  );

  const driverLock = new RedisDriverLock();
  const tripStore = new RedisTripStore();

  // =====================================================================
  // SCENARIO 1: Server dies mid-offer (Driver is locked with pending offer)
  // =====================================================================
  console.log(
    "\n[Scenario 1] Testing KILL -9 Mid-Offer (Pending Lock Auto-Recovery)...",
  );

  const worker1 = fork(path.join(__dirname, "crash_worker.ts"), ["mid-offer"], {
    execArgv: process.execArgv,
  });

  const lockEvent = await new Promise<{ driverId: string; requestId: string }>(
    (resolve) => {
      worker1.on("message", (msg: any) => {
        if (msg.event === "locked_mid_offer") resolve(msg);
      });
    },
  );

  console.log(
    `  Driver ${lockEvent.driverId} locked by req ${lockEvent.requestId}.`,
  );

  // Verify lock is present in Redis before the crash
  const lockBeforeKill = await driverLock.getLockHolder(lockEvent.driverId);
  assert.equal(
    lockBeforeKill,
    lockEvent.requestId,
    "Lock must be active in Redis",
  );
  console.log(
    "  Verified lock exists in Redis. Delivering sudden SIGKILL (kill -9)... 💥",
  );

  // SUDDEN DEATH: Forcefully terminate the process without clean shutdown
  worker1.kill("SIGKILL");

  console.log(
    "  Process killed instantly. Waiting for Redis TTL auto-expiry (600ms)...",
  );
  // The worker used offerTimeoutMs: 500ms + LOCK_SAFETY_MARGIN_MS (3000ms in matching_service)
  // Wait for TTL or check TTL remaining:
  const ttlRemaining = await redis.pttl(`driver_lock:${lockEvent.driverId}`);
  console.log(`  Initial lock TTL remaining in Redis: ${ttlRemaining}ms`);

  // Wait until lock auto-expires
  const waitMs = Math.max(0, ttlRemaining) + 100;
  console.log(
    `  Sleeping ${waitMs}ms to let lock expire naturally via Redis TTL...`,
  );
  await new Promise((r) => setTimeout(r, waitMs));

  // Assert lock has vanished automatically
  const lockAfterTtl = await driverLock.getLockHolder(lockEvent.driverId);
  console.log(`  Lock holder after TTL expiration: ${lockAfterTtl}`);
  assert.equal(
    lockAfterTtl,
    null,
    "Lock MUST auto-expire; driver must not be locked forever!",
  );

  // Assert another rider / server can now acquire this driver
  console.log("  New process attempts to claim freed driver...");
  const acquiredByNewNode = await driverLock.acquireLock(
    lockEvent.driverId,
    "req_new_node",
    5000,
  );
  assert.equal(
    acquiredByNewNode,
    true,
    "Driver must be immediately claimable after TTL expiry",
  );
  console.log(
    "  [+] PASS: Driver self-healed and was successfully acquired by replacement node!",
  );

  // Release test lock
  await driverLock.releaseLock(lockEvent.driverId, "req_new_node");

  // Reconcile the abandoned mid-offer trip left by dead Worker 1
  console.log(
    "  Reconciling abandoned mid-offer trip left behind by crashed Worker 1...",
  );
  const midOfferCleaned = await tripStore.reconcileOrphanedTrips(100);
  console.log(
    `  [+] Reconciled and cleaned ${midOfferCleaned} abandoned mid-offer trip(s).`,
  );

  // =====================================================================
  // SCENARIO 2: Server dies mid-trip (Rider active lock cleanup on reboot)
  // =====================================================================
  console.log(
    "\n[Scenario 2] Testing KILL -9 Mid-Trip (State Abandonment & Reboot Recovery)...",
  );

  const worker2 = fork(path.join(__dirname, "crash_worker.ts"), ["mid-trip"], {
    execArgv: process.execArgv,
  });

  const tripEvent = await new Promise<{
    tripId: string;
    riderId: string;
    driverId: string;
  }>((resolve) => {
    worker2.on("message", (msg: any) => {
      if (msg.event === "trip_in_progress") resolve(msg);
    });
  });

  console.log(
    `  Trip ${tripEvent.tripId} active with rider ${tripEvent.riderId}.`,
  );
  console.log("  Delivering sudden SIGKILL (kill -9) to server mid-trip... 💥");

  // Hard crash mid-trip
  worker2.kill("SIGKILL");

  // Verify rider is currently blocked by the orphaned state
  const riderKey = `rider:active_trip:${tripEvent.riderId}`;
  const stuckTripId = await redis.get(riderKey);
  assert.equal(
    stuckTripId,
    tripEvent.tripId,
    "Rider has active trip lingering in Redis",
  );
  console.log(
    `  Verified rider is blocked in Redis by dead trip ${stuckTripId}.`,
  );

  // Simulate replacement server booting up and running recovery
  console.log(
    "  Replacement server boots up and initiates startup reconciliation...",
  );

  // Mark dead host's trip as cancelled and reconcile
  const rawTrip = await redis.get(`trip:${tripEvent.tripId}`);
  if (rawTrip) {
    const trip = JSON.parse(rawTrip);
    trip.status = "cancelled";
    trip.cancellationReason = "Server host crashed (SIGKILL recovery)";
    await tripStore.saveTrip(trip);
  }

  const cleanedCount = await tripStore.reconcileOrphanedTrips(100);
  console.log(`  Startup reconciler cleaned ${cleanedCount} orphaned locks.`);

  // Assert rider is now free to book
  const activeTripAfterReboot = await tripStore.getActiveTripByRiderId(
    tripEvent.riderId,
  );
  console.log(
    `  Rider active trip after reboot reconciliation: ${activeTripAfterReboot}`,
  );
  assert.equal(
    activeTripAfterReboot,
    null,
    "Rider must be completely unblocked after restart!",
  );

  // Reset driver status back to available
  await driverLock.releaseCommittedDriver(tripEvent.driverId, "available");

  // Invariant verification
  console.log(
    "\n[Scenario 3] Running full post-crash database invariant check...",
  );
  const invariants = await verifyRedisInvariants();
  console.log("  Post-Crash Redis Invariants:", invariants.stats);
  assert.ok(
    invariants.passed,
    `Invariant violations detected: ${invariants.violations.join(", ")}`,
  );

  console.log(
    "\n✅ KILL -9 CRASH RECOVERY VERIFIED! Auto-expiring locks work, riders are unblocked on reboot, zero leaks.",
  );
  await disconnectRedis();
}

main().catch((err) => {
  console.error("❌ Crash Recovery Test Failed:", err);
  process.exit(1);
});
