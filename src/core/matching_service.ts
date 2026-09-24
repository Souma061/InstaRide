import { CandidateDriver } from "../spatial/quadtree.js";
import { DriverRegistry } from "./driver_registry.js";
import { RedisTripStore } from "./redis_trip_store.js";
import {
  ActorRole,
  GeoPoint,
  Trip,
  TripStateMachine,
} from "./trip_state_machine.js";

export interface OfferNotification {
  driverId: string;
  requestId: string;
  tripId: string;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  expiresAt: number;
  distanceMeters: number;
}

export interface MatchingServiceEvents {
  onOfferDispatched?: (notification: OfferNotification) => void;
  onOfferRevoked?: (
    driverId: string,
    requestId: string,
    reason: string,
  ) => void;
  onTripMatched?: (trip: Trip, driverId: string) => void;
  onMatchFailed?: (requestId: string, reason: string) => void;
}

export interface RequestRideParams {
  requestId: string;
  riderId: string;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  k?: number;
  maxRadiusMeters?: number;
  offerTimeoutMs?: number;
}

interface PendingOffer {
  driverId: string;
  requestId: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  resolve: (
    response: "accepted" | "rejected" | "timed_out" | "cancelled",
  ) => void;
}

export class MatchingService {
  private readonly driverRegistry: DriverRegistry;
  private readonly stateMachine: TripStateMachine;
  private readonly events: MatchingServiceEvents;
  private readonly tripStore?: RedisTripStore;

  // Active in-flight offers mapped by requestId
  private readonly activeOffers = new Map<string, PendingOffer>();
  // Set of cancelled requestIds to halt background candidate loops
  private readonly abortedRequests = new Set<string>();

  constructor(
    driverRegistry: DriverRegistry,
    stateMachine: TripStateMachine,
    events: MatchingServiceEvents = {},
    tripStore?: RedisTripStore,
  ) {
    this.driverRegistry = driverRegistry;
    this.stateMachine = stateMachine;
    this.events = events;
    this.tripStore = tripStore;
  }

  /**
   * Initiates a ride request and begins candidate dispatch loop.
   */
  public async requestRide(params: RequestRideParams): Promise<{
    success: boolean;
    trip?: Trip;
    error?: string;
  }> {
    // 1. Create trip in state machine (validates rider active trip & idempotency)
    const tripResult = this.stateMachine.createTrip({
      requestId: params.requestId,
      riderId: params.riderId,
      pickup: params.pickup,
      dropoff: params.dropoff,
    });

    if (!tripResult.success || !tripResult.trip) {
      return { success: false, error: tripResult.error };
    }

    const trip = tripResult.trip;
    if (this.tripStore) {
      const storeRes = await this.tripStore.createTrip(trip);
      if (!storeRes.success) {
        //rollback local state if redis rejected(e.g rider active on another node)
        this.stateMachine.cancelTrip(trip.id, "system", storeRes.error);
        return { success: false, error: storeRes.error };
      }
    }

    // Idempotent re-submission check: if trip is already beyond requested, return existing
    if (trip.status !== "requested") {
      return { success: true, trip };
    }

    // 2. Transition to matching
    const matchTransition = this.stateMachine.startMatching(trip.id);
    if (!matchTransition.success) {
      return { success: false, error: matchTransition.error, trip };
    }

    this.abortedRequests.delete(params.requestId);

    // 3. Kick off the asynchronous offer loop
    this.dispatchOfferLoop(trip, {
      k: params.k ?? 4,
      maxRadiusMeters: params.maxRadiusMeters ?? 10_000,
      offerTimeoutMs: params.offerTimeoutMs ?? 15_000,
    }).catch((err) => {
      console.error(
        `[MatchingService] Error in offer loop for ${trip.id}:`,
        err,
      );
    });

    return { success: true, trip };
  }

  /**
   * Driver response ingestion (Accept or Reject).
   * Atomically verifies the lock lease before granting the match.
   */
  public handleDriverResponse(
    driverId: string,
    requestId: string,
    response: unknown,
  ): { success: boolean; error?: string } {
    if (response !== "accepted" && response !== "rejected") {
      return {
        success: false,
        error: "INVALID_RESPONSE: expected accepted or rejected",
      };
    }
    const pendingOffer = this.activeOffers.get(requestId);

    // Strict 15.000s boundary check: if offer expired or was reassigned
    if (!pendingOffer || pendingOffer.driverId !== driverId) {
      return {
        success: false,
        error: "OFFER_EXPIRED: Ride offer has expired or was reassigned",
      };
    }

    const now = Date.now();
    if (now >= pendingOffer.expiresAt) {
      // Clean up timer and resolve as timed out
      clearTimeout(pendingOffer.timer);
      this.activeOffers.delete(requestId);
      pendingOffer.resolve("timed_out");
      return {
        success: false,
        error: "OFFER_EXPIRED: Response arrived after deadline",
      };
    }

    clearTimeout(pendingOffer.timer);
    this.activeOffers.delete(requestId);
    pendingOffer.resolve(response);

    return { success: true };
  }

  /**
   * Rider or system cancels ride. Revokes any pending driver lock immediately.
   */
  // public cancelRide(
  //   requestId: string,
  //   cancelledBy: ActorRole = "rider",
  //   reason?: string,
  // ): { success: boolean; error?: string } {
  //   this.abortedRequests.add(requestId);

  //   const pendingOffer = this.activeOffers.get(requestId);
  //   if (pendingOffer) {
  //     clearTimeout(pendingOffer.timer);
  //     this.activeOffers.delete(requestId);

  //     // Release the driver's atomic lock and return them to the Quadtree
  //     void
  //     this.driverRegistry.releaseLock(pendingOffer.driverId, requestId);

  //     // Notify driver client that the offer was revoked
  //     this.events.onOfferRevoked?.(
  //       pendingOffer.driverId,
  //       requestId,
  //       reason || "Rider cancelled request",
  //     );

  //     pendingOffer.resolve("cancelled");
  //   }

  //   const trip = this.stateMachine.getTripByRequestId(requestId);
  //   if (trip) {
  //     const assignedDriverId = trip.driverId;
  //     const cancelRes = this.stateMachine.cancelTrip(
  //       trip.id,
  //       cancelledBy,
  //       reason,
  //     );
  //     if (cancelRes.success && assignedDriverId) {
  //       this.driverRegistry.completeTrip(assignedDriverId);
  //     }
  //     return cancelRes;
  //   }

  //   return { success: true };
  // }
  public async cancelRide(
    requestId: string,
    cancelledBy: ActorRole = "rider",
    reason?: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.abortedRequests.add(requestId);
    const pendingOffer = this.activeOffers.get(requestId);
    if (pendingOffer) {
      clearTimeout(pendingOffer.timer);
      this.activeOffers.delete(requestId);
      await this.driverRegistry.releaseLock(pendingOffer.driverId, requestId);
      this.events.onOfferRevoked?.(
        pendingOffer.driverId,
        requestId,
        reason || "Rider cancelled request",
      );
      pendingOffer.resolve("cancelled");
    }
    const trip = this.stateMachine.getTripByRequestId(requestId);
    if (trip) {
      const assignedDriverId = trip.driverId;
      const cancelResult = this.stateMachine.cancelTrip(
        trip.id,
        cancelledBy,
        reason,
      );
      if (cancelResult.success && assignedDriverId) {
        await this.driverRegistry.completeTrip(assignedDriverId);
      }
      if (this.tripStore) {
        await this.tripStore.saveTrip(trip);
      }
      return cancelResult;
    }
    return { success: true };
  }
  /** Cancels in-flight work before replacing the spatial region. */
  public reset(reason: string = "Operating region was reset"): void {
    const activeTrips = this.stateMachine.getActiveTrips();
    for (const trip of activeTrips) {
      this.abortedRequests.add(trip.requestId);
    }

    for (const [requestId, offer] of this.activeOffers) {
      clearTimeout(offer.timer);
      this.activeOffers.delete(requestId);
      this.driverRegistry.releaseLock(offer.driverId, requestId);
      this.events.onOfferRevoked?.(offer.driverId, requestId, reason);
      offer.resolve("cancelled");
    }

    for (const trip of activeTrips) {
      const assignedDriverId = trip.driverId;
      const result = this.stateMachine.cancelTrip(trip.id, "system", reason);
      if (result.success && assignedDriverId) {
        this.driverRegistry.completeTrip(assignedDriverId);
      }
    }
  }

  /**
   * Handles automatic rematch when an assigned driver cancels or drops connection.
   */
  public async rematch(
    tripId: string,
    reason?: string,
    options?: { k?: number; maxRadiusMeters?: number; offerTimeoutMs?: number },
  ): Promise<{ success: boolean; error?: string }> {
    const trip = this.stateMachine.getTrip(tripId);
    if (!trip) {
      return { success: false, error: `Trip ${tripId} not found` };
    }

    const rematchRes = this.stateMachine.rematchTrip(tripId, reason);
    if (!rematchRes.success) {
      return { success: false, error: rematchRes.error };
    }

    this.abortedRequests.delete(trip.requestId);

    this.dispatchOfferLoop(trip, {
      k: options?.k ?? 4,
      maxRadiusMeters: options?.maxRadiusMeters ?? 10_000,
      offerTimeoutMs: options?.offerTimeoutMs ?? 15_000,
    }).catch((err) => {
      console.error(
        `[MatchingService] Error in rematch loop for ${tripId}:`,
        err,
      );
    });

    return { success: true };
  }

  /**
   * The candidate offer loop:
   * 1. Fetches top K nearest available drivers via QuadTree.
   * 2. Sequentially acquires lock on candidate #i.
   * 3. Awaits 15s driver response.
   * 4. On accept -> commits trip & matches.
   * 5. On reject/timeout -> releases lock and immediately falls back to candidate #i+1.
   */
  private async dispatchOfferLoop(
    trip: Trip,
    config: { k: number; maxRadiusMeters: number; offerTimeoutMs: number },
  ): Promise<void> {
    const candidates = this.driverRegistry.findNearbyCandidates(
      trip.pickup.lat,
      trip.pickup.lng,
      config.k,
      config.maxRadiusMeters,
    );

    if (candidates.length === 0) {
      this.stateMachine.cancelTrip(
        trip.id,
        "system",
        "No available drivers in search radius",
      );
      if (this.tripStore) {
        await this.tripStore.saveTrip(trip);
      }
      this.events.onMatchFailed?.(
        trip.requestId,
        "No available drivers in search radius",
      );
      return;
    }

    for (let i = 0; i < candidates.length; i++) {
      // Check if rider cancelled while loop was waiting
      if (this.abortedRequests.has(trip.requestId)) {
        return;
      }

      const candidate = candidates[i];

      // Try acquiring atomic lock on candidate
      const locked = await this.driverRegistry.acquireLock(
        candidate.id,
        trip.requestId,
        config.offerTimeoutMs,
      );

      if (!locked) {
        // Driver was claimed by competing request or became unavailable
        continue;
      }

      // Wait for driver response, timeout, or cancellation
      const outcome = await this.awaitCandidateOffer(
        candidate,
        trip,
        config.offerTimeoutMs,
      );
      if (
        this.abortedRequests.has(trip.requestId) ||
        trip.status !== "matching"
      ) {
        await this.driverRegistry.releaseLock(candidate.id, trip.requestId);
        return;
      }

      if (outcome === "accepted") {
        // Atomic CAS commit
        const committed = await this.driverRegistry.commitTrip(
          candidate.id,
          trip.requestId,
        );

        if (committed) {
          const matchResult = this.stateMachine.setMatched(
            trip.id,
            candidate.id,
          );
          if (matchResult.success && matchResult.trip) {
            if (this.tripStore) {
              await this.tripStore.saveTrip(matchResult.trip);
            }
            this.events.onTripMatched?.(matchResult.trip, candidate.id);
            return; // Successful match!
          }
          // If setMatched failed (e.g. race condition), rollback the committed driver back to available
          await this.driverRegistry.completeTrip(candidate.id);
        } else {
          // Commit failed (e.g. lock expired before commit)
          await this.driverRegistry.releaseLock(candidate.id, trip.requestId);
        }
      } else if (outcome === "rejected" || outcome === "timed_out") {
        // Release lock so driver returns to Quadtree for other riders
        await this.driverRegistry.releaseLock(candidate.id, trip.requestId);

        if (outcome === "timed_out") {
          this.events.onOfferRevoked?.(
            candidate.id,
            trip.requestId,
            "Offer timed out",
          );
        }
        // Loop proceeds immediately to candidate #i+1 (fallback)
      } else if (outcome === "cancelled") {
        return;
      }
    }

    // If loop finishes with no driver accepting
    if (!this.abortedRequests.has(trip.requestId)) {
      this.stateMachine.cancelTrip(
        trip.id,
        "system",
        "All candidate drivers declined or timed out",
      );
      if (this.tripStore) {
        await this.tripStore.saveTrip(trip);
      }
      this.events.onMatchFailed?.(
        trip.requestId,
        "All candidate drivers declined or timed out",
      );
    }
  }

  /**
   * Sets up the 15-second deferred offer promise and pushes notification.
   */
  private awaitCandidateOffer(
    candidate: CandidateDriver,
    trip: Trip,
    timeoutMs: number,
  ): Promise<"accepted" | "rejected" | "timed_out" | "cancelled"> {
    return new Promise((resolve) => {
      const expiresAt = Date.now() + timeoutMs;

      const timer = setTimeout(() => {
        this.activeOffers.delete(trip.requestId);
        resolve("timed_out");
      }, timeoutMs);

      this.activeOffers.set(trip.requestId, {
        driverId: candidate.id,
        requestId: trip.requestId,
        expiresAt,
        timer,
        resolve,
      });

      // Emit event for WebSocket gateway to push match_request to driver
      this.events.onOfferDispatched?.({
        driverId: candidate.id,
        requestId: trip.requestId,
        tripId: trip.id,
        pickup: trip.pickup,
        dropoff: trip.dropoff,
        expiresAt,
        distanceMeters: Math.round(candidate.distance),
      });
    });
  }

  public getActiveOffer(requestId: string): PendingOffer | undefined {
    return this.activeOffers.get(requestId);
  }
}
