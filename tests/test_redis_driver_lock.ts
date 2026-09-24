import { RedisDriverLock } from "../src/core/redis_driver_lock.js";
import {
  connectRedis,
  disconnectRedis,
  redis,
} from "../src/infra/redis_client.js";

async function runTests() {
  console.log("=====================================================");
  console.log("     REDIS DISTRIBUTED DRIVER LOCK: TEST SUITE       ");
  console.log("=====================================================\n");

  await connectRedis();
  const lock = new RedisDriverLock();
  const DRIVER_ID = "driver_tesla_42";

  // Clean slate before testing
  await lock.releaseLock(DRIVER_ID, "cleanup");

  // ----------------------------------------------------------------
  // Test 1: Basic Acquisition & Inspection
  // ----------------------------------------------------------------
  console.log("[Test 1] Acquiring Lock for Request 101...");
  const acquired = await lock.acquireLock(DRIVER_ID, "req_101", 5000);
  console.log(`  Acquire Result: ${acquired} (Expected: true)`);

  const holder = await lock.getLockHolder(DRIVER_ID);
  console.log(`  Current Holder: ${holder} (Expected: req_101)`);
  console.log(
    `  Is Locked: ${await lock.isLocked(DRIVER_ID)} (Expected: true)\n`,
  );

  // ----------------------------------------------------------------
  // Test 2: Mutual Exclusion (Race Condition Prevention)
  // ----------------------------------------------------------------
  console.log("[Test 2] Competing Request 102 attempts to steal the lock...");
  const stolen = await lock.acquireLock(DRIVER_ID, "req_102", 5000);
  console.log(`  Steal Attempt Result: ${stolen} (Expected: false)`);
  console.log(
    `  Holder remains: ${await lock.getLockHolder(DRIVER_ID)} (Expected: req_101)\n`,
  );

  // ----------------------------------------------------------------
  // Test 3: Safe Release via Lua Script
  // ----------------------------------------------------------------
  console.log("[Test 3] Testing Safe Release Protection...");
  const wrongRelease = await lock.releaseLock(DRIVER_ID, "req_wrong");
  console.log(
    `  Release with wrong requestId: ${wrongRelease} (Expected: false)`,
  );

  const rightRelease = await lock.releaseLock(DRIVER_ID, "req_101");
  console.log(
    `  Release with matching requestId: ${rightRelease} (Expected: true)`,
  );
  console.log(
    `  Is Locked after release: ${await lock.isLocked(DRIVER_ID)} (Expected: false)\n`,
  );

  // ----------------------------------------------------------------
  // Test 4: TTL Auto-Expiration (Crash Resilience)
  // ----------------------------------------------------------------
  console.log("[Test 4] Testing 300ms TTL Auto-Expiration...");
  await lock.acquireLock(DRIVER_ID, "req_dying", 300);
  console.log("  Lock acquired for 300ms. Sleeping for 400ms...");
  await new Promise((r) => setTimeout(r, 400));

  const expiredHolder = await lock.getLockHolder(DRIVER_ID);
  console.log(`  Holder after TTL expiry: ${expiredHolder} (Expected: null)`);
  console.log(
    `  Is Locked: ${await lock.isLocked(DRIVER_ID)} (Expected: false)\n`,
  );

  // ----------------------------------------------------------------
  // Test 5: Concurrency Storm (1,000 Riders vs 1 Driver)
  // ----------------------------------------------------------------
  console.log(
    "[Test 5] Simulating 1,000 simultaneous riders competing for 1 driver...",
  );
  const SWARM = 1000;
  const promises = Array.from({ length: SWARM }, (_, i) =>
    lock.acquireLock(DRIVER_ID, `swarm_req_${i}`, 5000),
  );

  const results = await Promise.all(promises);
  const winners = results.filter((r) => r === true).length;
  const losers = results.filter((r) => r === false).length;

  console.log(`  Total Competitors : ${SWARM}`);
  console.log(`  Winners (Locked)  : ${winners} (Expected: exactly 1)`);
  console.log(`  Losers (Rejected) : ${losers} (Expected: 999)`);
  console.log(`  Winning Holder    : ${await lock.getLockHolder(DRIVER_ID)}`);

  // Clean up
  const winningHolder = await lock.getLockHolder(DRIVER_ID);
  if (winningHolder) {
    await lock.releaseLock(DRIVER_ID, winningHolder);
  }

  // ----------------------------------------------------------------
  // Test 6: Atomic Commit via Lua Script
  // ----------------------------------------------------------------
  console.log("\n[Test 6] Testing Atomic Commit...");
  // 1. Acquire lock
  await lock.acquireLock(DRIVER_ID, "req_commit_1", 5000);

  // 2. Commit with wrong requestId (should fail)
  const wrongCommit = await lock.commitTrip(DRIVER_ID, "req_wrong");
  console.log(
    `  Commit with wrong requestId: ${wrongCommit} (Expected: false)`,
  );

  // 3. Commit with matching requestId (should succeed)
  const rightCommit = await lock.commitTrip(DRIVER_ID, "req_commit_1");
  console.log(
    `  Commit with matching requestId: ${rightCommit} (Expected: true)`,
  );

  // 4. Verify lock is cleared and driver is marked 'busy'
  const isLockedAfterCommit = await lock.isLocked(DRIVER_ID);
  console.log(
    `  Is Locked after commit: ${isLockedAfterCommit} (Expected: false)`,
  );
  const driverState = await redis.hgetall(`driver:state:${DRIVER_ID}`);
  console.log(
    `  Driver Status in Redis: "${driverState.status}" (Expected: "busy")`,
  );

  console.log("\n=====================================================");
  if (
    acquired &&
    !stolen &&
    !wrongRelease &&
    rightRelease &&
    winners === 1 &&
    !wrongCommit &&
    rightCommit &&
    !isLockedAfterCommit &&
    driverState.status === "busy"
  ) {
    console.log("  ALL REDIS LOCKING & COMMIT INVARIANTS PASSED! (100%)");
  } else {
    console.error("  TEST FAILED: INVARIANT VIOLATION DETECTED!");
  }
  console.log("=====================================================\n");

  await disconnectRedis();
}

runTests().catch((err) => {
  console.error("Fatal Test Error:", err);
  disconnectRedis();
});
