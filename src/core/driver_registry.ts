import { metrics } from "../metrics/metrics.js";
import { CandidateDriver, QuadTree } from "../spatial/quadtree.js";
import { RedisDriverLock } from "./redis_driver_lock.js";

export type DriverStatus = "available" | "busy" | "offline";

export interface LockToken {
  requestId: string;
  expiresAt: number;
}

export interface DriverRecord {
  id: string;
  lat: number;
  lng: number;
  status: DriverStatus;
  lockToken?: LockToken;
  lastSeen: number; // timestamp in milliseconds
}

// Structural subset of a spatial index that can shadow the primary one
// (e.g. the C++ bridge). Return type is unknown because some mirrors are async.
export interface SpatialIndexMirror {
  insert(id: string, lat: number, lng: number): unknown;
  update(id: string, lat: number, lng: number): unknown;
  remove(id: string): unknown;
}

export class DriverRegistry {
  private readonly drivers = new Map<string, DriverRecord>(); // in memory registry of drivers for fast access
  private spatialIndex: QuadTree;
  private readonly redisLock?: RedisDriverLock;
  private mirror?: SpatialIndexMirror;

  constructor(spatialIndex: QuadTree, redisLock?: RedisDriverLock) {
    this.spatialIndex = spatialIndex;
    this.redisLock = redisLock;
  }

  // Keeps a secondary index (C++ accelerator) in lockstep with the primary one,
  // so FR10 available-only holds on whichever engine answers the k-NN query.
  public setMirror(mirror: SpatialIndexMirror): void {
    this.mirror = mirror;
  }

  private idxInsert(id: string, lat: number, lng: number): boolean {
    const ok = this.spatialIndex.insert(id, lat, lng);
    if (ok) this.sink(this.mirror?.insert(id, lat, lng));
    return ok;
  }

  private idxUpdate(id: string, lat: number, lng: number): boolean {
    const ok = this.spatialIndex.update(id, lat, lng);
    if (ok) this.sink(this.mirror?.update(id, lat, lng));
    return ok;
  }

  private idxRemove(id: string): void {
    this.spatialIndex.remove(id);
    this.sink(this.mirror?.remove(id));
  }

  private sink(result: unknown): void {
    void Promise.resolve(result).catch(() => {});
  }

  public reset(newSpatialIndex: QuadTree): void {
    this.drivers.clear();
    this.spatialIndex = newSpatialIndex;
  }

  public isWithinBounds(lat: number, lng: number): boolean {
    const bounds = this.spatialIndex.root.bounds;
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= bounds.minLat &&
      lat <= bounds.maxLat &&
      lng >= bounds.minLng &&
      lng <= bounds.maxLng
    );
  }

  // Reconnection idempotency: preserves active trip and lock status if driver is already registered
  public registerDriver(
    id: string,
    lat: number,
    lng: number,
    status: DriverStatus = "offline",
  ): DriverRecord {
    const existing = this.drivers.get(id);
    if (existing) {
      existing.lastSeen = Date.now();
      return existing;
    }
    // A driver outside the active operating region must never be marked
    // available: it cannot be represented by this region's spatial index.
    const indexedStatus =
      status === "available" && !this.isWithinBounds(lat, lng)
        ? "offline"
        : status;
    const record: DriverRecord = {
      id,
      lat,
      lng,
      status: indexedStatus,
      lastSeen: Date.now(),
    };
    this.drivers.set(id, record);
    if (indexedStatus === "available") {
      this.idxInsert(id, lat, lng);
    }
    return record;
  }

  // Validate coordinates and update location with O(1) leaf-caching
  public updateLocation(id: string, lat: number, lng: number): boolean {
    const driver = this.drivers.get(id);
    if (!driver) {
      return false;
    }
    // Reject corrupt coordinates
    if (
      isNaN(lat) ||
      isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return false;
    }

    if (!this.isWithinBounds(lat, lng)) {
      return false;
    }

    driver.lat = lat;
    driver.lng = lng;
    driver.lastSeen = Date.now();

    this.cleanExpiredLockIfAny(driver);

    // Fast-path O(1) update only if available and not locked
    if (driver.status === "available" && !driver.lockToken) {
      // A driver can be absent after a region reset or a previously failed
      // insertion. Restore the spatial entry instead of silently accepting
      // telemetry for an undiscoverable driver.
      if (!this.idxUpdate(id, lat, lng)) {
        return this.idxInsert(id, lat, lng);
      }
    }
    return true;
  }

  // Offline/Busy toggle immediately clears lock and pulls from Quadtree
  public setStatus(id: string, newStatus: DriverStatus): boolean {
    const driver = this.drivers.get(id);
    if (!driver) {
      return false;
    }
    const oldStatus = driver.status;
    driver.lastSeen = Date.now();
    if (newStatus !== "available") {
      driver.status = newStatus;
      delete driver.lockToken;
      if (oldStatus === "available") {
        this.idxRemove(id);
      }
    } else if (!driver.lockToken) {
      if (!this.isWithinBounds(driver.lat, driver.lng)) {
        driver.status = "offline";
        return false;
      }
      driver.status = "available";
      if (!this.idxInsert(id, driver.lat, driver.lng)) {
        driver.status = "offline";
        return false;
      }
    } else {
      driver.status = "available";
    }
    return true;
  }

  // Automatic lock expiration and atomic claim
  public async acquireLock(
    driverId: string,
    requestId: string,
    ttlMs: number = 15000,
  ): Promise<boolean> {
    const driver = this.drivers.get(driverId);
    if (!driver || driver.status !== "available") {
      return false;
    }
    const now = Date.now();
    if (this.redisLock) {
      const acquired = await this.redisLock.acquireLock(driverId, requestId, ttlMs);
      if (!acquired) {
        return false;
      }
    } else {
      this.cleanExpiredLockIfAny(driver, now);
      if (driver.status !== "available" || driver.lockToken) {
        return false;
      }
    }
    driver.lockToken = {
      requestId,
      expiresAt: now + ttlMs,
    };
    this.idxRemove(driverId);
    return true;
  }
  // Safe lock release, only if requestId matches
  public async releaseLock(
    driverId: string,
    requestId: string
  ): Promise<boolean> {
    const driver = this.drivers.get(driverId);
    if (!driver) {
      return false;
    }
    if (driver.lockToken && driver.lockToken.requestId !== requestId) {
      return false;
    }
    if (this.redisLock) {
      const released = await this.redisLock.releaseLock(driverId, requestId);
      if (!released) {
        const holder = await this.redisLock.getLockHolder(driverId);
        if (holder && holder !== requestId) {
          return false;
        }
      }
    }
    delete driver.lockToken;
    // return driver to spatial search tree if still available
    if (driver.status === "available") {
      this.idxInsert(driverId, driver.lat, driver.lng);
    }
    return true;
  }

  // Atomic trip commit: rejects if rider cancelled or lock expired
  public async commitTrip(
    driverId: string,
    requestId: string,
  ): Promise<boolean> {
    const driver = this.drivers.get(driverId);
    if (!driver) {
      return false;
    }
    if (this.redisLock) {
      const commited = await this.redisLock.commitTrip(driverId, requestId);
      if (!commited) {
        return false;
      }
    } else {
      if (!driver.lockToken || driver.lockToken.requestId !== requestId) {
        return false;
      }
      const now = Date.now();
      if (driver.lockToken.expiresAt <= now) {
        await this.releaseLock(driverId, requestId);
        return false;
      }
    }
    delete driver.lockToken;
    driver.status = "busy";
    return true;
  }
  public async completeTrip(driverId: string): Promise<boolean> {
    if (this.redisLock) {
      await this.redisLock.releaseCommittedDriver(driverId, "available");
    }
    return this.setStatus(driverId, "available");
  }
  public findNearbyCandidates(
    lat: number,
    lng: number,
    k: number = 4,
    maxRadiusMeters: number = 10_000,
  ): CandidateDriver[] {
    const t0 = performance.now();
    const result = this.spatialIndex.kNearestNeighbors(
      lat,
      lng,
      k,
      maxRadiusMeters,
    );
    const latencyUs = (performance.now() - t0) * 1000;
    try {
      metrics.spatialQueryLatencyUs.observe({ engine: "ts" }, latencyUs);
      metrics.knnLatencySeconds.observe(
        { engine: "ts" },
        latencyUs / 1_000_000,
      );
    } catch {}
    return result;
  }

  /**
   * Evicts stale drivers that have not sent a heartbeat within the specified timeout (default 30s).
   */
  public evictStaleDrivers(heartBeatTimeoutMs: number = 30_000): string[] {
    const now = Date.now();
    const evictIds: string[] = [];
    for (const [id, driver] of this.drivers.entries()) {
      if (
        driver.status !== "offline" &&
        now - driver.lastSeen > heartBeatTimeoutMs
      ) {
        driver.status = "offline";
        delete driver.lockToken;
        this.idxRemove(id);
        evictIds.push(id);
      }
    }
    return evictIds;
  }

  public getDriver(id: string): DriverRecord | undefined {
    return this.drivers.get(id);
  }

  public get totalDrivers(): number {
    return this.drivers.size;
  }

  private cleanExpiredLockIfAny(
    driver: DriverRecord,
    now: number = Date.now(),
  ): void {
    if (driver.lockToken && driver.lockToken.expiresAt <= now) {
      delete driver.lockToken;
      if (driver.status === "available") {
        this.idxInsert(driver.id, driver.lat, driver.lng);
      }
    }
  }
}
