export type TripStatus =
  | "requested"
  | "matching"
  | "matched"
  | "en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled";

export type ActorRole = "rider" | "driver" | "system";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Trip {
  id: string;
  requestId: string;
  riderId: string;
  driverId: string | null;
  status: TripStatus;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  createdAt: number;
  matchedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  cancellationReason: string | null;
  cancelledBy: ActorRole | null;
}

export interface StateTransitionEvent {
  tripId: string;
  requestId: string;
  fromStatus: TripStatus;
  toStatus: TripStatus;
  triggeredBy: ActorRole;
  timestamp: number;
  reason?: string;
  payload?: Record<string, any>;
}

export interface TransitionResult {
  success: boolean;
  trip?: Trip;
  event?: StateTransitionEvent;
  error?: string;
}

/**
 * State Transition Matrix:
 * - en_route and arrived can transition back to matching (driver breakdown auto-rematch)
 * - in_progress allows only completed (cancellation strictly blocked once rider onboard)
 */
const ALLOWED_TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  requested: ["matching", "cancelled"],
  matching: ["matched", "cancelled"],
  matched: ["en_route", "arrived", "cancelled"],
  en_route: ["arrived", "matching", "cancelled"],
  arrived: ["in_progress", "matching", "cancelled"],
  in_progress: ["completed"], // no cancellation allowed once rider onboard
  completed: [],
  cancelled: [],
};

export class TripStateMachine {
  private readonly trips = new Map<string, Trip>();
  private readonly requestToTrip = new Map<string, string>();
  private readonly activeRiderTrips = new Map<string, string>();
  private readonly activeDriverTrips = new Map<string, string>();

  private readonly maxAuditBufferSize = 2000;
  private readonly auditEvents: StateTransitionEvent[] = [];

  /**
   * Creates a new trip. Rejects if rider already has an active trip.
   * Handles idempotent re-submission if the requestId was already registered.
   */
  public createTrip(params: {
    requestId: string;
    riderId: string;
    pickup: GeoPoint;
    dropoff: GeoPoint;
  }): { success: boolean; trip?: Trip; error?: string } {
    // Check if requestId is idempotent replay
    const existingTripId = this.requestToTrip.get(params.requestId);
    if (existingTripId) {
      const existingTrip = this.trips.get(existingTripId);
      if (existingTrip) {
        return { success: true, trip: existingTrip };
      }
      return { success: false, error: "Existing trip record not found" };
    }

    // Check if rider already has an active trip
    if (this.activeRiderTrips.has(params.riderId)) {
      return {
        success: false,
        error: `Rider ${params.riderId} already has an active trip`,
      };
    }

    const trip: Trip = {
      id: `trip_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      requestId: params.requestId,
      riderId: params.riderId,
      status: "requested",
      driverId: null,
      pickup: params.pickup,
      dropoff: params.dropoff,
      createdAt: Date.now(),
      matchedAt: null,
      arrivedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      cancelledBy: null,
    };

    this.trips.set(trip.id, trip);
    this.requestToTrip.set(params.requestId, trip.id);
    this.activeRiderTrips.set(params.riderId, trip.id);

    this.recordEvent({
      tripId: trip.id,
      requestId: trip.requestId,
      fromStatus: "requested",
      toStatus: "requested",
      triggeredBy: "rider",
      timestamp: trip.createdAt,
    });

    return { success: true, trip };
  }

  /**
   * Atomic transition of trip status with role checks, lifecycle validation,
   * and index synchronizations.
   */
  public transition(
    tripId: string,
    targetStatus: TripStatus,
    triggeredBy: ActorRole,
    reason?: string,
    payload?: Record<string, any>,
  ): TransitionResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: `Trip ${tripId} not found` };
    }

    const currentStatus = trip.status;

    // Idempotent no-op (return success cleanly without error message)
    if (currentStatus === targetStatus) {
      return { success: true, trip };
    }

    const validTargets = ALLOWED_TRANSITIONS[currentStatus];
    if (!validTargets.includes(targetStatus)) {
      return {
        success: false,
        trip,
        error: `Invalid transition from ${currentStatus} to ${targetStatus}`,
      };
    }

    // Role authorization checks
    if (targetStatus === "arrived" && triggeredBy !== "driver") {
      return {
        success: false,
        trip,
        error: "Only driver can mark trip as arrived",
      };
    }

    if (targetStatus === "in_progress" && triggeredBy !== "driver") {
      return {
        success: false,
        trip,
        error: "Only driver can mark trip as in_progress",
      };
    }

    if (targetStatus === "completed" && triggeredBy !== "driver") {
      return {
        success: false,
        trip,
        error: "Only driver can mark trip as completed",
      };
    }

    // Cancellation guard: driver cannot cancel a requested/matching trip before assignment
    if (targetStatus === "cancelled") {
      if (
        (currentStatus === "requested" || currentStatus === "matching") &&
        triggeredBy === "driver"
      ) {
        return {
          success: false,
          trip,
          error: "Driver cannot cancel an unassigned trip",
        };
      }
    }

    const now = Date.now();

    // Handle milestones and index updates
    switch (targetStatus) {
      case "matching":
        // Fallback / rematch: reset driver and match timestamps
        if (trip.driverId) {
          this.activeDriverTrips.delete(trip.driverId);
          trip.driverId = null;
        }
        trip.matchedAt = null;
        trip.arrivedAt = null;
        break;

      case "matched": {
        const newDriverId = payload?.driverId;
        if (typeof newDriverId !== "string" || !newDriverId.trim()) {
          return {
            success: false,
            trip,
            error:
              "Cannot transition to matched without valid driverId in payload",
          };
        }

        // Driver double-booking guard
        const existingActiveTrip = this.activeDriverTrips.get(newDriverId);
        if (existingActiveTrip && existingActiveTrip !== trip.id) {
          return {
            success: false,
            trip,
            error: `Driver ${newDriverId} already has an active trip`,
          };
        }

        trip.matchedAt = now;
        trip.driverId = newDriverId;
        this.activeDriverTrips.set(newDriverId, trip.id);
        break;
      }

      case "arrived":
        trip.arrivedAt = now;
        break;

      case "in_progress":
        trip.startedAt = now;
        break;

      case "completed":
        trip.completedAt = now;
        this.clearActiveIndices(trip);
        break;

      case "cancelled":
        trip.cancelledAt = now;
        trip.cancellationReason = reason || null;
        trip.cancelledBy = triggeredBy;
        this.clearActiveIndices(trip);
        break;
    }

    trip.status = targetStatus;

    const event: StateTransitionEvent = {
      tripId: trip.id,
      requestId: trip.requestId,
      fromStatus: currentStatus,
      toStatus: targetStatus,
      triggeredBy,
      timestamp: now,
      reason,
      payload,
    };

    this.recordEvent(event);
    return { success: true, trip, event };
  }

  // Convenience methods
  public startMatching(tripId: string): TransitionResult {
    return this.transition(tripId, "matching", "system");
  }

  public setMatched(tripId: string, driverId: string): TransitionResult {
    return this.transition(tripId, "matched", "system", undefined, {
      driverId,
    });
  }

  public driverEnRoute(tripId: string): TransitionResult {
    return this.transition(tripId, "en_route", "driver");
  }

  public driverArrived(tripId: string): TransitionResult {
    return this.transition(tripId, "arrived", "driver");
  }

  public startTrip(tripId: string): TransitionResult {
    return this.transition(tripId, "in_progress", "driver");
  }

  public completeTrip(tripId: string): TransitionResult {
    return this.transition(tripId, "completed", "driver");
  }

  public cancelTrip(
    tripId: string,
    cancelledBy: ActorRole,
    reason?: string,
  ): TransitionResult {
    return this.transition(tripId, "cancelled", cancelledBy, reason);
  }

  public rematchTrip(tripId: string, reason?: string): TransitionResult {
    return this.transition(tripId, "matching", "system", reason);
  }

  public getTrip(tripId: string): Trip | undefined {
    return this.trips.get(tripId);
  }

  public getTripByRequestId(requestId: string): Trip | undefined {
    const tripId = this.requestToTrip.get(requestId);
    if (!tripId) {
      return undefined;
    }
    return this.trips.get(tripId);
  }

  public getAuditEvents(): StateTransitionEvent[] {
    return [...this.auditEvents];
  }

  public getActiveTripForRider(riderId: string): Trip | undefined {
    const tripId = this.activeRiderTrips.get(riderId);
    if (!tripId) {
      return undefined;
    }
    return this.trips.get(tripId);
  }

  public getActiveTripForDriver(driverId: string): Trip | undefined {
    const tripId = this.activeDriverTrips.get(driverId);
    if (!tripId) {
      return undefined;
    }
    return this.trips.get(tripId);
  }

  public getRecentAuditEvents(
    count: number = 50,
  ): readonly StateTransitionEvent[] {
    return this.auditEvents.slice(-count);
  }

  private clearActiveIndices(trip: Trip): void {
    this.activeRiderTrips.delete(trip.riderId);
    if (trip.driverId) {
      this.activeDriverTrips.delete(trip.driverId);
    }
  }

  private recordEvent(event: StateTransitionEvent): void {
    if (this.auditEvents.length >= this.maxAuditBufferSize) {
      this.auditEvents.shift();
    }
    this.auditEvents.push(event);
  }
}
