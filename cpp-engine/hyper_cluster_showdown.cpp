#include <iostream>
#include <iomanip>
#include <vector>
#include <string>
#include <unordered_map>
#include <chrono>
#include <random>
#include <algorithm>
#include "Quadtree.hpp"
#include "h3api.h"

inline double degsToRads(double deg) {
    return deg * 3.14159265358979323846 / 180.0;
}

int main() {
    std::cout << "========================================================================================\n";
    std::cout << "      HYPER-CLUSTER RESOLUTION EXPLORATION: QUADTREE (DEPTH 14) vs H3 (RES 8, 12, 14)   \n";
    std::cout << "========================================================================================\n\n";

    const int CLUSTER_DRIVERS = 100000;
    const int QUERY_COUNT = 5000;
    const int K = 20;

    std::mt19937_64 rng(1337);
    std::uniform_real_distribution<double> tinyLat(12.9715, 12.9720); // 50m x 50m box
    std::uniform_real_distribution<double> tinyLng(77.5940, 77.5945);

    struct DriverPt {
        std::string id;
        double lat;
        double lng;
        LatLng h3Pt;
    };
    std::vector<DriverPt> clusterFleet;
    clusterFleet.reserve(CLUSTER_DRIVERS);

    for (int i = 0; i < CLUSTER_DRIVERS; ++i) {
        double lat = tinyLat(rng);
        double lng = tinyLng(rng);
        clusterFleet.push_back({
            "drv_" + std::to_string(i),
            lat,
            lng,
            { degsToRads(lat), degsToRads(lng) }
        });
    }

    LatLng queryCenter{ degsToRads(12.97175), degsToRads(77.59425) };

    // 1. QUADTREE (Adaptive subdivisions down to Depth 14)
    GeoBounds cityBounds{12.80, 13.20, 77.40, 77.85};
    Quadtree qt(cityBounds, 16, 14);
    for (const auto &d : clusterFleet) qt.insert(d.id, d.lat, d.lng);

    std::vector<double> qtLatencies(QUERY_COUNT);
    auto t0_qt = std::chrono::high_resolution_clock::now();
    for (int q = 0; q < QUERY_COUNT; ++q) {
        auto s0 = std::chrono::high_resolution_clock::now();
        auto res = qt.KNearestNeighBors(12.97175, 77.59425, K, 5000.0);
        auto s1 = std::chrono::high_resolution_clock::now();
        qtLatencies[q] = std::chrono::duration<double, std::micro>(s1 - s0).count();
    }
    auto t1_qt = std::chrono::high_resolution_clock::now();
    double qtTotalMs = std::chrono::duration<double, std::milli>(t1_qt - t0_qt).count();
    std::sort(qtLatencies.begin(), qtLatencies.end());

    // 2. H3 RESOLUTION 14 (~1.3m Edge - Matches Quadtree Depth 14 resolution!)
    std::unordered_map<H3Index, std::vector<const DriverPt*>> h3Res14Buckets;
    for (const auto &d : clusterFleet) {
        H3Index cell;
        latLngToCell(&d.h3Pt, 14, &cell); // Resolution 14 (~1.3m)
        h3Res14Buckets[cell].push_back(&d);
    }

    H3Index center14;
    latLngToCell(&queryCenter, 14, &center14);

    // In Res 14, k=2 rings (19 cells) covers ~5 meters radius around rider
    H3Index disk14[19];
    gridDisk(center14, 2, disk14);

    std::vector<double> h3_14_Latencies(QUERY_COUNT);
    auto t0_h3_14 = std::chrono::high_resolution_clock::now();
    for (int q = 0; q < QUERY_COUNT; ++q) {
        auto s0 = std::chrono::high_resolution_clock::now();
        std::vector<std::pair<double, const DriverPt*>> candidates;
        for (int i = 0; i < 19; ++i) {
            auto it = h3Res14Buckets.find(disk14[i]);
            if (it == h3Res14Buckets.end()) continue;
            for (const auto *d : it->second) {
                double dlat = d->lat - 12.97175;
                double dlng = d->lng - 77.59425;
                double distSq = dlat * dlat + dlng * dlng;
                if (candidates.size() < K || distSq < candidates.back().first) {
                    candidates.push_back({distSq, d});
                    std::sort(candidates.begin(), candidates.end(), [](const auto &a, const auto &b){ return a.first < b.first; });
                    if (candidates.size() > K) candidates.pop_back();
                }
            }
        }
        auto s1 = std::chrono::high_resolution_clock::now();
        h3_14_Latencies[q] = std::chrono::duration<double, std::micro>(s1 - s0).count();
    }
    auto t1_h3_14 = std::chrono::high_resolution_clock::now();
    double h3_14_TotalMs = std::chrono::duration<double, std::milli>(t1_h3_14 - t0_h3_14).count();
    std::sort(h3_14_Latencies.begin(), h3_14_Latencies.end());

    std::cout << "----------------------------------------------------------------------------------------\n";
    std::cout << ">>> HYPER-CLUSTER COMPARISON (100,000 Drivers in 50m x 50m Micro-Zone)\n";
    std::cout << "----------------------------------------------------------------------------------------\n";
    std::cout << "  Quadtree Depth 14  : Evaluated leaf cells | Throughput: " << static_cast<int>(QUERY_COUNT / (qtTotalMs / 1000.0)) << " req/s\n";
    std::cout << "                       Latency: p50: " << qtLatencies[QUERY_COUNT * 0.5] << " us | p99: " << qtLatencies[QUERY_COUNT * 0.99] << " us\n\n";

    std::cout << "  H3 Res 14 (~1.3m)  : Partitioned into " << h3Res14Buckets.size() << " micro-hexes! | Throughput: " << static_cast<int>(QUERY_COUNT / (h3_14_TotalMs / 1000.0)) << " req/s\n";
    std::cout << "                       Latency: p50: " << h3_14_Latencies[QUERY_COUNT * 0.5] << " us | p99: " << h3_14_Latencies[QUERY_COUNT * 0.99] << " us\n";
    std::cout << "----------------------------------------------------------------------------------------\n";

    return 0;
}
