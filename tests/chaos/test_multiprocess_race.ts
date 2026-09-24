import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RedisDriverLock } from "../../src/core/redis_driver_lock.js";
import {
  connectRedis,
  disconnectRedis,
  redis,
} from "../../src/infra/redis_client.js";
import { verifyRedisInvariants } from "../helpers/redis_invariants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WorkerStats {
  processIndex: number;
  matched: number;
  failed: number;
  locksAttempted: number;
  locksAcquired: number;
  locksRejected: number;
}

async function runWorker(
  processIndex: number,
  requestCount: number,
): Promise<WorkerStats> {
  return new Promise<WorkerStats>((resolve, reject) => {
    const child = fork(
      path.join(__dirname, "multiprocess_worker.ts"),
      [processIndex.toString(), requestCount.toString()],
      {
        execArgv: process.execArgv,
      },
    );

    child.on("message", (msg: any) => resolve(msg as WorkerStats));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0)
        reject(new Error(`Worker ${processIndex} exited with code ${code}`));
    });
  });
}

async function main() {
  await connectRedis();
  await redis.flushall();
  console.log(
    "==================================================================",
  );
  console.log("🔥 [CHAOS] Multi-Process Barrier Contention & Stale-Index Test");
  console.log(
    "==================================================================",
  );

  // --- STEP 1: EXPLICIT STALE-INDEX TEST (Bug #2 direct verification) ---
  console.log(
    "\n[Step 1] Testing explicit Stale-Index lock rejection across processes...",
  );
  const driverLock = new RedisDriverLock();

  // Simulate Process A committing Driver_Tesla
  await driverLock.acquireLock("Driver_Tesla", "req_proc_A", 15000);
  const committed = await driverLock.commitTrip("Driver_Tesla", "req_proc_A");
  assert.equal(
    committed,
    true,
    "Process A must successfully commit the driver",
  );

  // In Process B's perspective, its local quadtree still thinks Driver_Tesla is available,
  // and the Redis driver_lock:Driver_Tesla key has been deleted by commit_trip.lua.
  // Process B now attempts to acquire a lock on the committed driver.
  console.log("  Process B attempts to lock committed/busy Driver_Tesla...");
  const procBLockAttempt = await driverLock.acquireLock(
    "Driver_Tesla",
    "req_proc_B",
    15000,
  );

  if (procBLockAttempt) {
    throw new Error(
      "❌ FATAL BUG #2 DETECTED: Process B successfully locked a BUSY driver! Lua guard failed!",
    );
  }
  console.log(
    "  [+] Process B lock REJECTED because driver:state:Driver_Tesla is 'busy'.",
  );
  console.log(
    "  [+] Stale-index protection verified: Busy drivers CANNOT be re-locked!",
  );

  // Clean up test driver
  await redis.del("driver_lock:Driver_Tesla", "driver:state:Driver_Tesla");

  // --- STEP 2: SYNCHRONIZED MULTI-PROCESS RACE WITH BARRIER ---
  console.log(
    "\n[Step 2] Launching 3 independent OS processes against 20 drivers...",
  );
  console.log("  Setting up Redis Start Barrier...");
  await redis.del("test:barrier:ready", "test:barrier:target_time");

  const workers = [runWorker(1, 100), runWorker(2, 100), runWorker(3, 100)];

  // Wait until all 3 processes are online and ready
  console.log("  Waiting for all 3 processes to reach the barrier...");
  while (true) {
    const readyCount = await redis.scard("test:barrier:ready");
    if (readyCount === 3) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  const targetTime = Date.now() + 250;
  console.log(
    `  ⚡ All 3 processes at barrier! Synchronizing burst to timestamp ${targetTime} (+250ms) 💥`,
  );
  await redis.set("test:barrier:target_time", targetTime.toString());

  const results = await Promise.all(workers);

  console.log("\n📊 Multi-Process Execution Results (Contention Breakdown):");
  let totalMatched = 0;
  let totalRejected = 0;

  for (const r of results) {
    console.log(
      `  Process ${r.processIndex}: Matched: ${r.matched} | Locks Attempted: ${r.locksAttempted} | Granted: ${r.locksAcquired} | Contention Rejections: ${r.locksRejected}`,
    );
    totalMatched += r.matched;
    totalRejected += r.locksRejected;
  }

  console.log(
    `\nTotal matched across all 3 processes: ${totalMatched} / 20 available drivers`,
  );
  console.log(
    `Total lock collisions/rejections across cluster: ${totalRejected}`,
  );

  // Assertions:
  assert.equal(totalMatched, 20, "All 20 available drivers must be matched");
  assert.ok(
    totalRejected > 0,
    "Genuine multi-process contention must occur (rejected > 0)",
  );

  // Assert that multiple processes won trips (interleaved winners, not single process monopoly)
  const winningProcesses = results.filter((r) => r.matched > 0).length;
  console.log(`Processes that actively won drivers: ${winningProcesses} / 3`);
  assert.ok(
    winningProcesses >= 2,
    "Contention must be interleaved across multiple processes, not a single-winner monopoly",
  );

  // Invariant verification
  const invariants = await verifyRedisInvariants();
  console.log("\n📋 Post-Chaos Database Invariants:", invariants.stats);

  if (!invariants.passed) {
    console.error("❌ Invariant Violations:", invariants.violations);
    throw new Error("System left in corrupted or leaked state!");
  }

  console.log(
    "\n✅ GENUINE MULTI-PROCESS CONTENTION VERIFIED! Interleaved winners, zero double-dispatch, 0 invariant leaks.",
  );
  await disconnectRedis();
}

main().catch((err) => {
  console.error("❌ Test Failed:", err);
  process.exit(1);
});
