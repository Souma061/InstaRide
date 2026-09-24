/**
 * General Requirements:
 * 1. Idempotency (Network retries return existing trip)
 * 2. One active trip per rider
 * 3. Cluster-wide active querying
 * 4. Clean release on termination
 * 5. Driver cancellation & rematch support
 */

import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redis } from "../infra/redis_client.js";
import { Trip } from "./trip_state_machine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREATE_TRIP_LUA = fs.readFileSync(
  path.join(__dirname, "../infra/lua/create_trip.lua"),
  "utf8",
);

const RIDER_ACTIVE_SAFETY_TTL_SEC = 7200; // Safety TTL for rider active lock (2 hours) to prevent indefinite locks in case of failures.

export class RedisTripStore {
  private tripPrefix = "trip:";
  private requestPrefix = "request:trip:";
  private riderActivePrefix = "rider:active_trip:";
  private activeTripSetKey = "trip:active";

  /**
   * Atomically registers a new trip in Redis.
   * Guarantees idempotency and single-active trip per rider.
   */
  // public async createTrip(trip: Trip): Promise<{
  //   success: boolean;
  //   trip?: Trip;
  //   error?: string;
  // }> {
  //   // 1. Idempotency Check: if requestId was already submitted, return existing trip
  //   const existingTripId = await redis.get(
  //     `${this.requestPrefix}${trip.requestId}`,
  //   );
  //   if (existingTripId) {
  //     const existing = await this.getTrip(existingTripId);
  //     if (existing) {
  //       return { success: true, trip: existing };
  //     }
  //   }

  //   // 2. Rider Active Check: ensure rider doesn't already have an in-flight trip
  //   const riderLockKey = `${this.riderActivePrefix}${trip.riderId}`;
  //   const acquired = await redis.set(riderLockKey, trip.id, "NX");
  //   if (!acquired) {
  //     return {
  //       success: false,
  //       error: `Rider ${trip.riderId} already has an active trip.`,
  //     };
  //   }

  //   // 3. Atomically save Trip, Request mapping, and add to active trips set
  //   const tripKey = `${this.tripPrefix}${trip.id}`;
  //   const requestKey = `${this.requestPrefix}${trip.requestId}`;
  //   const pipeline = redis.pipeline();
  //   pipeline.set(tripKey, JSON.stringify(trip));
  //   pipeline.set(requestKey, trip.id);
  //   pipeline.sadd(this.activeTripSetKey, trip.id);
  //   await pipeline.exec();

  //   return { success: true, trip };
  // }

  public async createTrip(trip: Trip): Promise<{
    success: boolean;
    trip?: Trip;
    error?: string;
  }> {
    const requestKey = `${this.requestPrefix}${trip.requestId}`;
    const riderActiveKey = `${this.riderActivePrefix}${trip.riderId}`;
    const tripKey = `${this.tripPrefix}${trip.id}`;
    const activeSetKey = this.activeTripSetKey;

    const result = (await redis.eval(
      CREATE_TRIP_LUA,
      4,
      requestKey,
      riderActiveKey,
      tripKey,
      activeSetKey,
      trip.id,
      JSON.stringify(trip),
      RIDER_ACTIVE_SAFETY_TTL_SEC.toString(),
    )) as [number, string | null];
    const [code, val] = result;
    // code 1:idempotency network retry
    if (code === 1) {
      const existing = await this.getTrip(val!);
      if (existing) {
        return { success: true, trip: existing };
      }
    }
    if (code === 0) {
      return {
        success: false,
        error: `Rider ${trip.riderId} already has an active trip.`,
      };
    }
    return { success: true, trip };
  }
  public async reconcileOrphanedTrips(
    maxStaleMatchingAgeMs: number = 60_000,
  ): Promise<number> {
    const now = Date.now();
    const activeTripIds = await redis.smembers(this.activeTripSetKey);
    const riderKeys = await redis.keys(`${this.riderActivePrefix}*`);
    let cleaned = 0;

    for (const riderKey of riderKeys) {
      const tripId = await redis.get(riderKey);
      if (!tripId || !activeTripIds.includes(tripId)) {
        await redis.del(riderKey);
        cleaned++;
      } else {
        const raw = await redis.get(`${this.tripPrefix}${tripId}`);
        if (!raw) {
          await redis.del(riderKey);
          await redis.srem(this.activeTripSetKey, tripId);
          cleaned++;
        } else {
          const trip = JSON.parse(raw) as Trip;
          const isTerminal =
            trip.status === "completed" || trip.status === "cancelled";
          const isAbandonedMatching =
            (trip.status === "requested" || trip.status === "matching") &&
            now - trip.createdAt > maxStaleMatchingAgeMs;

          if (isTerminal || isAbandonedMatching) {
            if (isAbandonedMatching) {
              trip.status = "cancelled";
              trip.cancellationReason =
                "Abandoned due to server crash or matching timeout";
              trip.cancelledAt = now;
              await redis.set(
                `${this.tripPrefix}${tripId}`,
                JSON.stringify(trip),
              );
            }
            await redis.del(riderKey);
            await redis.srem(this.activeTripSetKey, tripId);
            cleaned++;
          }
        }
      }
    }
    return cleaned;
  }
  /**
   * Retrieves a trip by its unique ID.
   */
  public async getTrip(tripId: string): Promise<Trip | null> {
    const raw = await redis.get(`${this.tripPrefix}${tripId}`);
    return raw ? (JSON.parse(raw) as Trip) : null;
  }

  /**
   * Retrieves a trip by its client requestId.
   */
  public async getTripByRequestId(requestId: string): Promise<Trip | null> {
    const tripId = await redis.get(`${this.requestPrefix}${requestId}`);
    if (!tripId) return null;
    return this.getTrip(tripId);
  }

  /**
   * Retrieves the currently active trip for a rider, if any.
   */
  public async getActiveTripByRiderId(riderId: string): Promise<Trip | null> {
    const tripId = await redis.get(`${this.riderActivePrefix}${riderId}`);
    if (!tripId) return null;
    return this.getTrip(tripId);
  }

  /**
   * Saves updated trip state. If terminal (completed or cancelled),
   * releases the rider's active lock and removes from active trips set.
   */
  public async saveTrip(trip: Trip): Promise<void> {
    const tripKey = `${this.tripPrefix}${trip.id}`;
    const isTerminal =
      trip.status === "completed" || trip.status === "cancelled";

    const pipeline = redis.pipeline();
    pipeline.set(tripKey, JSON.stringify(trip));

    if (isTerminal) {
      pipeline.srem(this.activeTripSetKey, trip.id);
      pipeline.del(`${this.riderActivePrefix}${trip.riderId}`);
    } else {
      pipeline.sadd(this.activeTripSetKey, trip.id);
    }

    await pipeline.exec();
  }

  /**
   * Handles driver cancellation:
   * - If autoRematch is true, moves trip back to 'matching' without freeing rider lock.
   * - If autoRematch is false, terminates trip and frees rider lock.
   */
  public async handleDriverCancellation(
    tripId: string,
    driverId: string,
    reason: string = "Driver cancelled",
    autoRematch: boolean = true,
  ): Promise<{ success: boolean; trip?: Trip; error?: string }> {
    const trip = await this.getTrip(tripId);
    if (!trip) {
      return { success: false, error: `Trip ${tripId} not found` };
    }

    if (trip.driverId !== driverId) {
      return {
        success: false,
        error: `Driver ${driverId} is not assigned to trip ${tripId}`,
      };
    }

    if (autoRematch) {
      trip.status = "matching";
      trip.driverId = null;
      trip.matchedAt = null;
      await this.saveTrip(trip);
    } else {
      trip.status = "cancelled";
      trip.cancelledAt = Date.now();
      trip.cancelledBy = "driver";
      trip.cancellationReason = reason;
      await this.saveTrip(trip);
    }

    return { success: true, trip };
  }

  /**
   * Returns all currently active trips across the cluster.
   */
  public async getActiveTrips(): Promise<Trip[]> {
    const tripIds = await redis.smembers(this.activeTripSetKey);
    if (tripIds.length === 0) return [];
    const keys = tripIds.map((id) => `${this.tripPrefix}${id}`);
    const results = await redis.mget(...keys);
    return results
      .filter((raw): raw is string => raw !== null)
      .map((raw) => JSON.parse(raw) as Trip);
  }
}
