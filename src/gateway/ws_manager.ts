import { WebSocket } from "ws";
import { DriverRegistry } from "../core/driver_registry.js";
import { MatchingService } from "../core/matching_service.js";
import { TripStateMachine } from "../core/trip_state_machine.js";

export type ClientRole = "rider" | "driver" | "observer";

export interface ClientConnection {
  socket: WebSocket;
  role: ClientRole;
  id: string;
  isAlive: boolean;
}

export class WsManager {
  private readonly driverRegistry: DriverRegistry;
  private readonly stateMachine: TripStateMachine;
  private matchingService!: MatchingService;

  // Connected client sockets by role and ID
  private readonly riderSockets = new Map<string, WebSocket>();
  private readonly driverSockets = new Map<string, WebSocket>();
  private readonly observerSockets = new Set<WebSocket>();

  constructor(driverRegistry: DriverRegistry, stateMachine: TripStateMachine) {
    this.driverRegistry = driverRegistry;
    this.stateMachine = stateMachine;
  }

  public setMatchingService(matchingService: MatchingService): void {
    this.matchingService = matchingService;
  }

  /**
   * Registers an incoming WebSocket connection and sets up message handlers.
   */
  public handleConnection(
    socket: WebSocket,
    role: ClientRole,
    id?: string,
  ): void {
    const clientId =
      id || `client_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    if (role === "rider") {
      this.riderSockets.set(clientId, socket);
    } else if (role === "driver") {
      this.driverSockets.set(clientId, socket);
    } else {
      this.observerSockets.add(socket);
    }

    // Push initial state sync to client
    this.send(socket, {
      type: "connected",
      role,
      id: clientId,
      timestamp: Date.now(),
    });

    socket.on("message", (raw: Buffer | string) => {
      try {
        const message = JSON.parse(raw.toString());
        this.handleMessage(socket, role, clientId, message);
      } catch (err) {
        this.send(socket, { type: "error", message: "Malformed JSON message" });
      }
    });

    socket.on("close", () => {
      if (role === "rider") {
        this.riderSockets.delete(clientId);
      } else if (role === "driver") {
        this.driverSockets.delete(clientId);
      } else {
        this.observerSockets.delete(socket);
      }
    });
  }

  private handleMessage(
    socket: WebSocket,
    role: ClientRole,
    clientId: string,
    msg: any,
  ): void {
    switch (msg.type) {
      case "ping":
        this.send(socket, { type: "pong", timestamp: Date.now() });
        break;

      // --- RIDER MESSAGES ---
      case "ride_request": {
        const { requestId, pickup, dropoff } = msg;
        if (!pickup || !dropoff) {
          this.send(socket, {
            type: "error",
            message: "Missing pickup or dropoff coordinates",
          });
          return;
        }

        this.matchingService
          .requestRide({
            requestId: requestId || `req_${Date.now()}`,
            riderId: clientId,
            pickup,
            dropoff,
            offerTimeoutMs: msg.offerTimeoutMs ?? 15_000,
          })
          .then((res) => {
            if (res.success && res.trip) {
              this.send(socket, {
                type: "ride_status",
                requestId: res.trip.requestId,
                tripId: res.trip.id,
                status: res.trip.status,
              });
              this.broadcastToObservers({
                type: "trip_event",
                tripId: res.trip.id,
                status: res.trip.status,
                riderId: clientId,
                pickup,
                dropoff,
              });
            } else {
              this.send(socket, { type: "error", message: res.error });
            }
          });
        break;
      }

      case "cancel_ride": {
        const { requestId, reason } = msg;
        const res = this.matchingService.cancelRide(requestId, "rider", reason);
        this.send(socket, {
          type: "ride_cancelled",
          success: res.success,
          error: res.error,
        });
        this.broadcastToObservers({
          type: "trip_cancelled",
          requestId,
          cancelledBy: "rider",
          reason,
        });
        break;
      }

      // --- DRIVER MESSAGES ---
      case "driver_telemetry": {
        const { lat, lng } = msg;
        if (typeof lat === "number" && typeof lng === "number") {
          this.driverRegistry.updateLocation(clientId, lat, lng);

          // If driver is currently on an active trip, stream GPS to matched rider
          const activeTrip = this.stateMachine.getActiveTripForDriver(clientId);
          if (
            activeTrip &&
            (activeTrip.status === "en_route" ||
              activeTrip.status === "in_progress")
          ) {
            const riderSocket = this.riderSockets.get(activeTrip.riderId);
            if (riderSocket) {
              this.send(riderSocket, {
                type: "driver_location",
                tripId: activeTrip.id,
                driverId: clientId,
                lat,
                lng,
              });
            }
          }

          // Broadcast to map observers
          this.broadcastToObservers({
            type: "telemetry_update",
            driverId: clientId,
            lat,
            lng,
            status:
              this.driverRegistry.getDriver(clientId)?.status ?? "available",
          });
        }
        break;
      }

      case "ride_response": {
        const { requestId, response } = msg;
        if (response === "accepted" || response === "rejected") {
          const res = this.matchingService.handleDriverResponse(
            clientId,
            requestId,
            response,
          );
          this.send(socket, {
            type: "response_ack",
            requestId,
            response,
            success: res.success,
            error: res.error,
          });
        }
        break;
      }

      case "driver_action": {
        const { action, tripId } = msg;
        let res;
        if (action === "arrived") {
          res = this.stateMachine.driverArrived(tripId);
        } else if (action === "start_trip") {
          res = this.stateMachine.startTrip(tripId);
        } else if (action === "complete_trip") {
          res = this.stateMachine.completeTrip(tripId);
          if (res.success) {
            this.driverRegistry.completeTrip(clientId);
          }
        }

        if (res && res.success && res.trip) {
          // Notify rider
          const riderSocket = this.riderSockets.get(res.trip.riderId);
          if (riderSocket) {
            this.send(riderSocket, {
              type: "ride_status",
              tripId: res.trip.id,
              status: res.trip.status,
            });
          }
          this.broadcastToObservers({
            type: "trip_event",
            tripId: res.trip.id,
            status: res.trip.status,
            driverId: clientId,
          });
        }
        break;
      }

      // --- SESSION RECONNECTION & SYNC (PRD FR16) ---
      case "sync_state": {
        if (role === "rider") {
          const activeTrip = this.stateMachine.getActiveTripForRider(clientId);
          this.send(socket, {
            type: "sync_response",
            hasActiveTrip: !!activeTrip,
            trip: activeTrip,
          });
        } else if (role === "driver") {
          const activeTrip = this.stateMachine.getActiveTripForDriver(clientId);
          const driverRecord = this.driverRegistry.getDriver(clientId);
          this.send(socket, {
            type: "sync_response",
            hasActiveTrip: !!activeTrip,
            trip: activeTrip,
            status: driverRecord?.status,
          });
        }
        break;
      }
    }
  }

  // Send match_request to driver
  public notifyDriverOffer(driverId: string, offer: any): void {
    const socket = this.driverSockets.get(driverId);
    if (socket) {
      this.send(socket, {
        type: "match_request",
        ...offer,
      });
    }

    this.broadcastToObservers({
      type: "offer_dispatched",
      ...offer,
    });
  }

  // Send offer_revoked to driver
  public notifyOfferRevoked(
    driverId: string,
    requestId: string,
    reason: string,
  ): void {
    const socket = this.driverSockets.get(driverId);
    if (socket) {
      this.send(socket, {
        type: "offer_revoked",
        requestId,
        reason,
      });
    }

    this.broadcastToObservers({
      type: "offer_revoked",
      driverId,
      requestId,
      reason,
    });
  }

  // Send trip matched notification to rider and driver
  public notifyTripMatched(trip: any, driverId: string): void {
    const riderSocket = this.riderSockets.get(trip.riderId);
    if (riderSocket) {
      this.send(riderSocket, {
        type: "ride_status",
        tripId: trip.id,
        requestId: trip.requestId,
        status: "matched",
        driverId,
      });
    }

    const driverSocket = this.driverSockets.get(driverId);
    if (driverSocket) {
      this.send(driverSocket, {
        type: "trip_confirmed",
        tripId: trip.id,
        requestId: trip.requestId,
        riderId: trip.riderId,
        pickup: trip.pickup,
        dropoff: trip.dropoff,
      });
    }

    this.broadcastToObservers({
      type: "trip_matched",
      tripId: trip.id,
      requestId: trip.requestId,
      driverId,
      riderId: trip.riderId,
    });
  }

  public broadcastToObservers(data: any): void {
    const payload = JSON.stringify(data);
    for (const socket of this.observerSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private send(socket: WebSocket, data: any): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  public get observerCount(): number {
    return this.observerSockets.size;
  }
}
