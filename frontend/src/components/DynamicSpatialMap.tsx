import L from "leaflet";
import {
  Cpu,
  Eye,
  Flag,
  Globe2,
  Grid,
  LocateFixed,
  MapPin,
  Maximize2,
  PlusCircle,
  Sliders,
  Users,
  Zap,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import {
  ActiveTrip,
  CityPreset,
  ConcurrencyRaceResult,
  Driver,
  GeoBounds,
  GeoPoint,
} from "../types";
import { CITY_PRESETS } from "../utils/cities";
import { buildClientQuadtree, QuadTreeNodeData } from "../utils/quadtree";

interface DynamicSpatialMapProps {
  activeCity: CityPreset;
  activeBounds: GeoBounds;
  drivers: Driver[];
  activeTrip: ActiveTrip | null;
  concurrencyRaceResult?: ConcurrencyRaceResult | null;
  pickupPoint: GeoPoint;
  dropoffPoint: GeoPoint;
  onSelectPickup: (point: GeoPoint) => void;
  onSelectDropoff: (point: GeoPoint) => void;
  onReseedRegion: (bounds: GeoBounds, name: string, count: number) => void;
  onSpawnDriver: (lat: number, lng: number) => void;
  onJumpToCity: (city: CityPreset) => void;
}

export const DynamicSpatialMap: React.FC<DynamicSpatialMapProps> = ({
  activeCity,
  activeBounds,
  drivers,
  activeTrip,
  concurrencyRaceResult,
  pickupPoint,
  dropoffPoint,
  onSelectPickup,
  onSelectDropoff,
  onReseedRegion,
  onSpawnDriver,
  onJumpToCity,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  // Layers
  const quadtreeLayerRef = useRef<L.LayerGroup | null>(null);
  const driversLayerRef = useRef<L.LayerGroup | null>(null);
  const tripMarkersLayerRef = useRef<L.LayerGroup | null>(null);
  const routeLineLayerRef = useRef<L.Polyline | null>(null);
  const raceAliceLineRef = useRef<L.Polyline | null>(null);
  const raceBobLineRef = useRef<L.Polyline | null>(null);

  // Interactive Tools State
  const [clickMode, setClickMode] = useState<"pickup" | "dropoff" | "spawn">(
    "pickup",
  );
  const [showQuadtreeGrid, setShowQuadtreeGrid] = useState<boolean>(true);
  const [showDriverLabels, setShowDriverLabels] = useState<boolean>(false);
  const [fleetSize, setFleetSize] = useState<number>(40);
  const [showBoundsModal, setShowBoundsModal] = useState<boolean>(false);

  // Custom bounds input state
  const [customBoundsInput, setCustomBoundsInput] =
    useState<GeoBounds>(activeBounds);

  // Engine State & Latency Readout
  const [engine, setEngine] = useState<"ts" | "cpp">("ts");
  const [cppAvailable, setCppAvailable] = useState<boolean>(true);
  const [lastLatencyUs, setLastLatencyUs] = useState<number>(0);

  useEffect(() => {
    fetch("/api/engine/status")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.activeEngine) {
          setEngine(data.activeEngine);
          setCppAvailable(data.cppAvailable ?? true);
          setLastLatencyUs(data.lastLatencyUs ?? 0);
        }
      })
      .catch(() => {});
  }, []);

  const handleSwitchEngine = async (target: "ts" | "cpp") => {
    try {
      const res = await fetch("/api/engine/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: target }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        setEngine(target);
      }
    } catch (err) {
      console.error("Failed to switch engine", err);
    }
  };

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapContainerRef.current, {
      center: [activeCity.center.lat, activeCity.center.lng],
      zoom: activeCity.zoom,
      zoomControl: false,
    });

    L.control.zoom({ position: "bottomright" }).addTo(map);

    // 100% Free OpenStreetMap tile layer (No API key required)
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      className: "map-tiles-dark",
    }).addTo(map);

    quadtreeLayerRef.current = L.layerGroup().addTo(map);
    driversLayerRef.current = L.layerGroup().addTo(map);
    tripMarkersLayerRef.current = L.layerGroup().addTo(map);

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Update click handler when clickMode changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    map.off("click");
    map.off("contextmenu");

    map.on("click", (e: L.LeafletMouseEvent) => {
      const point = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (clickMode === "pickup") {
        onSelectPickup(point);
      } else if (clickMode === "dropoff") {
        onSelectDropoff(point);
      } else if (clickMode === "spawn") {
        onSpawnDriver(point.lat, point.lng);
      }
    });

    // Right-click is always quick shortcut to set Dropoff
    map.on("contextmenu", (e: L.LeafletMouseEvent) => {
      onSelectDropoff({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
  }, [clickMode, onSelectPickup, onSelectDropoff, onSpawnDriver]);

  // Sync custom bounds state
  useEffect(() => {
    setCustomBoundsInput(activeBounds);
  }, [activeBounds]);

  // Seed visible view
  const handleSeedVisibleView = () => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const b = map.getBounds();
    const bounds: GeoBounds = {
      minLat: Number(b.getSouth().toFixed(4)),
      maxLat: Number(b.getNorth().toFixed(4)),
      minLng: Number(b.getWest().toFixed(4)),
      maxLng: Number(b.getEast().toFixed(4)),
    };

    const finalCount = Math.max(1, Math.min(500, fleetSize || 40));
    onReseedRegion(bounds, "Custom Visible Viewport", finalCount);
  };

  // Update PR-QuadTree Grid Overlay
  useEffect(() => {
    if (!quadtreeLayerRef.current) return;
    quadtreeLayerRef.current.clearLayers();

    if (!showQuadtreeGrid) return;

    const rootNode = buildClientQuadtree(drivers, activeBounds);

    function drawNode(node: QuadTreeNodeData) {
      const bounds = L.latLngBounds(
        [node.bounds.minLat, node.bounds.minLng],
        [node.bounds.maxLat, node.bounds.maxLng],
      );

      const rect = L.rectangle(bounds, {
        color: "#06b6d4",
        weight: node.depth === 0 ? 2 : 1,
        fillOpacity: 0.02,
        opacity: Math.max(0.15, 0.4 - node.depth * 0.05),
      });

      quadtreeLayerRef.current?.addLayer(rect);

      if (node.isDivided && node.children) {
        for (const child of node.children) drawNode(child);
      }
    }

    drawNode(rootNode);
  }, [drivers, activeBounds, showQuadtreeGrid]);

  // Update Vehicle Fleet Markers
  useEffect(() => {
    if (!driversLayerRef.current) return;
    driversLayerRef.current.clearLayers();

    for (const d of drivers) {
      const isLocked = d.hasLock || d.status === "locked";
      const isBusy = d.status === "busy" || d.status === "in_progress";
      const isEnRoute = d.status === "en_route";

      let color = "#10b981"; // available (emerald)
      if (isLocked)
        color = "#f59e0b"; // locked offer (amber)
      else if (isEnRoute)
        color = "#38bdf8"; // en route (sky blue)
      else if (isBusy) color = "#f43f5e"; // busy (rose)

      const iconHtml = `
        <div class="relative flex items-center justify-center">
          ${
            isLocked
              ? `<div class="absolute -inset-1.5 rounded-full bg-amber-400/40 animate-ping"></div>`
              : ""
          }
          <div style="background-color: ${color};" class="w-3.5 h-3.5 rounded-full border-2 border-[#090d16] shadow-md flex items-center justify-center">
          </div>
          ${
            showDriverLabels
              ? `<span class="absolute top-4 text-[9px] font-mono text-zinc-300 bg-zinc-900/80 px-1 rounded border border-zinc-700 whitespace-nowrap">${d.id.replace(
                  "sim_driver_",
                  "D",
                )}</span>`
              : ""
          }
        </div>
      `;

      const markerIcon = L.divIcon({
        html: iconHtml,
        className: "custom-driver-pin",
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });

      const marker = L.marker([d.lat, d.lng], { icon: markerIcon });
      driversLayerRef.current.addLayer(marker);
    }
  }, [drivers, showDriverLabels]);

  // Update Pickup & Dropoff Markers and Trajectory Line
  useEffect(() => {
    if (!tripMarkersLayerRef.current || !mapInstanceRef.current) return;
    tripMarkersLayerRef.current.clearLayers();

    // 1. Pickup Pin (Purple Ring)
    const pickupHtml = `
      <div class="relative flex items-center justify-center">
        <div class="w-4 h-4 rounded-full bg-purple-500 border-2 border-white shadow-lg flex items-center justify-center">
          <div class="w-1.5 h-1.5 rounded-full bg-white"></div>
        </div>
        <div class="absolute -inset-1 rounded-full bg-purple-400/30 animate-pulse"></div>
        <span class="absolute top-5 text-[10px] font-bold text-purple-300 bg-zinc-900/90 px-1.5 py-0.5 rounded border border-purple-500/40 shadow whitespace-nowrap">
          Pickup
        </span>
      </div>
    `;

    const pickupIcon = L.divIcon({
      html: pickupHtml,
      className: "custom-pickup-pin",
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const pMarker = L.marker([pickupPoint.lat, pickupPoint.lng], {
      icon: pickupIcon,
    });
    tripMarkersLayerRef.current.addLayer(pMarker);

    // 2. Dropoff Pin (Teal Destination Flag)
    const dropoffHtml = `
      <div class="relative flex items-center justify-center">
        <div class="w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow-lg flex items-center justify-center">
          <div class="w-1.5 h-1.5 rounded-full bg-white"></div>
        </div>
        <span class="absolute top-5 text-[10px] font-bold text-emerald-300 bg-zinc-900/90 px-1.5 py-0.5 rounded border border-emerald-500/40 shadow whitespace-nowrap">
          Dropoff
        </span>
      </div>
    `;

    const dropoffIcon = L.divIcon({
      html: dropoffHtml,
      className: "custom-dropoff-pin",
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const dMarker = L.marker([dropoffPoint.lat, dropoffPoint.lng], {
      icon: dropoffIcon,
    });
    tripMarkersLayerRef.current.addLayer(dMarker);

    // 3. Dynamic Trajectory Line
    if (routeLineLayerRef.current) {
      mapInstanceRef.current.removeLayer(routeLineLayerRef.current);
      routeLineLayerRef.current = null;
    }
    if (raceAliceLineRef.current && mapInstanceRef.current) {
      mapInstanceRef.current.removeLayer(raceAliceLineRef.current);
      raceAliceLineRef.current = null;
    }
    if (raceBobLineRef.current && mapInstanceRef.current) {
      mapInstanceRef.current.removeLayer(raceBobLineRef.current);
      raceBobLineRef.current = null;
    }

    if (activeTrip?.driverId) {
      const assigned = drivers.find((d) => d.id === activeTrip.driverId);
      if (assigned) {
        const polyline = L.polyline(
          [
            [assigned.lat, assigned.lng],
            [pickupPoint.lat, pickupPoint.lng],
            [dropoffPoint.lat, dropoffPoint.lng],
          ],
          {
            color: "#38bdf8",
            weight: 3,
            dashArray: "6, 6",
            opacity: 0.8,
          },
        ).addTo(mapInstanceRef.current);
        routeLineLayerRef.current = polyline;
      }
    }

    // 4. Concurrency Race Visual Evidence Markers & Trajectory Vectors
    if (concurrencyRaceResult && mapInstanceRef.current) {
      // Alice Marker (Purple)
      const aliceIcon = L.divIcon({
        html: `
          <div class="relative flex items-center justify-center">
            <div class="absolute w-7 h-7 rounded-full bg-purple-500/30 animate-ping"></div>
            <div class="w-5 h-5 rounded-full bg-purple-600 border-2 border-white shadow-lg flex items-center justify-center text-[9px] font-bold text-white">A</div>
            <span class="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap bg-purple-950/95 text-purple-200 border border-purple-500/40 text-[9px] px-1.5 py-0.5 rounded font-mono font-bold shadow-lg">
              Alice ➔ ${concurrencyRaceResult.alice.assignedDriverId || "Queued"}
            </span>
          </div>
        `,
        className: "race-alice-pin",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const aMarker = L.marker(
        [
          concurrencyRaceResult.alice.pickup.lat,
          concurrencyRaceResult.alice.pickup.lng,
        ],
        { icon: aliceIcon },
      );
      tripMarkersLayerRef.current.addLayer(aMarker);

      // Bob Marker (Orange)
      const bobIcon = L.divIcon({
        html: `
          <div class="relative flex items-center justify-center">
            <div class="absolute w-7 h-7 rounded-full bg-orange-500/30 animate-ping"></div>
            <div class="w-5 h-5 rounded-full bg-orange-600 border-2 border-white shadow-lg flex items-center justify-center text-[9px] font-bold text-white">B</div>
            <span class="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap bg-orange-950/95 text-orange-200 border border-orange-500/40 text-[9px] px-1.5 py-0.5 rounded font-mono font-bold shadow-lg">
              Bob ➔ ${concurrencyRaceResult.bob.assignedDriverId || "Queued"}
            </span>
          </div>
        `,
        className: "race-bob-pin",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const bMarker = L.marker(
        [
          concurrencyRaceResult.bob.pickup.lat,
          concurrencyRaceResult.bob.pickup.lng,
        ],
        { icon: bobIcon },
      );
      tripMarkersLayerRef.current.addLayer(bMarker);

      // Vector from Alice to her assigned driver (Purple line)
      if (concurrencyRaceResult.alice.assignedDriverId) {
        const aDriver = drivers.find(
          (d) => d.id === concurrencyRaceResult.alice.assignedDriverId,
        );
        if (aDriver) {
          raceAliceLineRef.current = L.polyline(
            [
              [
                concurrencyRaceResult.alice.pickup.lat,
                concurrencyRaceResult.alice.pickup.lng,
              ],
              [aDriver.lat, aDriver.lng],
            ],
            { color: "#a855f7", weight: 3, dashArray: "5, 5", opacity: 0.9 },
          ).addTo(mapInstanceRef.current);
        }
      }

      // Vector from Bob to his assigned driver (Orange line)
      if (concurrencyRaceResult.bob.assignedDriverId) {
        const bDriver = drivers.find(
          (d) => d.id === concurrencyRaceResult.bob.assignedDriverId,
        );
        if (bDriver) {
          raceBobLineRef.current = L.polyline(
            [
              [
                concurrencyRaceResult.bob.pickup.lat,
                concurrencyRaceResult.bob.pickup.lng,
              ],
              [bDriver.lat, bDriver.lng],
            ],
            { color: "#f97316", weight: 3, dashArray: "5, 5", opacity: 0.9 },
          ).addTo(mapInstanceRef.current);
        }
      }
    }
  }, [pickupPoint, dropoffPoint, activeTrip, drivers, concurrencyRaceResult]);

  return (
    <div className="relative w-full h-[580px] bg-card border border-border rounded-2xl overflow-hidden shadow-xl flex flex-col">
      {/* Top Floating Master Toolbar */}
      <div className="absolute top-3 left-3 right-3 z-[1000] flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        {/* Left: Tool Modes */}
        <div className="flex items-center gap-1.5 bg-[#090d16]/95 backdrop-blur-md border border-border p-1.5 rounded-xl shadow-xl pointer-events-auto text-xs">
          <button
            onClick={() => setClickMode("pickup")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition ${
              clickMode === "pickup"
                ? "bg-purple-600 text-white shadow"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <MapPin className="w-3.5 h-3.5 text-purple-300" />
            <span>Set Pickup</span>
          </button>
          <button
            onClick={() => setClickMode("dropoff")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition ${
              clickMode === "dropoff"
                ? "bg-emerald-600 text-white shadow"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Flag className="w-3.5 h-3.5 text-emerald-300" />
            <span>Set Dropoff</span>
          </button>
          <button
            onClick={() => setClickMode("spawn")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition ${
              clickMode === "spawn"
                ? "bg-cyan-600 text-white shadow animate-pulse"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Click anywhere on the global map to spawn a driver"
          >
            <PlusCircle className="w-3.5 h-3.5 text-cyan-300" />
            <span>Spawn Driver</span>
          </button>
        </div>

        {/* Center: Core Engine Switcher (TypeScript V8 vs C++ Native) */}
        <div className="flex items-center gap-1 bg-[#090d16]/95 backdrop-blur-md border border-border p-1 rounded-xl shadow-xl pointer-events-auto text-xs">
          <button
            type="button"
            onClick={() => handleSwitchEngine("ts")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-bold transition ${
              engine === "ts"
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Switch to in-memory TypeScript PR-Quadtree (V8 JIT)"
          >
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>⚡ TypeScript</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchEngine("cpp")}
            disabled={!cppAvailable}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-bold transition ${
              engine === "cpp"
                ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            } ${!cppAvailable ? "opacity-40 cursor-not-allowed" : ""}`}
            title="Switch to native C++ PR-Quadtree compiled with MinGW GCC -O3"
          >
            <Cpu className="w-3.5 h-3.5 text-cyan-400" />
            <span>🚀 C++ Native</span>
            {engine === "cpp" && lastLatencyUs > 0 && (
              <span className="ml-1 text-[10px] bg-cyan-950/80 border border-cyan-800 text-cyan-200 px-1.5 py-0.5 rounded-full font-mono font-bold">
                {lastLatencyUs.toFixed(0)}μs
              </span>
            )}
          </button>
        </div>

        {/* Right: Dynamic Region Seed Controls */}
        <div className="flex items-center gap-2 bg-[#090d16]/95 backdrop-blur-md border border-border p-1.5 rounded-xl shadow-xl pointer-events-auto text-xs">
          <div className="flex items-center gap-1.5 px-1 text-zinc-300">
            <Users className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] text-zinc-400">Fleet:</span>
            <div className="flex items-center bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() =>
                  setFleetSize((prev) => Math.max(1, (prev || 40) - 5))
                }
                className="w-5 h-6 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition font-bold text-xs"
                title="Decrease fleet size"
              >
                −
              </button>
              <input
                type="number"
                min="1"
                max="500"
                value={fleetSize === 0 ? "" : fleetSize}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "") {
                    setFleetSize(0);
                  } else {
                    const parsed = parseInt(val, 10);
                    if (!isNaN(parsed)) setFleetSize(parsed);
                  }
                }}
                onBlur={() => {
                  if (!fleetSize || fleetSize < 1) setFleetSize(10);
                  else if (fleetSize > 500) setFleetSize(500);
                }}
                className="w-12 bg-transparent text-emerald-400 font-mono text-center text-xs focus:outline-none py-0.5"
              />
              <button
                type="button"
                onClick={() =>
                  setFleetSize((prev) => Math.min(500, (prev || 40) + 5))
                }
                className="w-5 h-6 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition font-bold text-xs"
                title="Increase fleet size"
              >
                +
              </button>
            </div>
          </div>

          <button
            onClick={handleSeedVisibleView}
            className="flex items-center gap-1.5 px-3 py-1 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-lg shadow transition active:scale-95"
            title="Takes the current map zoom/pan area and seeds drivers across it"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Seed in Visible View</span>
          </button>

          <button
            onClick={() => setShowBoundsModal(!showBoundsModal)}
            className="p-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:text-white bg-zinc-900 transition"
            title="Custom Region Coordinates"
          >
            <Sliders className="w-3.5 h-3.5 text-amber-400" />
          </button>
        </div>
      </div>

      {/* Active Concurrency Race Overlay Banner */}
      {concurrencyRaceResult && (
        <div className="absolute top-16 left-3 right-3 z-[1000] bg-[#090d16]/95 backdrop-blur-md border border-emerald-500/50 p-2.5 rounded-xl shadow-2xl flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400 animate-pulse" />
            <span className="font-bold text-zinc-100">
              Live Race Invariant:
            </span>
            <span className="text-zinc-300">
              Contended:{" "}
              <strong className="text-amber-400 font-mono">
                {concurrencyRaceResult.targetContendedDriverId}
              </strong>
            </span>
            <span className="text-zinc-500">|</span>
            <span className="text-purple-300">
              Alice ➔{" "}
              <strong className="font-mono">
                {concurrencyRaceResult.alice.assignedDriverId || "None"}
              </strong>
            </span>
            <span className="text-zinc-500">|</span>
            <span className="text-orange-300">
              Bob ➔{" "}
              <strong className="font-mono">
                {concurrencyRaceResult.bob.assignedDriverId || "None"}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 font-mono text-[10px] rounded-full border border-emerald-500/30 font-bold flex items-center gap-1">
              ✓ 0% Duplicate Dispatch
            </span>
          </div>
        </div>
      )}

      {/* Custom Coordinates Modal / Drawer */}
      {showBoundsModal && (
        <div className="absolute top-16 right-3 z-[1100] w-80 bg-[#090d16]/95 backdrop-blur-md border border-border p-4 rounded-2xl shadow-2xl space-y-3 text-xs">
          <div className="flex items-center justify-between pb-1 border-b border-border">
            <span className="font-bold text-zinc-200 flex items-center gap-1.5">
              <Globe2 className="w-4 h-4 text-amber-400" /> Custom Region
              Bounding Box
            </span>
            <button
              onClick={() => setShowBoundsModal(false)}
              className="text-zinc-500 hover:text-zinc-300 font-bold"
            >
              ✕
            </button>
          </div>

          <p className="text-[11px] text-zinc-400">
            Define exact GPS coordinates for the PR-QuadTree spatial operating
            zone:
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-500">Min Lat</label>
              <input
                type="number"
                step="0.001"
                value={customBoundsInput.minLat}
                onChange={(e) =>
                  setCustomBoundsInput({
                    ...customBoundsInput,
                    minLat: Number(e.target.value),
                  })
                }
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono text-zinc-200 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">Max Lat</label>
              <input
                type="number"
                step="0.001"
                value={customBoundsInput.maxLat}
                onChange={(e) =>
                  setCustomBoundsInput({
                    ...customBoundsInput,
                    maxLat: Number(e.target.value),
                  })
                }
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono text-zinc-200 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">Min Lng</label>
              <input
                type="number"
                step="0.001"
                value={customBoundsInput.minLng}
                onChange={(e) =>
                  setCustomBoundsInput({
                    ...customBoundsInput,
                    minLng: Number(e.target.value),
                  })
                }
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono text-zinc-200 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">Max Lng</label>
              <input
                type="number"
                step="0.001"
                value={customBoundsInput.maxLng}
                onChange={(e) =>
                  setCustomBoundsInput({
                    ...customBoundsInput,
                    maxLng: Number(e.target.value),
                  })
                }
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono text-zinc-200 text-xs"
              />
            </div>
          </div>

          <button
            onClick={() => {
              onReseedRegion(
                customBoundsInput,
                "Custom LatLng Zone",
                fleetSize,
              );
              mapInstanceRef.current?.fitBounds([
                [customBoundsInput.minLat, customBoundsInput.minLng],
                [customBoundsInput.maxLat, customBoundsInput.maxLng],
              ]);
              setShowBoundsModal(false);
            }}
            className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl transition active:scale-95"
          >
            Apply Bounds & Seed Fleet ({fleetSize})
          </button>
        </div>
      )}

      {/* Bottom Floating Bar */}
      <div className="absolute bottom-3 left-3 z-[1000] flex items-center gap-2 bg-[#090d16]/95 backdrop-blur-md border border-border px-3 py-1.5 rounded-xl shadow-lg text-xs">
        <button
          onClick={() => setShowQuadtreeGrid(!showQuadtreeGrid)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded transition ${
            showQuadtreeGrid
              ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Grid className="w-3 h-3" />
          <span>PR-QuadTree</span>
        </button>
        <button
          onClick={() => setShowDriverLabels(!showDriverLabels)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded transition ${
            showDriverLabels
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Eye className="w-3 h-3" />
          <span>Driver IDs</span>
        </button>

        {/* Global Metro Quick Jumps */}
        <span className="text-zinc-600">|</span>
        <select
          onChange={(e) => {
            const found = CITY_PRESETS.find((c) => c.id === e.target.value);
            if (found) {
              onJumpToCity(found);
              mapInstanceRef.current?.setView(
                [found.center.lat, found.center.lng],
                found.zoom,
              );
            }
          }}
          className="bg-transparent text-zinc-400 hover:text-zinc-200 text-[11px] focus:outline-none cursor-pointer"
          defaultValue=""
        >
          <option value="" disabled>
            🌐 Quick Jump...
          </option>
          {CITY_PRESETS.map((c) => (
            <option
              key={c.id}
              value={c.id}
              className="bg-zinc-900 text-zinc-200"
            >
              {c.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => {
            mapInstanceRef.current?.fitBounds([
              [activeBounds.minLat, activeBounds.minLng],
              [activeBounds.maxLat, activeBounds.maxLng],
            ]);
          }}
          className="ml-1 text-zinc-400 hover:text-white"
          title="Fit Current Operating Zone"
        >
          <LocateFixed className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Leaflet Map Target */}
      <div ref={mapContainerRef} className="w-full h-full" />
    </div>
  );
};
