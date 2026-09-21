import { CandidateDriver, QuadTree } from "../spatial/quadtree.js";

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

export class DriverRegistry {
  private readonly drivers = new Map<string, DriverRecord>();
  private spatialIndex: QuadTree;

  constructor(spatialIndex: QuadTree) {
    this.spatialIndex = spatialIndex;
  }

  public reset(newSpatialIndex: QuadTree): void {
    this.drivers.clear();
    this.spatialIndex = newSpatialIndex;
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
    const record: DriverRecord = {
      id,
      lat,
      lng,
      status,
      lastSeen: Date.now(),
    };
    this.drivers.set(id, record);
    if (status === "available") {
      this.spatialIndex.insert(id, lat, lng);
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

    driver.lat = lat;
    driver.lng = lng;
    driver.lastSeen = Date.now();

    this.cleanExpiredLockIfAny(driver);

    // Fast-path O(1) update only if available and not locked
    if (driver.status === "available" && !driver.lockToken) {
      this.spatialIndex.update(id, lat, lng);
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
    driver.status = newStatus;
    driver.lastSeen = Date.now();
    if (newStatus !== "available") {
      delete driver.lockToken;
      if (oldStatus === "available") {
        this.spatialIndex.remove(id);
      }
    } else if (!driver.lockToken) {
      this.spatialIndex.insert(id, driver.lat, driver.lng);
    }
    return true;
  }

  // Automatic lock expiration and atomic claim
  public acquireLock(
    driverId: string,
    requestId: string,
    ttlMs: number = 15_000,
  ): boolean {
    const driver = this.drivers.get(driverId);
    if (!driver || driver.status !== "available") {
      return false;
    }
    const now = Date.now();
    this.cleanExpiredLockIfAny(driver, now);
    if (driver.status !== "available" || driver.lockToken) {
      return false;
    }
    driver.lockToken = {
      requestId,
      expiresAt: now + ttlMs,
    };
    this.spatialIndex.remove(driverId);
    return true;
  }

  // Safe lock release, only if requestId matches
  public releaseLock(driverId: string, requestId: string): boolean {
    const driver = this.drivers.get(driverId);
    if (
      !driver ||
      !driver.lockToken ||
      driver.lockToken.requestId !== requestId
    ) {
      return false;
    }
    delete driver.lockToken;
    if (driver.status === "available") {
      this.spatialIndex.insert(driverId, driver.lat, driver.lng);
    }
    return true;
  }

  // Atomic trip commit: rejects if rider cancelled or lock expired
  public commitTrip(driverId: string, requestId: string): boolean {
    const driver = this.drivers.get(driverId);
    if (
      !driver ||
      !driver.lockToken ||
      driver.lockToken.requestId !== requestId
    ) {
      return false;
    }
    const now = Date.now();
    // Offer expired
    if (driver.lockToken.expiresAt <= now) {
      this.releaseLock(driverId, requestId);
      return false;
    }
    delete driver.lockToken;
    driver.status = "busy";
    return true;
  }

  public completeTrip(driverId: string): boolean {
    return this.setStatus(driverId, "available");
  }

  public findNearbyCandidates(
    lat: number,
    lng: number,
    k: number = 4,
    maxRadiusMeters: number = 10_000,
  ): CandidateDriver[] {
    return this.spatialIndex.kNearestNeighbors(lat, lng, k, maxRadiusMeters);
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
        this.spatialIndex.remove(id);
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
        this.spatialIndex.insert(driver.id, driver.lat, driver.lng);
      }
    }
  }
}
