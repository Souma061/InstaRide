import { DriverRegistry } from "../core/driver_registry.js";
import { MatchingService } from "../core/matching_service.js";
import { TripStateMachine } from "../core/trip_state_machine.js";
import { GeoBounds } from "../spatial/quadtree.js";

interface VirtualDriver {
  id: string;
  lat: number;
  lng: number;
  vx: number;
  vy: number;
  activeTripId: string | null;
  targetLat: number | null;
  targetLng: number | null;
  phase: "wandering" | "en_route" | "in_progress";
}

export class DriverSimulator {
  private bounds: GeoBounds;
  private readonly registry: DriverRegistry;
  private readonly stateMachine: TripStateMachine;
  private matchingService!: MatchingService;

  private readonly virtualDrivers = new Map<string, VirtualDriver>();
  private tickInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  public resetRegion(bounds: GeoBounds, driverCount: number = 40): void {
    this.stop();
    this.bounds = bounds;
    this.virtualDrivers.clear();
    this.start(driverCount);
  }

  public onTelemetryTick?: (
    updates: Array<{ id: string; lat: number; lng: number; status: string }>,
  ) => void;

  constructor(
    bounds: GeoBounds,
    registry: DriverRegistry,
    stateMachine: TripStateMachine,
  ) {
    this.bounds = bounds;
    this.registry = registry;
    this.stateMachine = stateMachine;
  }

  public setMatchingService(matchingService: MatchingService): void {
    this.matchingService = matchingService;
  }

  /**
   * Spawns N simulated drivers across the bounds and begins telemetry ticks.
   */
  public start(driverCount: number = 40, tickRateMs: number = 1000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    for (let i = 1; i <= driverCount; i++) {
      const id = `sim_driver_${i}`;
      const lat =
        this.bounds.minLat +
        Math.random() * (this.bounds.maxLat - this.bounds.minLat);
      const lng =
        this.bounds.minLng +
        Math.random() * (this.bounds.maxLng - this.bounds.minLng);

      const driver: VirtualDriver = {
        id,
        lat,
        lng,
        vx: (Math.random() - 0.5) * 0.0003,
        vy: (Math.random() - 0.5) * 0.0003,
        activeTripId: null,
        targetLat: null,
        targetLng: null,
        phase: "wandering",
      };

      this.virtualDrivers.set(id, driver);
      this.registry.registerDriver(id, lat, lng, "available");
    }

    this.tickInterval = setInterval(() => this.tick(), tickRateMs);
    console.log(
      `[DriverSimulator] Seeded ${driverCount} virtual drivers. GPS tick rate: ${tickRateMs}ms`,
    );
  }

  public stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.isRunning = false;
    console.log("[DriverSimulator] Stopped.");
  }

  /**
   * Simulated driver response to incoming match offer.
   * 85% accept, 15% reject to showcase fallback loop in action.
   */
  public handleIncomingOffer(driverId: string, requestId: string): void {
    const vDriver = this.virtualDrivers.get(driverId);
    if (!vDriver) return;

    // Simulate human reaction time between 1.2s and 2.8s
    const reactionTimeMs = 1200 + Math.random() * 1600;
    const willAccept = Math.random() < 0.85;

    setTimeout(() => {
      if (willAccept) {
        this.matchingService.handleDriverResponse(
          driverId,
          requestId,
          "accepted",
        );
      } else {
        console.log(
          `[Simulator] Driver ${driverId} rejected offer ${requestId} (triggering fallback)`,
        );
        this.matchingService.handleDriverResponse(
          driverId,
          requestId,
          "rejected",
        );
      }
    }, reactionTimeMs);
  }

  /**
   * Called when a trip is matched to guide the virtual driver along pickup and dropoff.
   */
  public onTripAssigned(driverId: string, trip: any): void {
    const vDriver = this.virtualDrivers.get(driverId);
    if (!vDriver) return;

    vDriver.activeTripId = trip.id;
    vDriver.targetLat = trip.pickup.lat;
    vDriver.targetLng = trip.pickup.lng;
    vDriver.phase = "en_route";

    this.stateMachine.driverEnRoute(trip.id);
  }

  /**
   * Main telemetry update loop.
   */
  private tick(): void {
    const updates: Array<{
      id: string;
      lat: number;
      lng: number;
      status: string;
    }> = [];

    for (const d of this.virtualDrivers.values()) {
      if (d.phase === "wandering") {
        // Wandering around city
        d.lat += d.vy;
        d.lng += d.vx;

        // Bounce at boundaries
        if (d.lat < this.bounds.minLat || d.lat > this.bounds.maxLat)
          d.vy *= -1;
        if (d.lng < this.bounds.minLng || d.lng > this.bounds.maxLng)
          d.vx *= -1;

        this.registry.updateLocation(d.id, d.lat, d.lng);
      } else if (
        d.phase === "en_route" &&
        d.targetLat &&
        d.targetLng &&
        d.activeTripId
      ) {
        // Driving towards rider pickup point
        d.lat += (d.targetLat - d.lat) * 0.15;
        d.lng += (d.targetLng - d.lng) * 0.15;
        this.registry.updateLocation(d.id, d.lat, d.lng);

        // Check if arrived at pickup (within ~30 meters)
        if (Math.hypot(d.targetLat - d.lat, d.targetLng - d.lng) < 0.0004) {
          d.phase = "in_progress";
          this.stateMachine.driverArrived(d.activeTripId);

          const trip = this.stateMachine.getTrip(d.activeTripId);
          if (trip) {
            d.targetLat = trip.dropoff.lat;
            d.targetLng = trip.dropoff.lng;

            // Wait 2s passenger boarding, then start trip
            setTimeout(() => {
              if (d.activeTripId) {
                this.stateMachine.startTrip(d.activeTripId);
              }
            }, 2000);
          }
        }
      } else if (
        d.phase === "in_progress" &&
        d.targetLat &&
        d.targetLng &&
        d.activeTripId
      ) {
        // Driving towards dropoff point
        d.lat += (d.targetLat - d.lat) * 0.12;
        d.lng += (d.targetLng - d.lng) * 0.12;
        this.registry.updateLocation(d.id, d.lat, d.lng);

        // Check if arrived at dropoff
        if (Math.hypot(d.targetLat - d.lat, d.targetLng - d.lng) < 0.0004) {
          const finishedTripId = d.activeTripId;
          d.phase = "wandering";
          d.activeTripId = null;
          d.targetLat = null;
          d.targetLng = null;

          this.stateMachine.completeTrip(finishedTripId);
          this.registry.completeTrip(d.id);
        }
      }

      const status = this.registry.getDriver(d.id)?.status ?? "available";
      updates.push({ id: d.id, lat: d.lat, lng: d.lng, status });
    }

    this.onTelemetryTick?.(updates);
  }

  public getAllVirtualDrivers(): VirtualDriver[] {
    return Array.from(this.virtualDrivers.values());
  }
}
