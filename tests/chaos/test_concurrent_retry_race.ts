import { strict as assert } from "node:assert";
import { RedisTripStore } from "../../src/core/redis_trip_store.js";
import { Trip } from "../../src/core/trip_state_machine.js";
import {
  connectRedis,
  disconnectRedis,
  redis,
} from "../../src/infra/redis_client.js";
import { verifyRedisInvariants } from "../helpers/redis_invariants.js";

async function main() {
  await connectRedis();
  await redis.flushall();
  console.log("===============================================================");
  console.log("🔥 [CHAOS] Running 50x Concurrent Idempotency & Rider-Race Tests");
  console.log("===============================================================");

  const store = new RedisTripStore();

  // Test 1: 50 identical requests arriving in the exact same millisecond
  console.log("\n[Test 1] Testing 50x identical network retry storm...");
  const baseTrip: Trip = {
    id: "trip_race_100",
    requestId: "req_identical_storm",
    riderId: "rider_single",
    driverId: null,
    status: "requested",
    pickup: { lat: 12.93, lng: 77.62 },
    dropoff: { lat: 12.98, lng: 77.65 },
    createdAt: Date.now(),
    matchedAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    cancelledBy: null,
  };

  const retryResults = await Promise.all(
    Array.from({ length: 50 }, () => store.createTrip(baseTrip)),
  );

  // In our store, createTrip returns { success: boolean; trip?: Trip; error?: string }
  // To distinguish new vs idempotent retry, we compare returned trip ID and active trip set
  const successfulReturns = retryResults.filter((r) => r.success);
  console.log(
    `  Results: ${successfulReturns.length} / 50 resolved successfully to the identical trip`,
  );
  assert.equal(
    successfulReturns.length,
    50,
    "All 50 calls must succeed and return the trip",
  );
  for (const res of successfulReturns) {
    assert.equal(res.trip?.id, baseTrip.id);
  }

  // Test 2: 50 DIFFERENT requests from the SAME rider (illegal parallel rides)
  console.log("\n[Test 2] Testing 50x illegal parallel rides from same rider...");
  const parallelCalls = Array.from({ length: 50 }, (_, i) => {
    const t: Trip = {
      ...baseTrip,
      id: `trip_illegal_${i}`,
      requestId: `req_diff_${i}`,
      riderId: "rider_bad_actor",
    };
    return store.createTrip(t);
  });

  const parallelResults = await Promise.all(parallelCalls);
  const allowed = parallelResults.filter((r) => r.success).length;
  const rejected = parallelResults.filter((r) => !r.success).length;

  console.log(`  Parallel rides: ${allowed} allowed, ${rejected} blocked`);
  assert.equal(allowed, 1, "Only ONE active ride allowed per rider");
  assert.equal(rejected, 49, "Remaining 49 must be rejected");

  // Invariant verification
  const invariants = await verifyRedisInvariants();
  console.log("\n📋 Post-Test Invariants:", invariants.stats);
  assert.ok(
    invariants.passed,
    `Invariant violations detected: ${invariants.violations.join(", ")}`,
  );

  console.log(
    "\n✅ Idempotency and rider single-active invariants 100% verified!",
  );
  await disconnectRedis();
}

main().catch((err) => {
  console.error("❌ Test Failed:", err);
  process.exit(1);
});

