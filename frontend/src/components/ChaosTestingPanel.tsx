import React from "react";
import {
  AlertTriangle,
  Flame,
  RotateCcw,
  ShieldCheck,
  Timer,
  Zap,
} from "lucide-react";

interface ChaosTestingPanelProps {
  onTrigger2RiderRace: () => void;
  onResetDrivers: () => void;
}

export const ChaosTestingPanel: React.FC<ChaosTestingPanelProps> = ({
  onTrigger2RiderRace,
  onResetDrivers,
}) => {
  return (
    <div className="bg-card border border-border rounded-2xl p-5 shadow-lg flex flex-col space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Flame className="w-5 h-5 text-amber-400" />
          <h2 className="font-bold text-base text-zinc-100">
            Concurrency & Chaos Suite
          </h2>
        </div>
        <span className="text-xs px-2.5 py-0.5 rounded-full font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold">
          High-Concurrency Verification
        </span>
      </div>

      <p className="text-xs text-zinc-400">
        Run real-time race conditions, atomic lock stress tests, and automated fallback loops directly against the backend engine:
      </p>

      {/* Scenario Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Scenario 1: 2-Rider Race */}
        <div className="bg-[#090d16] border border-border rounded-xl p-3.5 space-y-2 flex flex-col justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-400">
              <Zap className="w-4 h-4" />
              <span>2-Rider Concurrency Race</span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Simultaneously fires 2 competing ride requests targeting the exact same closest driver to prove 0% duplicate assignment.
            </p>
          </div>
          <button
            onClick={onTrigger2RiderRace}
            className="w-full mt-2 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-semibold text-xs rounded-lg transition active:scale-95 flex items-center justify-center gap-1.5"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Launch Concurrent Race</span>
          </button>
        </div>

        {/* Scenario 2: Reset Fleet */}
        <div className="bg-[#090d16] border border-border rounded-xl p-3.5 space-y-2 flex flex-col justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold text-cyan-400">
              <RotateCcw className="w-4 h-4" />
              <span>Reseed 40 Drivers Fleet</span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Restores all virtual drivers back to available state and re-indexes them across the active region's PR-Quadtree.
            </p>
          </div>
          <button
            onClick={onResetDrivers}
            className="w-full mt-2 py-2 bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/40 text-cyan-300 font-semibold text-xs rounded-lg transition active:scale-95 flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reseed Active Region</span>
          </button>
        </div>
      </div>

      {/* Safety & Invariant Guarantees Card */}
      <div className="bg-[#090d16] border border-border rounded-xl p-3.5 space-y-2 text-xs">
        <span className="font-semibold text-zinc-300 flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          Engine Invariants Verified
        </span>
        <ul className="space-y-1.5 text-[11px] text-zinc-400">
          <li className="flex items-start gap-1.5">
            <span className="text-emerald-400 font-bold">✓</span>
            <span>
              <strong className="text-zinc-200">Atomic CAS Locking:</strong> Driver is pulled from the Quadtree in O(1) upon match offer, making them invisible to competing queries.
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-emerald-400 font-bold">✓</span>
            <span>
              <strong className="text-zinc-200">Accept/Cancel Rollback:</strong> If a driver accepts right as a rider cancels, rollback returns the driver to available and re-indexes into Quadtree.
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-emerald-400 font-bold">✓</span>
            <span>
              <strong className="text-zinc-200">15s Deadman Switch:</strong> Unresponsive drivers automatically timeout, returning to available and cascading the offer to candidate #2.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
};

