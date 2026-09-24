import { redis } from "../../src/infra/redis_client.js";

export interface InvariantResult {
  passed: boolean;
  violations: string[];
  orphanedKeys: string[];
  stats: {
    activeTrips: number;
    activeRiderLocks: number;
    busyDrivers: number;
    activeDriverLocks: number;
  };
}

export async function verifyRedisInvariants(): Promise<InvariantResult> {
  const violations: string[] = [];
  const orphanedKeys: string[] = [];

  // 1. Fetch active sets and scan state
  const activeTripIds = await redis.smembers("trip:active");
  const riderKeys = await redis.keys("rider:active_trip:*");
  const driverLockKeys = await redis.keys("driver_lock:*");
  const driverStateKeys = await redis.keys("driver:state:*");

  // Invariant A: Every active trip must exist and have a non-terminal status
  for (const tripId of activeTripIds) {
    const raw = await redis.get(`trip:${tripId}`);
    if (!raw) {
      violations.push(`Active set contains missing trip: trip:${tripId}`);
      orphanedKeys.push(`trip:${tripId}`);
      continue;
    }
    const trip = JSON.parse(raw);
    if (trip.status === "completed" || trip.status === "cancelled") {
      violations.push(
        `Terminal trip ${tripId} (${trip.status}) still in trip:active`,
      );
    }
  }

  // Invariant B: Every rider:active_trip key must map to a trip in trip:active
  for (const key of riderKeys) {
    const tripId = await redis.get(key);
    if (!tripId || !activeTripIds.includes(tripId)) {
      violations.push(
        `Orphaned rider lock: ${key} -> tripId ${tripId} is not in trip:active`,
      );
      orphanedKeys.push(key);
    }
  }

  // Invariant C: A busy driver must NOT have an active lock held by a DIFFERENT request
  let busyDriversCount = 0;
  for (const stateKey of driverStateKeys) {
    const driverId = stateKey.replace("driver:state:", "");
    const state = await redis.hgetall(stateKey);
    if (state.status === "busy") {
      busyDriversCount++;
      const currentLockHolder = await redis.get(`driver_lock:${driverId}`);
      if (
        currentLockHolder &&
        currentLockHolder !== state.currentTripRequestId
      ) {
        violations.push(
          `Split-brain lock: Driver ${driverId} is busy on req ${state.currentTripRequestId} but locked by req ${currentLockHolder}`,
        );
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    orphanedKeys,
    stats: {
      activeTrips: activeTripIds.length,
      activeRiderLocks: riderKeys.length,
      busyDrivers: busyDriversCount,
      activeDriverLocks: driverLockKeys.length,
    },
  };
}

