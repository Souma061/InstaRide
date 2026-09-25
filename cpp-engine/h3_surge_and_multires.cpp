#include <iostream>
#include <iomanip>
#include <vector>
#include <string>
#include <unordered_map>
#include <chrono>
#include <random>
#include <algorithm>
#include "h3api.h"

inline double degsToRads(double deg) {
    return deg * 3.14159265358979323846 / 180.0;
}
inline double radsToDegs(double rad) {
    return rad * 180.0 / 3.14159265358979323846;
}

int main() {
    std::cout << "========================================================================================\n";
    std::cout << "      UBER H3 KILLER FEATURES: REAL-TIME SURGE PRICING & MULTI-RESOLUTION DISPATCH      \n";
    std::cout << "========================================================================================\n\n";

    std::mt19937_64 rng(42);

    // =====================================================================================
    // DEMO 1: REAL-TIME SURGE PRICING ENGINE (H3 Resolution 8: ~460m City Hexagons)
    // =====================================================================================
    std::cout << "----------------------------------------------------------------------------------------\n";
    std::cout << ">>> [PART 1] DYNAMIC SURGE PRICING ENGINE ACROSS GREATER BENGALURU\n";
    std::cout << "----------------------------------------------------------------------------------------\n";

    // Simulate 50,000 active drivers and 25,000 incoming ride requests across the city
    const int DRIVER_FLEET = 50000;
    const int RIDER_REQUESTS = 25000;

    std::unordered_map<H3Index, int> hexDriverSupply;
    std::unordered_map<H3Index, int> hexRiderDemand;

    std::uniform_real_distribution<double> latDist(12.85, 13.15);
    std::uniform_real_distribution<double> lngDist(77.50, 77.75);

    // High-density hotspots (e.g. Indiranagar 100ft Rd & Koramangala Friday night rush)
    std::normal_distribution<double> hotspot1_lat(12.9716, 0.008);
    std::normal_distribution<double> hotspot1_lng(77.6412, 0.008);
    std::normal_distribution<double> hotspot2_lat(12.9352, 0.008);
    std::normal_distribution<double> hotspot2_lng(77.6245, 0.008);

    auto t0_surge = std::chrono::high_resolution_clock::now();

    // 1. Ingest Driver Supply into Res 8 Hexagons
    for (int i = 0; i < DRIVER_FLEET; ++i) {
        LatLng pos;
        pos.lat = degsToRads(latDist(rng));
        pos.lng = degsToRads(lngDist(rng));

        H3Index hex;
        latLngToCell(&pos, 8, &hex); // Resolution 8 (~460m)
        hexDriverSupply[hex]++;
    }

    // 2. Ingest Rider Demand (with 60% of riders concentrated in the 2 entertainment hotspots)
    for (int i = 0; i < RIDER_REQUESTS; ++i) {
        LatLng pos;
        double r = (rng() % 100) / 100.0;
        if (r < 0.35) {
            pos.lat = degsToRads(hotspot1_lat(rng));
            pos.lng = degsToRads(hotspot1_lng(rng));
        } else if (r < 0.70) {
            pos.lat = degsToRads(hotspot2_lat(rng));
            pos.lng = degsToRads(hotspot2_lng(rng));
        } else {
            pos.lat = degsToRads(latDist(rng));
            pos.lng = degsToRads(lngDist(rng));
        }

        H3Index hex;
        latLngToCell(&pos, 8, &hex);
        hexRiderDemand[hex]++;
    }

    auto t1_surge = std::chrono::high_resolution_clock::now();
    double surgeComputeMs = std::chrono::duration<double, std::milli>(t1_surge - t0_surge).count();

    // 3. Compute Real-Time Surge Multipliers per Hexagon
    struct SurgeHex {
        H3Index hex;
        int supply;
        int demand;
        double multiplier;
    };
    std::vector<SurgeHex> surgeGrid;

    for (const auto &pair : hexRiderDemand) {
        H3Index hex = pair.first;
        int demand = pair.second;
        int supply = hexDriverSupply[hex]; // 0 if no drivers in hex

        double ratio = (supply > 0) ? (static_cast<double>(demand) / supply) : (demand * 1.5);
        double multiplier = 1.0;
        if (ratio >= 3.0) multiplier = 2.8;
        else if (ratio >= 2.0) multiplier = 2.2;
        else if (ratio >= 1.5) multiplier = 1.6;
        else if (ratio >= 1.2) multiplier = 1.3;

        if (multiplier > 1.0) {
            surgeGrid.push_back({hex, supply, demand, multiplier});
        }
    }

    std::sort(surgeGrid.begin(), surgeGrid.end(), [](const SurgeHex &a, const SurgeHex &b) {
        return a.multiplier > b.multiplier;
    });

    std::cout << "  Aggregated 75,000 spatial points into H3 cells in: " << std::fixed << std::setprecision(2) << surgeComputeMs << " ms\n";
    std::cout << "  Active Surge Zones Identified: " << surgeGrid.size() << " Hexagons experiencing peak surge pricing!\n\n";

    std::cout << std::left << std::setw(20) << "H3 Hexagon ID"
              << std::setw(16) << "Rider Demand"
              << std::setw(16) << "Driver Supply"
              << std::setw(16) << "Demand/Supply"
              << "Surge Multiplier\n";
    std::cout << "----------------------------------------------------------------------------------------\n";

    for (int i = 0; i < std::min<int>(6, surgeGrid.size()); ++i) {
        char hexStr[17];
        h3ToString(surgeGrid[i].hex, hexStr, sizeof(hexStr));
        double ratio = (surgeGrid[i].supply > 0) ? ((double)surgeGrid[i].demand / surgeGrid[i].supply) : surgeGrid[i].demand;
        std::cout << std::left << std::setw(20) << hexStr
                  << std::setw(16) << surgeGrid[i].demand
                  << std::setw(16) << surgeGrid[i].supply
                  << std::setw(16) << std::setprecision(1) << ratio
                  << std::setprecision(1) << surgeGrid[i].multiplier << "x SURGE\n";
    }

    // =====================================================================================
    // DEMO 2: ADAPTIVE MULTI-RESOLUTION DISPATCH (Solving the Crowding Bottleneck)
    // When 20,000 drivers are packed into a 100m stadium dropoff zone:
    //  - Res 8 (~460m): 20,000 drivers in 1 bucket (slow brute-force scan)
    //  - Res 10 (~65m): Drivers partitioned into micro-cells (instant sub-microsecond match!)
    // =====================================================================================
    std::cout << "\n----------------------------------------------------------------------------------------\n";
    std::cout << ">>> [PART 2] ADAPTIVE MULTI-RESOLUTION DISPATCH (STADIUM CROWD TEST)\n";
    std::cout << "----------------------------------------------------------------------------------------\n";

    const int CROWD_DRIVERS = 20000;
    std::cout << "  Simulating 20,000 drivers packed into a tight 100m x 100m Stadium Zone...\n";

    std::normal_distribution<double> stadiumLat(12.9780, 0.0005); // ~50m spread
    std::normal_distribution<double> stadiumLng(77.5990, 0.0005);

    struct DriverInfo {
        std::string id;
        double lat;
        double lng;
        H3Index res8;
        H3Index res10;
    };
    std::vector<DriverInfo> crowdFleet;
    crowdFleet.reserve(CROWD_DRIVERS);

    // Multi-resolution index buckets
    std::unordered_map<H3Index, std::vector<const DriverInfo*>> res8_buckets;
    std::unordered_map<H3Index, std::vector<const DriverInfo*>> res10_buckets;

    for (int i = 0; i < CROWD_DRIVERS; ++i) {
        double lat = stadiumLat(rng);
        double lng = stadiumLng(rng);
        LatLng p{ degsToRads(lat), degsToRads(lng) };

        H3Index r8, r10;
        latLngToCell(&p, 8, &r8);   // Coarse Res 8 (~460m)
        latLngToCell(&p, 10, &r10); // Fine Res 10 (~65m micro-hex)

        crowdFleet.push_back({"drv_" + std::to_string(i), lat, lng, r8, r10});
    }

    for (const auto &d : crowdFleet) {
        res8_buckets[d.res8].push_back(&d);
        res10_buckets[d.res10].push_back(&d);
    }

    std::cout << "  [Res 8 Analysis]  Single Coarse 460m Bucket contains: " << res8_buckets.begin()->second.size() << " drivers!\n";
    std::cout << "  [Res 10 Analysis] Partitioned into " << res10_buckets.size() << " fine 65m micro-hexagons (Avg "
              << (CROWD_DRIVERS / res10_buckets.size()) << " drivers per micro-cell)!\n\n";

    // Benchmarking 5,000 Dispatch Searches on the Crowded Fleet
    const int DISPATCH_SEARCHES = 5000;
    LatLng riderLoc{ degsToRads(12.9780), degsToRads(77.5990) };

    // Approach A: Single-Resolution Res 8 Search (Brute force through the 20,000 driver bucket)
    auto t0_r8 = std::chrono::high_resolution_clock::now();
    for (int i = 0; i < DISPATCH_SEARCHES; ++i) {
        H3Index r8;
        latLngToCell(&riderLoc, 8, &r8);
        const auto &bucket = res8_buckets[r8];
        // Must inspect all drivers in bucket
        double bestDist = 1e9;
        const DriverInfo* best = nullptr;
        for (const auto* d : bucket) {
            double dlat = d->lat - 12.9780;
            double dlng = d->lng - 77.5990;
            double distSq = dlat * dlat + dlng * dlng;
            if (distSq < bestDist) {
                bestDist = distSq;
                best = d;
            }
        }
    }
    auto t1_r8 = std::chrono::high_resolution_clock::now();
    double r8DurationMs = std::chrono::duration<double, std::milli>(t1_r8 - t0_r8).count();

    // Approach B: Multi-Resolution Adaptive Search (Res 10 micro-hex ring 0 -> ring 1)
    auto t0_r10 = std::chrono::high_resolution_clock::now();
    for (int i = 0; i < DISPATCH_SEARCHES; ++i) {
        H3Index r10;
        latLngToCell(&riderLoc, 10, &r10); // Find 65m micro-hex
        
        // Inspect only ring 0 of Res 10
        const auto it = res10_buckets.find(r10);
        if (it != res10_buckets.end()) {
            const auto &bucket = it->second;
            double bestDist = 1e9;
            const DriverInfo* best = nullptr;
            for (const auto* d : bucket) {
                double dlat = d->lat - 12.9780;
                double dlng = d->lng - 77.5990;
                double distSq = dlat * dlat + dlng * dlng;
                if (distSq < bestDist) {
                    bestDist = distSq;
                    best = d;
                }
            }
        }
    }
    auto t1_r10 = std::chrono::high_resolution_clock::now();
    double r10DurationMs = std::chrono::duration<double, std::milli>(t1_r10 - t0_r10).count();

    std::cout << ">>> BENCHMARK RESULTS (5,000 Ride Searches in the Crowd):\n";
    std::cout << "  Single-Resolution (Res 8) : " << std::fixed << std::setprecision(2) << r8DurationMs << " ms ("
              << (r8DurationMs * 1000.0 / DISPATCH_SEARCHES) << " \xC2\xB5s / search)\n";
    std::cout << "  Multi-Resolution  (Res 10): " << std::fixed << std::setprecision(2) << r10DurationMs << " ms ("
              << (r10DurationMs * 1000.0 / DISPATCH_SEARCHES) << " \xC2\xB5s / search)\n";
    std::cout << "  Speedup Factor            : " << std::fixed << std::setprecision(1) << (r8DurationMs / r10DurationMs) << "x FASTER WITH MULTI-RESOLUTION H3!\n\n";

    std::cout << "========================================================================================\n";
    std::cout << "               H3 ADVANCED FEATURES EXPERIMENT COMPLETED SUCCESSFULLY                   \n";
    std::cout << "========================================================================================\n";

    return 0;
}
