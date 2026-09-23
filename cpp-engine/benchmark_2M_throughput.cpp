#include "Quadtree.hpp"
#include <iostream>
#include <vector>
#include <string>
#include <chrono>
#include <random>
#include <iomanip>
#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
size_t getPeakMemoryKB() {
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return pmc.PeakWorkingSetSize / 1024;
    }
    return 0;
}
size_t getCurrentMemoryKB() {
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return pmc.WorkingSetSize / 1024;
    }
    return 0;
}
#else
size_t getPeakMemoryKB() { return 0; }
size_t getCurrentMemoryKB() { return 0; }
#endif

int main() {
    std::cout << "======================================================================\n";
    std::cout << "      INSTARIDE C++ NATIVE ENGINE: 2,000,000 FLEET THROUGHPUT BENCHMARK\n";
    std::cout << "======================================================================\n\n";

    const int TOTAL_DRIVERS = 2000000;
    GeoBounds cityBounds = { 12.80, 13.20, 77.40, 77.85 }; // Greater Bengaluru metro region

    std::cout << "[System Config]\n";
    std::cout << "  - Fleet Size: " << TOTAL_DRIVERS << " active drivers\n";
    std::cout << "  - Region Bounds: [" << cityBounds.minLat << ", " << cityBounds.maxLat 
              << "] x [" << cityBounds.minLng << ", " << cityBounds.maxLng << "]\n";
    std::cout << "  - Quadtree Config: Capacity = 16, MaxDepth = 12\n\n";

    Quadtree tree(cityBounds, 16, 12);

    std::mt19937_64 rng(1337);
    std::uniform_real_distribution<double> latDist(cityBounds.minLat + 0.01, cityBounds.maxLat - 0.01);
    std::uniform_real_distribution<double> lngDist(cityBounds.minLng + 0.01, cityBounds.maxLng - 0.01);

    // ========================================================================
    // TEST 1: 2,000,000 DRIVER BULK INGESTION
    // ========================================================================
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << ">>> TEST 1: INGESTING 2,000,000 DRIVERS INTO C++ QUADTREE\n";
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "  Ingesting 2,000,000 unique spatial points...\n";

    size_t memBefore = getCurrentMemoryKB();
    auto startIngest = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < TOTAL_DRIVERS; ++i) {
        std::string id = "drv_" + std::to_string(i);
        double lat = latDist(rng);
        double lng = lngDist(rng);
        tree.insert(id, lat, lng);

        if ((i + 1) % 500000 == 0) {
            auto intermediate = std::chrono::high_resolution_clock::now();
            double elapsedSec = std::chrono::duration<double>(intermediate - startIngest).count();
            std::cout << "  -> Ingested " << std::setw(9) << (i + 1) << " drivers in " 
                      << std::fixed << std::setprecision(2) << elapsedSec << "s ("
                      << static_cast<int>((i + 1) / elapsedSec) << " drivers/sec)\n";
        }
    }

    auto endIngest = std::chrono::high_resolution_clock::now();
    double totalIngestSec = std::chrono::duration<double>(endIngest - startIngest).count();
    size_t memAfter = getCurrentMemoryKB();
    size_t peakMem = getPeakMemoryKB();

    double ingestRate = TOTAL_DRIVERS / totalIngestSec;
    double memUsedMB = (memAfter > memBefore) ? (memAfter - memBefore) / 1024.0 : 0.0;
    double bytesPerDriver = (memUsedMB * 1024.0 * 1024.0) / TOTAL_DRIVERS;

    std::cout << "\n[Ingestion Results]\n";
    std::cout << "  Total Drivers Ingested: " << TOTAL_DRIVERS << "\n";
    std::cout << "  Total Ingestion Time  : " << std::fixed << std::setprecision(3) << totalIngestSec << " s\n";
    std::cout << "  Ingestion Throughput  : " << std::fixed << std::setprecision(0) << ingestRate << " drivers/second\n";
    std::cout << "  RAM Used by 2M Fleet  : " << std::fixed << std::setprecision(1) << memUsedMB << " MB\n";
    std::cout << "  Peak Working Set (RSS): " << std::fixed << std::setprecision(1) << (peakMem / 1024.0) << " MB\n";
    std::cout << "  Memory Cost per Driver: " << std::fixed << std::setprecision(1) << bytesPerDriver << " bytes/driver\n\n";

    // ========================================================================
    // TEST 2: 2,000,000 GPS POSITION UPDATES THROUGHPUT
    // ========================================================================
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << ">>> TEST 2: REAL-TIME GPS TELEMETRY INGESTION (2,000,000 UPDATES)\n";
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "  Simulating continuous vehicle movement updates across the 2M fleet...\n";

    std::uniform_int_distribution<int> driverPicker(0, TOTAL_DRIVERS - 1);
    std::uniform_real_distribution<double> deltaDist(-0.0005, 0.0005); // ~50m GPS drift

    auto startUpdate = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < TOTAL_DRIVERS; ++i) {
        int idx = driverPicker(rng);
        std::string id = "drv_" + std::to_string(idx);
        double deltaLat = deltaDist(rng);
        double deltaLng = deltaDist(rng);
        tree.update(id, 13.00 + deltaLat, 77.60 + deltaLng);

        if ((i + 1) % 500000 == 0) {
            auto intermediate = std::chrono::high_resolution_clock::now();
            double elapsedSec = std::chrono::duration<double>(intermediate - startUpdate).count();
            std::cout << "  -> Processed " << std::setw(9) << (i + 1) << " updates in " 
                      << std::fixed << std::setprecision(2) << elapsedSec << "s ("
                      << static_cast<int>((i + 1) / elapsedSec) << " updates/sec)\n";
        }
    }

    auto endUpdate = std::chrono::high_resolution_clock::now();
    double totalUpdateSec = std::chrono::duration<double>(endUpdate - startUpdate).count();
    double updateThroughput = TOTAL_DRIVERS / totalUpdateSec;
    double avgUpdateUs = (totalUpdateSec * 1000000.0) / TOTAL_DRIVERS;

    std::cout << "\n[Telemetry Update Results]\n";
    std::cout << "  Total GPS Updates Processed: " << TOTAL_DRIVERS << "\n";
    std::cout << "  Total Time Taken           : " << std::fixed << std::setprecision(3) << totalUpdateSec << " s\n";
    std::cout << "  Telemetry Throughput       : " << std::fixed << std::setprecision(0) << updateThroughput << " updates/second\n";
    std::cout << "  Average Latency per Update : " << std::fixed << std::setprecision(2) << avgUpdateUs << " \xC2\xB5s (microseconds)\n\n";

    // ========================================================================
    // TEST 3: 100,000 HIGH-CONCURRENCY k-NN SPATIAL QUERIES
    // ========================================================================
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << ">>> TEST 3: HIGH-SPEED k-NN MATCHING QUERIES (100,000 QUERIES on 2M FLEET)\n";
    std::cout << "----------------------------------------------------------------------\n";

    const int QUERY_COUNT = 100000;
    std::vector<double> latenciesUs;
    latenciesUs.reserve(QUERY_COUNT);

    std::cout << "  Executing 100,000 spatial k-NN queries (k=5 nearest drivers)...\n";
    auto startQuery = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < QUERY_COUNT; ++i) {
        double qLat = latDist(rng);
        double qLng = lngDist(rng);

        auto t0 = std::chrono::high_resolution_clock::now();
        std::vector<CandidateDriver> candidates = tree.KNearestNeighBors(qLat, qLng, 5, 25000.0);
        auto t1 = std::chrono::high_resolution_clock::now();

        double us = std::chrono::duration<double, std::micro>(t1 - t0).count();
        latenciesUs.push_back(us);
    }

    auto endQuery = std::chrono::high_resolution_clock::now();
    double totalQuerySec = std::chrono::duration<double>(endQuery - startQuery).count();
    double queryThroughput = QUERY_COUNT / totalQuerySec;

    std::sort(latenciesUs.begin(), latenciesUs.end());
    double p50 = latenciesUs[QUERY_COUNT * 0.50];
    double p90 = latenciesUs[QUERY_COUNT * 0.90];
    double p95 = latenciesUs[QUERY_COUNT * 0.95];
    double p99 = latenciesUs[QUERY_COUNT * 0.99];
    double maxLat = latenciesUs.back();

    std::cout << "\n[Spatial Query Results on 2,000,000 Drivers]\n";
    std::cout << "  Queries Executed     : " << QUERY_COUNT << "\n";
    std::cout << "  Query Throughput     : " << std::fixed << std::setprecision(0) << queryThroughput << " queries/second\n";
    std::cout << "  Median Latency (p50) : " << std::fixed << std::setprecision(1) << p50 << " \xC2\xB5s (" << (p50 / 1000.0) << " ms)\n";
    std::cout << "  90th Percentile (p90): " << std::fixed << std::setprecision(1) << p90 << " \xC2\xB5s (" << (p90 / 1000.0) << " ms)\n";
    std::cout << "  95th Percentile (p95): " << std::fixed << std::setprecision(1) << p95 << " \xC2\xB5s (" << (p95 / 1000.0) << " ms)\n";
    std::cout << "  99th Percentile (p99): " << std::fixed << std::setprecision(1) << p99 << " \xC2\xB5s (" << (p99 / 1000.0) << " ms)\n";
    std::cout << "  Max Tail Latency     : " << std::fixed << std::setprecision(1) << maxLat << " \xC2\xB5s (" << (maxLat / 1000.0) << " ms)\n\n";

    // ========================================================================
    // TEST 4: INTERLEAVED PRODUCTION SATURATION (500,000 MIXED OPERATIONS)
    // ========================================================================
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << ">>> TEST 4: MIXED SATURATION (250,000 GPS UPDATES + 250,000 DISPATCH LOOKUPS)\n";
    std::cout << "----------------------------------------------------------------------\n";

    const int MIXED_OPS = 500000;
    auto startMixed = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < MIXED_OPS; ++i) {
        if (i % 2 == 0) {
            // Update
            int idx = driverPicker(rng);
            tree.update("drv_" + std::to_string(idx), latDist(rng), lngDist(rng));
        } else {
            // Search
            tree.KNearestNeighBors(latDist(rng), lngDist(rng), 5, 25000.0);
        }
    }

    auto endMixed = std::chrono::high_resolution_clock::now();
    double totalMixedSec = std::chrono::duration<double>(endMixed - startMixed).count();
    double mixedThroughput = MIXED_OPS / totalMixedSec;

    std::cout << "  Mixed Operations Completed : " << MIXED_OPS << " ops\n";
    std::cout << "  Total Execution Time       : " << std::fixed << std::setprecision(3) << totalMixedSec << " s\n";
    std::cout << "  Saturated Engine Throughput: " << std::fixed << std::setprecision(0) << mixedThroughput << " ops/second\n\n";

    std::cout << "======================================================================\n";
    std::cout << "  2,000,000 FLEET THROUGHPUT BENCHMARK COMPLETED SUCCESSFULLY\n";
    std::cout << "======================================================================\n";

    return 0;
}
