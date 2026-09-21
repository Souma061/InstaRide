import {
  Car,
  Clock,
  MapPin,
  Send,
  ShieldAlert,
  Sparkles,
  XCircle,
} from "lucide-react";
import React, { useEffect, useState } from "react";
import { ActiveTrip, CityPreset, GeoPoint } from "../types";

interface RiderCockpitProps {
  activeCity: CityPreset;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  onSetPickup: (p: GeoPoint) => void;
  onSetDropoff: (p: GeoPoint) => void;
  activeTrip: ActiveTrip | null;
  onRequestRide: (
    pickup: GeoPoint,
    dropoff: GeoPoint,
    timeoutMs: number,
  ) => void;
  onCancelRide: () => void;
}

export const RiderCockpit: React.FC<RiderCockpitProps> = ({
  activeCity,
  pickup,
  dropoff,
  onSetPickup,
  onSetDropoff,
  activeTrip,
  onRequestRide,
  onCancelRide,
}) => {
  const [offerTimeoutSec, setOfferTimeoutSec] = useState<number>(15);
  const [leaseTimeRemaining, setLeaseTimeRemaining] = useState<number>(0);

  // 15-second countdown timer whenever an offer candidate is active
  useEffect(() => {
    if (!activeTrip?.activeCandidate?.expiresAt) {
      setLeaseTimeRemaining(0);
      return;
    }

    const interval = setInterval(() => {
      const diff = Math.max(
        0,
        Math.ceil((activeTrip.activeCandidate!.expiresAt - Date.now()) / 1000),
      );
      setLeaseTimeRemaining(diff);
      if (diff <= 0) clearInterval(interval);
    }, 200);

    return () => clearInterval(interval);
  }, [activeTrip?.activeCandidate]);

  const steps = [
    { key: "requested", label: "Requested" },
    { key: "matching", label: "Matching" },
    { key: "matched", label: "Matched" },
    { key: "en_route", label: "En Route" },
    { key: "in_progress", label: "In Progress" },
    { key: "completed", label: "Completed" },
  ];

  const currentStatus = activeTrip?.status || "idle";

  function getStepIndex(status: string): number {
    switch (status) {
      case "requested":
        return 0;
      case "matching":
        return 1;
      case "matched":
        return 2;
      case "en_route":
      case "arrived":
        return 3;
      case "in_progress":
        return 4;
      case "completed":
        return 5;
      default:
        return -1;
    }
  }

  const activeStepIdx = getStepIndex(currentStatus);

  return (
    <div className="bg-card border border-border rounded-2xl p-5 shadow-lg flex flex-col space-y-4">
      {/* Title */}
      <div className="flex items-center justify-between pb-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Car className="w-5 h-5 text-emerald-400" />
          <h2 className="font-bold text-base text-zinc-100">
            Rider Dispatch Portal
          </h2>
        </div>
        <span className="text-xs px-2.5 py-0.5 rounded-full font-mono font-semibold bg-[#090d16] text-zinc-400 border border-border">
          Rider: alice_sf
        </span>
      </div>

      {/* Quick Landmark Presets for Active City */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>{activeCity.name} Landmark Presets:</span>
        </label>
        <div className="flex flex-wrap gap-1.5">
          {activeCity.landmarks.slice(0, 4).map((lm, idx) => (
            <button
              key={lm.name}
              onClick={() => {
                if (idx % 2 === 0) onSetPickup(lm.point);
                else onSetDropoff(lm.point);
              }}
              className="text-[11px] px-2 py-1 rounded-lg bg-[#090d16] border border-border hover:border-emerald-500/50 hover:text-emerald-300 text-zinc-300 transition"
            >
              {lm.name.split(" ")[0]} ({idx % 2 === 0 ? "Pickup" : "Dropoff"})
            </button>
          ))}
        </div>
      </div>

      {/* Coordinates Form */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-[#090d16] border border-border rounded-xl p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-purple-400 font-semibold">
            <MapPin className="w-3.5 h-3.5" />
            <span>Pickup (Lat, Lng)</span>
          </div>
          <div className="text-xs font-mono text-zinc-200">
            {pickup.lat.toFixed(5)}, {pickup.lng.toFixed(5)}
          </div>
        </div>
        <div className="bg-[#090d16] border border-border rounded-xl p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
            <MapPin className="w-3.5 h-3.5" />
            <span>Dropoff (Lat, Lng)</span>
          </div>
          <div className="text-xs font-mono text-zinc-200">
            {dropoff.lat.toFixed(5)}, {dropoff.lng.toFixed(5)}
          </div>
        </div>
      </div>

      {/* Timeout Slider */}
      <div className="space-y-1 bg-[#090d16] border border-border rounded-xl p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-400 font-medium flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-amber-400" /> Offer Lease
            Countdown:
          </span>
          <span className="font-mono text-amber-400 font-bold">
            {offerTimeoutSec}s
          </span>
        </div>
        <input
          type="range"
          min="5"
          max="30"
          value={offerTimeoutSec}
          onChange={(e) => setOfferTimeoutSec(Number(e.target.value))}
          disabled={currentStatus === "matching" || currentStatus === "matched"}
          className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
        />
      </div>

      {/* Dispatch Action Button */}
      {currentStatus === "idle" ||
      currentStatus === "completed" ||
      currentStatus === "cancelled" ? (
        <button
          onClick={() => onRequestRide(pickup, dropoff, offerTimeoutSec * 1000)}
          className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-950/40 flex items-center justify-center gap-2 transition active:scale-[0.99]"
        >
          <Send className="w-4 h-4" />
          <span>Dispatch Ride Request (k-NN Quadtree)</span>
        </button>
      ) : (
        <button
          onClick={onCancelRide}
          className="w-full py-2.5 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-300 font-semibold rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.99]"
        >
          <XCircle className="w-4 h-4" />
          <span>Cancel Trip (Atomic Driver Rollback)</span>
        </button>
      )}

      {/* State Machine HUD */}
      <div className="bg-[#090d16] border border-border rounded-xl p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Trip Lifecycle Guard
          </span>
          <span
            className={`px-2 py-0.5 text-[11px] font-mono font-bold rounded-full border ${
              currentStatus === "matched" || currentStatus === "completed"
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                : currentStatus === "matching"
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/30 animate-pulse"
                  : currentStatus === "cancelled"
                    ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                    : "bg-zinc-800 text-zinc-400 border-zinc-700"
            }`}
          >
            {currentStatus.toUpperCase()}
          </span>
        </div>

        {/* Stepper Dots */}
        <div className="grid grid-cols-6 gap-1">
          {steps.map((s, idx) => {
            const isCompleted = activeStepIdx >= idx;
            const isCurrent = activeStepIdx === idx;
            return (
              <div key={s.key} className="flex flex-col items-center gap-1">
                <div
                  className={`h-1.5 w-full rounded-full transition-all duration-300 ${
                    isCurrent
                      ? "bg-amber-400 shadow-md shadow-amber-500/50"
                      : isCompleted
                        ? "bg-emerald-500"
                        : "bg-zinc-800"
                  }`}
                />
                <span
                  className={`text-[9px] truncate max-w-full font-medium ${
                    isCurrent
                      ? "text-amber-300 font-bold"
                      : isCompleted
                        ? "text-emerald-400"
                        : "text-zinc-600"
                  }`}
                >
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* 15s Lease Countdown Progress */}
        {leaseTimeRemaining > 0 && (
          <div className="pt-2 border-t border-border space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-amber-400 font-medium flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5" /> 15s CAS Lease Expiry:
              </span>
              <span className="font-mono font-bold text-amber-300">
                {leaseTimeRemaining}s remaining
              </span>
            </div>
            <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden">
              <div
                style={{ width: `${(leaseTimeRemaining / 15) * 100}%` }}
                className="h-full bg-gradient-to-r from-amber-500 to-rose-500 transition-all duration-200 rounded-full"
              />
            </div>
          </div>
        )}

        {/* Matched Driver Meta */}
        {activeTrip?.driverId && (
          <div className="pt-1 text-xs text-zinc-300 flex justify-between">
            <span className="text-zinc-500">Assigned Driver:</span>
            <span className="font-mono font-bold text-cyan-400">
              {activeTrip.driverId}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
