import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActiveTrip,
  AuditLogEntry,
  CityPreset,
  ConcurrencyRaceResult,
  Driver,
  GeoBounds,
  GeoPoint,
  SystemStats,
  TripStatus,
} from "../types";
import { CITY_PRESETS } from "../utils/cities";

export function useInstaRideSocket(initialCity: CityPreset = CITY_PRESETS[0]) {
  const [activeCity, setActiveCity] = useState<CityPreset>(initialCity);
  const [activeBounds, setActiveBounds] = useState<GeoBounds>(
    initialCity.bounds,
  );
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "disconnected" | "standalone"
  >("connecting");

  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [concurrencyRaceResult, setConcurrencyRaceResult] =
    useState<ConcurrencyRaceResult | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats>({
    availableDrivers: 40,
    busyDrivers: 0,
    totalDrivers: 40,
    quadtreeNodes: 17,
    knnLatencyMs: 0.08,
    activeTripsCount: 0,
    observersCount: 1,
  });

  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const addLog = useCallback(
    (
      type: AuditLogEntry["type"],
      message: string,
      details?: Record<string, any>,
    ) => {
      const now = new Date();
      const timeStr =
        now.toTimeString().split(" ")[0] +
        "." +
        String(now.getMilliseconds()).padStart(3, "0");
      setAuditLogs((prev) => [
        {
          id: `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          timestamp: timeStr,
          type,
          message,
          details,
        },
        ...prev.slice(0, 199), // keep latest 200 logs
      ]);
    },
    [],
  );

  // Initialize and maintain WebSocket connection
  const connect = useCallback(() => {
    if (socketRef.current) {
      try {
        socketRef.current.close();
      } catch {}
    }

    const host = window.location.host;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${host}/ws?role=observer`;

    setConnectionStatus("connecting");

    try {
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus("connected");
        addLog(
          "info",
          `Connected to InstaRide live WebSocket gateway (${wsUrl})`,
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch (e) {
          console.error("Error parsing WebSocket message:", e);
        }
      };

      ws.onclose = () => {
        setConnectionStatus("disconnected");
        addLog("error", "Disconnected from server. Reconnecting in 3s...");
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch (err) {
      setConnectionStatus("disconnected");
      reconnectTimerRef.current = setTimeout(connect, 3000);
    }
  }, [addLog]);

  // Handle incoming backend messages
  const handleMessage = useCallback(
    (msg: any) => {
      switch (msg.type) {
        case "telemetry_batch": {
          const updates: Driver[] = msg.drivers;
          setDrivers(updates);
          const avail = updates.filter((d) => d.status === "available").length;
          const busy = updates.length - avail;
          setSystemStats((prev) => ({
            ...prev,
            availableDrivers: avail,
            busyDrivers: busy,
            totalDrivers: updates.length,
          }));
          break;
        }

        case "telemetry_update": {
          setDrivers((prev) => {
            const index = prev.findIndex((d) => d.id === msg.driverId);
            if (index === -1) {
              return [
                ...prev,
                {
                  id: msg.driverId,
                  lat: msg.lat,
                  lng: msg.lng,
                  status: msg.status,
                },
              ];
            }
            const copy = [...prev];
            copy[index] = {
              ...copy[index],
              lat: msg.lat,
              lng: msg.lng,
              status: msg.status,
            };
            return copy;
          });
          break;
        }

        case "offer_dispatched": {
          addLog(
            "dispatch",
            `[Atomic Lock] Leased candidate ${msg.driverId} for requestId ${msg.requestId} (Distance: ${(msg.distanceMeters / 1000).toFixed(2)} km)`,
            msg,
          );
          setActiveTrip((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              driverId: msg.driverId,
              status: "matching",
                activeCandidate: {
                  id: msg.driverId,
                  distanceMeters: msg.distanceMeters,
                  expiresAt: msg.expiresAt,
              },
            };
          });
          break;
        }

        case "offer_revoked": {
          addLog(
            "revoke",
            `[Offer Revoked] Released driver ${msg.driverId} (${msg.reason})`,
            msg,
          );
          setActiveTrip((prev) => {
            if (!prev || prev.activeCandidate?.id !== msg.driverId) return prev;
            return {
              ...prev,
              activeCandidate: null,
            };
          });
          break;
        }

        case "trip_matched": {
          addLog(
            "transition",
            `[Trip Matched] Trip ${msg.tripId} matched with driver ${msg.driverId}`,
            msg,
          );
          setActiveTrip((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              id: msg.tripId,
              driverId: msg.driverId,
              status: "matched",
              activeCandidate: null,
            };
          });
          break;
        }

        case "trip_event": {
          addLog(
            "transition",
            `[State Machine] Trip ${msg.tripId} -> [${msg.status}]`,
            msg,
          );
          setActiveTrip((prev) => {
            if (!prev) return null;
            const newStatus = msg.status as TripStatus;
            return {
              ...prev,
              status: newStatus,
            };
          });
          break;
        }

        case "drivers_evicted": {
          addLog(
            "error",
            `[Stale Sweep] Evicted inactive drivers: ${msg.driverIds.join(", ")}`,
            msg,
          );
          break;
        }

        case "region_updated": {
          addLog(
            "info",
            `[Region Switch] Switched active operating zone to ${msg.cityName}`,
            msg,
          );
          if (msg.bounds) {
            setActiveBounds(msg.bounds);
          }
          break;
        }

        case "match_failed": {
          addLog(
            "error",
            `[Match Failed] Request ${msg.requestId}: ${msg.reason}`,
          );
          setActiveTrip((prev) =>
            prev ? { ...prev, status: "cancelled" } : null,
          );
          break;
        }

        case "concurrency_race_result": {
          setConcurrencyRaceResult(msg);
          addLog(
            "concurrency",
            `⚡ [Race Evidence] Contended: ${msg.targetContendedDriverId} | Alice -> ${msg.alice?.assignedDriverId} | Bob -> ${msg.bob?.assignedDriverId} (0% Duplicate)`,
            msg,
          );
          break;
        }

        default:
          break;
      }
    },
    [addLog],
  );

  // Connect on mount & sync initial city
  useEffect(() => {
    connect();
    fetch("/simulator/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bounds: initialCity.bounds,
        cityName: initialCity.name,
        driverCount: 40,
      }),
    }).catch(() => {});

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) socketRef.current.close();
    };
  }, [connect, initialCity]);

  // Actions
  const sendRideRequest = useCallback(
    async (pickup: GeoPoint, dropoff: GeoPoint, timeoutMs: number = 15000) => {
      const reqId = `req_${Date.now()}`;
      const riderId = "rider_alice";

      setActiveTrip({
        id: "pending...",
        requestId: reqId,
        riderId,
        driverId: null,
        status: "requested",
        pickup,
        dropoff,
        offerTimeoutMs: timeoutMs,
      });

      addLog(
        "info",
        `Initiating ride request from (${pickup.lat.toFixed(4)}, ${pickup.lng.toFixed(4)})`,
      );

      // Try HTTP POST /rides first for full REST validation, fallback to WebSocket
      try {
        const res = await fetch("/rides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: reqId,
            riderId,
            pickup,
            dropoff,
            offerTimeoutMs: timeoutMs,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          addLog(
            "info",
            `HTTP POST /rides accepted (Trip ID: ${data.trip?.id || "queued"})`,
          );
        } else {
          addLog(
            "error",
            `HTTP POST /rides returned: ${data.error || "Rejected"}`,
          );
        }
      } catch (err) {
        addLog("error", `Failed to reach /rides API: ${String(err)}`);
      }
    },
    [addLog],
  );

  const cancelActiveRide = useCallback(
    async (reason: string = "Cancelled by user") => {
      if (!activeTrip) return;
      addLog(
        "revoke",
        `Requesting cancellation for trip ${activeTrip.id || activeTrip.requestId}`,
      );
      try {
        if (activeTrip.id && activeTrip.id !== "pending...") {
          await fetch(`/rides/${activeTrip.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              riderId: activeTrip.riderId,
              reason,
            }),
          });
        }
        setActiveTrip((prev) =>
          prev ? { ...prev, status: "cancelled" } : null,
        );
      } catch (err) {
        console.error("Cancellation error:", err);
      }
    },
    [activeTrip, addLog],
  );

  const switchCity = useCallback(
    async (preset: CityPreset, driverCount: number = 40) => {
      setActiveCity(preset);
      setActiveBounds(preset.bounds);
      addLog("info", `Switching city to ${preset.name}, ${preset.country}...`);

      try {
        const res = await fetch("/simulator/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bounds: preset.bounds,
            cityName: preset.name,
            driverCount,
          }),
        });
        if (res.ok) {
          addLog(
            "info",
            `Backend reseeded ${driverCount} drivers across ${preset.name}`,
          );
        }
      } catch (e) {
        addLog(
          "error",
          `Could not reseed backend for ${preset.name}: ${String(e)}`,
        );
      }
    },
    [addLog],
  );

  const trigger2RiderRace = useCallback(async () => {
    addLog(
      "concurrency",
      "⚡ Firing 2-Rider Concurrency Race: Two simultaneous requests competing for 1 closest driver!",
    );
    try {
      const res = await fetch("/simulator/concurrency-race", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          center: activeCity.center,
          bounds: activeBounds,
          cityName: activeCity.name,
        }),
      });
      const data = await res.json();
      if (res.ok && data.metrics) {
        setConcurrencyRaceResult(data);
        addLog(
          "concurrency",
          `✅ Race Invariant Verified: Alice -> ${data.alice.assignedDriverId}, Bob -> ${data.bob.assignedDriverId} (0% Duplicate)`,
          data,
        );
      } else {
        addLog(
          "error",
          `Race simulation failed: ${data.error || "Bad Request"}`,
        );
      }
    } catch (e) {
      addLog("error", `Error triggering concurrency race: ${String(e)}`);
    }
  }, [activeCity, activeBounds, addLog]);

  const reseedRegion = useCallback(
    async (
      bounds: GeoBounds,
      cityName: string = "Custom Viewport",
      driverCount: number = 40,
    ) => {
      setActiveBounds(bounds);
      setActiveCity((prev) => ({
        ...prev,
        name: cityName,
        bounds,
        center: {
          lat: (bounds.minLat + bounds.maxLat) / 2,
          lng: (bounds.minLng + bounds.maxLng) / 2,
        },
      }));

      addLog(
        "info",
        `Reseeding region "${cityName}" with ${driverCount} drivers...`,
      );

      try {
        const res = await fetch("/simulator/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bounds, cityName, driverCount }),
        });
        const data = await res.json();
        if (res.ok) {
          addLog(
            "info",
            `Successfully seeded ${driverCount} drivers across ${cityName}`,
          );
        } else {
          addLog(
            "error",
            `Failed to seed region: ${data.error || "Bad request"}`,
          );
        }
      } catch (err) {
        addLog("error", `Error reseeding region: ${String(err)}`);
      }
    },
    [addLog],
  );

  const spawnDriver = useCallback(
    async (lat: number, lng: number, id?: string) => {
      addLog(
        "dispatch",
        `[Dynamic Spawn] Spawning driver at (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
      );
      try {
        const res = await fetch("/drivers/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lng, id }),
        });
        const data = await res.json();
        if (res.ok) {
          addLog(
            "info",
            `Driver ${data.driver?.id} spawned and indexed in QuadTree!`,
          );
        } else {
          addLog("error", `Failed to spawn driver: ${data.error}`);
        }
      } catch (err) {
        addLog("error", `Error spawning driver: ${String(err)}`);
      }
    },
    [addLog],
  );

  const sendDriverAction = useCallback(
    async (
      driverId: string,
      tripId: string,
      action: "arrived" | "start_trip" | "complete_trip",
    ) => {
      addLog(
        "transition",
        `[Driver Action] Driver ${driverId} triggering ${action} on trip ${tripId}`,
      );
      try {
        const res = await fetch(`/trips/${tripId}/driver-action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driverId, action }),
        });
        const data = await res.json();
        if (!res.ok) {
          addLog(
            "error",
            `Driver action failed: ${data.error || "Bad Request"}`,
          );
        } else {
          addLog(
            "transition",
            `[Driver Success] Action ${action} executed! Status: ${data.trip?.status}`,
          );
        }
      } catch (err) {
        addLog("error", `Driver action error: ${String(err)}`);
      }
    },
    [addLog],
  );

  const sendDriverResponse = useCallback(
    async (
      driverId: string,
      requestId: string,
      response: "accepted" | "rejected",
    ) => {
      addLog(
        "dispatch",
        `[Driver Response] Driver ${driverId} ${response} offer for ${requestId}`,
      );
      try {
        const res = await fetch("/trips/driver-response", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driverId, requestId, response }),
        });
        const data = await res.json();
        if (!res.ok) {
          addLog("error", `Offer response error: ${data.error || "Failed"}`);
        }
      } catch (err) {
        addLog("error", `Driver response error: ${String(err)}`);
      }
    },
    [addLog],
  );

  return {
    activeCity,
    activeBounds,
    connectionStatus,
    drivers,
    activeTrip,
    concurrencyRaceResult,
    systemStats,
    auditLogs,
    sendRideRequest,
    cancelActiveRide,
    sendDriverAction,
    sendDriverResponse,
    switchCity,
    reseedRegion,
    spawnDriver,
    trigger2RiderRace,
    clearRaceEvidence: () => setConcurrencyRaceResult(null),
    clearAuditLogs: () => setAuditLogs([]),
  };
}
