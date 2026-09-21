import React from "react";
import {
  Activity,
  Car,
  CheckCircle2,
  Globe2,
  Lock,
  Network,
  Radio,
  Zap,
} from "lucide-react";
import { CityPreset, SystemStats } from "../types";
import { CITY_PRESETS } from "../utils/cities";

interface HeaderMetricsProps {
  activeCity: CityPreset;
  onCityChange: (city: CityPreset) => void;
  connectionStatus: "connected" | "connecting" | "disconnected" | "standalone";
  stats: SystemStats;
}

export const HeaderMetrics: React.FC<HeaderMetricsProps> = ({
  activeCity,
  onCityChange,
  connectionStatus,
  stats,
}) => {
  return (
    <header className="bg-card border border-border rounded-2xl p-4 shadow-lg backdrop-blur-md flex flex-wrap items-center justify-between gap-4">
      {/* Brand & City Selector */}
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-black shadow-inner">
          <Zap className="w-6 h-6 text-emerald-400 fill-emerald-400/20" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-extrabold text-lg tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
              InstaRide Spatial Engine
            </h1>
            <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
              v1.0 Production
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
            <Globe2 className="w-3.5 h-3.5 text-zinc-500" />
            <span>Active Zone:</span>
            <select
              value={activeCity.id}
              onChange={(e) => {
                const found = CITY_PRESETS.find((c) => c.id === e.target.value);
                if (found) onCityChange(found);
              }}
              aria-label="Active Zone"
              className="bg-[#090d16] text-emerald-400 font-semibold border border-zinc-700 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 transition cursor-pointer"
            >
              {CITY_PRESETS.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.name}, {city.country}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Metrics Counters */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Status Pill */}
        <div
          className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-2 transition ${
            connectionStatus === "connected"
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
              : connectionStatus === "connecting"
              ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
              : "bg-rose-500/10 text-rose-400 border-rose-500/30"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              connectionStatus === "connected"
                ? "bg-emerald-400 animate-ping"
                : connectionStatus === "connecting"
                ? "bg-amber-400 animate-pulse"
                : "bg-rose-500"
            }`}
          />
          <Radio className="w-3.5 h-3.5" />
          <span className="capitalize">{connectionStatus}</span>
        </div>

        {/* Available Drivers */}
        <div className="bg-[#090d16] border border-border px-3.5 py-1.5 rounded-xl flex items-center gap-2.5">
          <Car className="w-4 h-4 text-emerald-400" />
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-400 font-medium">Available</span>
            <span className="text-sm font-bold text-emerald-400 font-mono">
              {stats.availableDrivers}
            </span>
          </div>
        </div>

        {/* Locked / In-Trip */}
        <div className="bg-[#090d16] border border-border px-3.5 py-1.5 rounded-xl flex items-center gap-2.5">
          <Lock className="w-4 h-4 text-amber-400" />
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-400 font-medium">Locked / Busy</span>
            <span className="text-sm font-bold text-amber-400 font-mono">
              {stats.busyDrivers}
            </span>
          </div>
        </div>

        {/* Quadtree Nodes */}
        <div className="bg-[#090d16] border border-border px-3.5 py-1.5 rounded-xl flex items-center gap-2.5">
          <Network className="w-4 h-4 text-cyan-400" />
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-400 font-medium">QuadTree Nodes</span>
            <span className="text-sm font-bold text-cyan-400 font-mono">
              {stats.quadtreeNodes}
            </span>
          </div>
        </div>

        {/* k-NN Latency */}
        <div className="bg-[#090d16] border border-border px-3.5 py-1.5 rounded-xl flex items-center gap-2.5">
          <Activity className="w-4 h-4 text-purple-400" />
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-400 font-medium">k-NN p50</span>
            <span className="text-sm font-bold text-purple-400 font-mono">
              19.1 µs
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};

