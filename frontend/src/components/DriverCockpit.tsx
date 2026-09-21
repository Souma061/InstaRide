import React, { useState } from "react";
import {
  Car,
  CheckCircle2,
  Clock,
  Flag,
  Navigation2,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import { ActiveTrip, Driver } from "../types";

interface DriverCockpitProps {
  drivers: Driver[];
  activeTrip: ActiveTrip | null;
  onAcceptOffer: (driverId: string, requestId: string) => void;
  onRejectOffer: (driverId: string, requestId: string) => void;
  onDriverAction: (
    driverId: string,
    tripId: string,
    action: "arrived" | "start_trip" | "complete_trip"
  ) => void;
}

export const DriverCockpit: React.FC<DriverCockpitProps> = ({
  drivers,
  activeTrip,
  onAcceptOffer,
  onRejectOffer,
  onDriverAction,
}) => {
  const [selectedDriverId, setSelectedDriverId] = useState<string>("sim_driver_1");

  // If there is an active candidate receiving an offer, auto-focus on that driver!
  const targetDriverId = activeTrip?.driverId || selectedDriverId;
  const currentDriver =
    drivers.find((d) => d.id === targetDriverId) || drivers[0];

  const isCurrentDriverCandidate =
    activeTrip?.activeCandidate?.id === currentDriver?.id;
  const isCurrentDriverAssigned =
    activeTrip?.driverId === currentDriver?.id &&
    activeTrip?.status !== "matching";

  return (
    <div className="bg-card border border-border rounded-2xl p-5 shadow-lg flex flex-col space-y-4">
      {/* Title & Selector */}
      <div className="flex items-center justify-between pb-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Navigation2 className="w-5 h-5 text-cyan-400" />
          <h2 className="font-bold text-base text-zinc-100">Driver Terminal Simulator</h2>
        </div>
        <select
          value={currentDriver?.id || ""}
          onChange={(e) => setSelectedDriverId(e.target.value)}
          aria-label="Select Active Driver"
          className="bg-[#090d16] text-zinc-300 font-mono text-xs border border-zinc-700 rounded-lg px-2.5 py-1 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        >
          {drivers.slice(0, 25).map((d) => (
            <option key={d.id} value={d.id}>
              {d.id} ({d.status})
            </option>
          ))}
        </select>
      </div>

      {/* Driver Telemetry Card */}
      {currentDriver && (
        <div className="bg-[#090d16] border border-border rounded-xl p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-zinc-100">
                {currentDriver.id}
              </span>
              <span
                className={`px-2 py-0.5 text-[10px] font-bold rounded-full border uppercase ${
                  currentDriver.status === "available"
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                    : currentDriver.status === "locked"
                    ? "bg-amber-500/10 text-amber-400 border-amber-500/30 animate-pulse"
                    : "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
                }`}
              >
                {currentDriver.status}
              </span>
            </div>
            <span className="font-mono text-[11px] text-zinc-500">
              GPS: {currentDriver.lat.toFixed(4)}, {currentDriver.lng.toFixed(4)}
            </span>
          </div>

          <div className="text-[11px] text-zinc-400">
            QuadTree Spatial Index:{" "}
            <span className="text-emerald-400 font-medium">
              {currentDriver.status === "available" ? "Indexed (Discoverable)" : "Locked (Unindexed)"}
            </span>
          </div>
        </div>
      )}

      {/* Incoming Offer Banner */}
      {isCurrentDriverCandidate && activeTrip && (
        <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/40 rounded-xl p-4 space-y-3 animate-pulse">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-xs">
              <Clock className="w-4 h-4 animate-spin" />
              <span>Incoming Atomic Match Offer!</span>
            </div>
            <span className="text-xs font-mono font-bold text-amber-300">
              15s Lease Active
            </span>
          </div>
          <p className="text-xs text-zinc-300">
            Rider Alice is requesting a pickup {(activeTrip.activeCandidate!.distanceMeters / 1000).toFixed(2)} km away.
          </p>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={() => onAcceptOffer(currentDriver.id, activeTrip.requestId)}
              className="py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 transition active:scale-95"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Accept Offer</span>
            </button>
            <button
              onClick={() => onRejectOffer(currentDriver.id, activeTrip.requestId)}
              className="py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold rounded-xl border border-zinc-700 flex items-center justify-center gap-1.5 transition active:scale-95"
            >
              <XCircle className="w-4 h-4" />
              <span>Reject (Trigger Fallback)</span>
            </button>
          </div>
        </div>
      )}

      {/* Active Trip Execution Milestones */}
      {isCurrentDriverAssigned && activeTrip && (
        <div className="bg-[#090d16] border border-border rounded-xl p-3.5 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-300 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              Active Trip Execution
            </span>
            <span className="font-mono text-cyan-400 font-bold">
              Trip: {activeTrip.id}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <button
              onClick={() => onDriverAction(currentDriver.id, activeTrip.id, "arrived")}
              disabled={activeTrip.status !== "en_route" && activeTrip.status !== "matched"}
              className="py-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/40 disabled:opacity-30 text-blue-300 rounded-xl font-medium transition"
            >
              Arrived
            </button>
            <button
              onClick={() => onDriverAction(currentDriver.id, activeTrip.id, "start_trip")}
              disabled={activeTrip.status !== "arrived"}
              className="py-2 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 disabled:opacity-30 text-purple-300 rounded-xl font-medium transition"
            >
              Start Trip
            </button>
            <button
              onClick={() => onDriverAction(currentDriver.id, activeTrip.id, "complete_trip")}
              disabled={activeTrip.status !== "in_progress"}
              className="py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 disabled:opacity-30 text-emerald-300 rounded-xl font-medium transition"
            >
              Complete
            </button>
          </div>
        </div>
      )}

      {!isCurrentDriverCandidate && !isCurrentDriverAssigned && (
        <div className="p-4 rounded-xl border border-dashed border-zinc-800 text-center text-xs text-zinc-500 space-y-1">
          <Car className="w-6 h-6 mx-auto text-zinc-600" />
          <p>Driver is cruising SF streets in available status.</p>
          <p className="text-[11px] text-zinc-600">
            Dispatch a ride from the Rider tab to send a match offer to the closest driver.
          </p>
        </div>
      )}
    </div>
  );
};

