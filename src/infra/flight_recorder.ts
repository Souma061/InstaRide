import cassandra from "cassandra-driver";
import { getCassandraClient } from "./cassandra_client.js";
import { StateTransitionEvent, Trip } from "../core/trip_state_machine.js";

export interface BreadcrumbRecord {
  driverId: string;
  date: string; // YYYY-MM-DD
  timestamp: Date;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  status: string;
}

export interface FlightRecorderOptions {
  batchSize?: number;
  flushIntervalMs?: number;
}

export class CassandraFlightRecorder {
  private client: cassandra.Client;
  private breadcrumbBuffer: BreadcrumbRecord[] = [];
  private auditBuffer: StateTransitionEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  private readonly insertBreadcrumbCql = `
    INSERT INTO instaride.driver_breadcrumbs (driver_id, date, timestamp, lat, lng, speed, heading, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  private readonly insertAuditCql = `
    INSERT INTO instaride.trip_audit_log (trip_id, timestamp, from_status, to_status, triggered_by, reason, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  constructor(options: FlightRecorderOptions = {}) {
    this.client = getCassandraClient();
    this.batchSize = options.batchSize || 100;
    this.flushIntervalMs = options.flushIntervalMs || 100;

    this.startAutoFlush();
  }

  private startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error("[FlightRecorder] Auto-flush error:", err);
      });
    }, this.flushIntervalMs);
  }

  /**
   * Non-blocking ingestion of driver GPS coordinates.
   */
  public recordBreadcrumbs(
    updates: Array<{ id: string; lat: number; lng: number; status: string; speed?: number; heading?: number }>,
    now: Date = new Date()
  ): void {
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    for (const update of updates) {
      this.breadcrumbBuffer.push({
        driverId: update.id,
        date: dateStr,
        timestamp: now,
        lat: update.lat,
        lng: update.lng,
        speed: update.speed || 0,
        heading: update.heading || 0,
        status: update.status,
      });
    }

    if (this.breadcrumbBuffer.length >= this.batchSize) {
      this.flush().catch((err) => {
        console.error("[FlightRecorder] Buffer threshold flush error:", err);
      });
    }
  }

  /**
   * Non-blocking ingestion of trip state transitions.
   */
  public recordTripTransition(event: StateTransitionEvent): void {
    this.auditBuffer.push(event);

    if (this.auditBuffer.length >= this.batchSize) {
      this.flush().catch((err) => {
        console.error("[FlightRecorder] Audit threshold flush error:", err);
      });
    }
  }

  /**
   * Asynchronously flushes in-memory buffers into Cassandra.
   */
  public async flush(): Promise<void> {
    if (this.isFlushing) return;
    if (this.breadcrumbBuffer.length === 0 && this.auditBuffer.length === 0) return;

    this.isFlushing = true;
    const breadcrumbsToFlush = this.breadcrumbBuffer.splice(0, this.breadcrumbBuffer.length);
    const auditsToFlush = this.auditBuffer.splice(0, this.auditBuffer.length);

    try {
      const promises: Promise<any>[] = [];

      // 1. Flush Breadcrumbs grouped by Partition (driver_id + date)
      if (breadcrumbsToFlush.length > 0) {
        const partitionGroups = new Map<string, BreadcrumbRecord[]>();
        for (const record of breadcrumbsToFlush) {
          const key = `${record.driverId}:${record.date}`;
          if (!partitionGroups.has(key)) {
            partitionGroups.set(key, []);
          }
          partitionGroups.get(key)!.push(record);
        }

        for (const [, records] of partitionGroups.entries()) {
          const batch = records.map((r) => ({
            query: this.insertBreadcrumbCql,
            params: [r.driverId, r.date, r.timestamp, r.lat, r.lng, r.speed, r.heading, r.status],
          }));

          promises.push(
            this.client.batch(batch, { prepare: true, logged: false })
          );
        }
      }

      // 2. Flush Audit Logs
      if (auditsToFlush.length > 0) {
        for (const audit of auditsToFlush) {
          promises.push(
            this.client.execute(
              this.insertAuditCql,
              [
                audit.tripId,
                new Date(audit.timestamp),
                audit.fromStatus,
                audit.toStatus,
                audit.triggeredBy,
                audit.reason || "",
                audit.payload ? JSON.stringify(audit.payload) : "",
              ],
              { prepare: true }
            )
          );
        }
      }

      await Promise.all(promises);
    } catch (error) {
      console.error("[FlightRecorder] Error during flush:", error);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Retrieves millisecond breadcrumb trail for a specific driver and date.
   */
  public async getDriverBreadcrumbs(
    driverId: string,
    date: string,
    limit: number = 50
  ): Promise<any[]> {
    const query = `
      SELECT driver_id, date, timestamp, lat, lng, speed, heading, status
      FROM instaride.driver_breadcrumbs
      WHERE driver_id = ? AND date = ?
      LIMIT ?
    `;
    const result = await this.client.execute(query, [driverId, date, limit], { prepare: true });
    return result.rows;
  }

  /**
   * Retrieves chronological audit lifecycle journal for a specific trip.
   */
  public async getTripAuditLog(tripId: string): Promise<any[]> {
    const query = `
      SELECT trip_id, timestamp, from_status, to_status, triggered_by, reason, payload
      FROM instaride.trip_audit_log
      WHERE trip_id = ?
    `;
    const result = await this.client.execute(query, [tripId], { prepare: true });
    return result.rows;
  }

  public async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

