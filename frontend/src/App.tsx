import { Car, Flame, Navigation2 } from "lucide-react";
import { useState } from "react";
import { AuditLogStream } from "./components/AuditLogStream";
import { ChaosTestingPanel } from "./components/ChaosTestingPanel";
import { DriverCockpit } from "./components/DriverCockpit";
import { DynamicSpatialMap } from "./components/DynamicSpatialMap";
import { HeaderMetrics } from "./components/HeaderMetrics";
import { RiderCockpit } from "./components/RiderCockpit";
import { useInstaRideSocket } from "./hooks/useInstaRideSocket";
import { GeoPoint } from "./types";
import { CITY_PRESETS } from "./utils/cities";

export function App() {
  const {
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
    clearRaceEvidence,
    clearAuditLogs,
  } = useInstaRideSocket(CITY_PRESETS[0]); // Default to Bengaluru

  // Local state for pins
  const [pickupPoint, setPickupPoint] = useState<GeoPoint>(
    activeCity.landmarks[0]?.point || activeCity.center,
  );
  const [dropoffPoint, setDropoffPoint] = useState<GeoPoint>(
    activeCity.landmarks[1]?.point || {
      lat: activeCity.center.lat + 0.015,
      lng: activeCity.center.lng + 0.015,
    },
  );

  // Active cockpit tab
  const [activeTab, setActiveTab] = useState<"rider" | "driver" | "chaos">(
    "rider",
  );

  // Update points when city changes
  const handleCityChange = (city: typeof activeCity) => {
    switchCity(city, 40);
    setPickupPoint(city.landmarks[0]?.point || city.center);
    setDropoffPoint(
      city.landmarks[1]?.point || {
        lat: city.center.lat + 0.015,
        lng: city.center.lng + 0.015,
      },
    );
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-zinc-100 p-4 md:p-6 space-y-4 max-w-[1600px] mx-auto select-none">
      {/* 1. Header & Live Metrics Bar */}
      <HeaderMetrics
        activeCity={activeCity}
        onCityChange={handleCityChange}
        connectionStatus={connectionStatus}
        stats={systemStats}
      />

      {/* 2. Main Spatial & Cockpit Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Spatial Map Viewport (8 Columns) */}
        <div className="lg:col-span-7 xl:col-span-8">
          <DynamicSpatialMap
            activeCity={activeCity}
            activeBounds={activeBounds}
            drivers={drivers}
            activeTrip={activeTrip}
            concurrencyRaceResult={concurrencyRaceResult}
            pickupPoint={pickupPoint}
            dropoffPoint={dropoffPoint}
            onSelectPickup={setPickupPoint}
            onSelectDropoff={setDropoffPoint}
            onReseedRegion={reseedRegion}
            onSpawnDriver={spawnDriver}
            onJumpToCity={handleCityChange}
          />
        </div>

        {/* Cockpit Controls & Role Tabs (5 Columns) */}
        <div className="lg:col-span-5 xl:col-span-4 flex flex-col space-y-3">
          {/* Tab Bar */}
          <div className="flex items-center bg-card border border-border p-1 rounded-xl gap-1">
            <button
              onClick={() => setActiveTab("rider")}
              className={`flex-1 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                activeTab === "rider"
                  ? "bg-[#090d16] text-emerald-400 shadow-sm border border-emerald-500/20"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Car className="w-3.5 h-3.5" />
              <span>Rider Booking</span>
            </button>
            <button
              onClick={() => setActiveTab("driver")}
              className={`flex-1 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                activeTab === "driver"
                  ? "bg-[#090d16] text-cyan-400 shadow-sm border border-cyan-500/20"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Navigation2 className="w-3.5 h-3.5" />
              <span>Driver View</span>
            </button>
            <button
              onClick={() => setActiveTab("chaos")}
              className={`flex-1 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                activeTab === "chaos"
                  ? "bg-[#090d16] text-amber-400 shadow-sm border border-amber-500/20"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Flame className="w-3.5 h-3.5" />
              <span>Chaos Suite</span>
            </button>
          </div>

          {/* Tab Content Panes */}
          {activeTab === "rider" && (
            <RiderCockpit
              activeCity={activeCity}
              pickup={pickupPoint}
              dropoff={dropoffPoint}
              onSetPickup={setPickupPoint}
              onSetDropoff={setDropoffPoint}
              activeTrip={activeTrip}
              onRequestRide={sendRideRequest}
              onCancelRide={cancelActiveRide}
            />
          )}

          {activeTab === "driver" && (
            <DriverCockpit
              drivers={drivers}
              activeTrip={activeTrip}
              onAcceptOffer={(driverId, reqId) =>
                sendDriverResponse(driverId, reqId, "accepted")
              }
              onRejectOffer={(driverId, reqId) =>
                sendDriverResponse(driverId, reqId, "rejected")
              }
              onDriverAction={sendDriverAction}
            />
          )}

          {activeTab === "chaos" && (
            <ChaosTestingPanel
              onTrigger2RiderRace={trigger2RiderRace}
              onResetDrivers={() => switchCity(activeCity, 40)}
              raceResult={concurrencyRaceResult}
              onClearRaceResult={clearRaceEvidence}
            />
          )}
        </div>
      </div>

      {/* 3. Real-Time Audit Log Stream */}
      <AuditLogStream logs={auditLogs} onClear={clearAuditLogs} />
    </div>
  );
}

export default App;
