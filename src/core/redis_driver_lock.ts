import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redis } from "../infra/redis_client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMI_TRIP_LUA = fs.readFileSync(
  path.join(__dirname, "../infra/lua/commit_trip.lua"),
  "utf8",
);

// read lua script once into memory at module load time
const RELEASE_LOCK_LUA = fs.readFileSync(
  path.join(__dirname, "../infra/lua/release_lock.lua"),
  "utf8",
);
export class RedisDriverLock {
  private lockPrefix: string = "driver_lock:";

  public async acquireLock(
    driverId: string,
    requestId: string,
    ttlMs: number = 15000,
  ): Promise<boolean> {
    const key = `${this.lockPrefix}${driverId}`;
    const result = await redis.set(key, requestId, "PX", ttlMs, "NX");
    return result === "OK";
  }
  //safely release the lock only if the requestId matches
  public async releaseLock(
    driverId: string,
    requestId: string,
  ): Promise<boolean> {
    const key = `${this.lockPrefix}${driverId}`;
    const result = await redis.eval(RELEASE_LOCK_LUA, 1, key, requestId);
    return Number(result) === 1;
  }
  // return the requestId currently holding the lock for a driver, or null if no lock exists
  public async getLockHolder(driverId: string): Promise<string | null> {
    const key = `${this.lockPrefix}${driverId}`;
    const result = await redis.get(key);
    return result || null;
  }
  //check if driver is locked
  public async isLocked(driverId: string): Promise<boolean> {
    const holder = await this.getLockHolder(driverId);
    return holder !== null;
  }
  // atomically commit a trip: removes the lock and marks the driver s "Busy" in one atomic step using a Lua script.returns true if commit succeded,false if lock expired or was invalid

  public async commitTrip(
    driverId: string,
    requestId: string,
  ): Promise<boolean> {
    const lockKey = `${this.lockPrefix}${driverId}`;
    const stateKey = `driver:state:${driverId}`;
    const result = await redis.eval(
      COMMI_TRIP_LUA,
      2,
      lockKey,
      stateKey,
      requestId,
    ); // redis.eval takes the script, number of keys, followed by the keys and arguments. In this case, we have 2 keys: lockKey and stateKey, and one argument: requestId
    return Number(result) === 1;
  }
  /**
   * Called when a driver cancels or finishes a committed ride.
   * Atomically resets driver status in Redis back to 'available' (or 'offline').
   */
  public async releaseCommittedDriver(
    driverId: string,
    newStatus: "available" | "offline" = "available",
  ): Promise<boolean> {
    const stateKey = `driver:state:${driverId}`;

    // Reset driver state and remove current trip reference
    await redis.hset(stateKey, {
      status: newStatus,
      currentTripRequestId: "",
    });

    return true;
  }
}
