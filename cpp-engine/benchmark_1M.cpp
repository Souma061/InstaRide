#include "Quadtree.hpp"
#include <iostream>
#include <chrono>
#include <random>
#include <iomanip>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>

size_t getProcessMemoryMB()
{
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
    {
        return pmc.WorkingSetSize / (1024 * 1024);
    }
    return 0;
}
#else
size_t getProcessMemoryMB() { return 0; }
#endif

int main()
{
    std::cout << "========================================================\n";
    std::cout << "  InstaRide C++ Native Engine - 1,000,000 (1M) Benchmark \n";
    std::cout << "========================================================\n\n";

    // City Bounding Box (Delhi NCR / Greater Region)
    GeoBounds cityBounds{28.40, 28.90, 76.80, 77.50};
    // capacity 8, maxDepth 14 (4^14 > 268 Million capacity)
    Quadtree tree(cityBounds, 8, 14);

    const int NUM_DRIVERS = 1000000; // 1 MILLION DRIVERS
    const int NUM_QUERIES = 20000;   // 20,000 k-NN Queries
    const int K = 5;

    std::mt19937 rng(42);
    std::uniform_real_distribution<double> latDist(cityBounds.minLat, cityBounds.maxLat);
    std::uniform_real_distribution<double> lngDist(cityBounds.minLng, cityBounds.maxLng);

    size_t memBefore = getProcessMemoryMB();

    // =========================================================================
    // 1. INSERTION OF 1,000,000 DRIVERS
    // =========================================================================
    std::cout << "[1/3] Inserting 1,000,000 (1 Million) drivers into Quadtree...\n";

    auto startInsert = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < NUM_DRIVERS; ++i)
    {
        std::string driverId = "driver_" + std::to_string(i);
        double lat = latDist(rng);
        double lng = lngDist(rng);
        tree.insert(driverId, lat, lng);
    }

    auto endInsert = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double, std::milli> insertDuration = endInsert - startInsert;

    size_t memAfter = getProcessMemoryMB();

    std::cout << "  -> 1,000,000 drivers inserted in: "
              << std::fixed << std::setprecision(2) << insertDuration.count() << " ms ("
              << (insertDuration.count() / 1000.0) << " seconds)\n";
    std::cout << "  -> Insertion Throughput: "
              << (NUM_DRIVERS / (insertDuration.count() / 1000.0)) << " inserts/sec\n";
    std::cout << "  -> RAM Allocated for 1M entities: ~" << (memAfter - memBefore) << " MB (Total: " << memAfter << " MB)\n\n";

    // =========================================================================
    // 2. 50,000 GPS TELEMETRY UPDATES
    // =========================================================================
    const int NUM_UPDATES = 50000;
    std::cout << "[2/3] Simulating " << NUM_UPDATES << " GPS telemetry updates in 1M fleet...\n";

    auto startUpdate = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < NUM_UPDATES; ++i)
    {
        std::string driverId = "driver_" + std::to_string(i);
        double lat = latDist(rng);
        double lng = lngDist(rng);
        tree.update(driverId, lat, lng);
    }

    auto endUpdate = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double, std::milli> updateDuration = endUpdate - startUpdate;

    std::cout << "  -> " << NUM_UPDATES << " updates completed in: " << updateDuration.count() << " ms\n";
    std::cout << "  -> Update Throughput: "
              << (NUM_UPDATES / (updateDuration.count() / 1000.0)) << " updates/sec\n\n";

    // =========================================================================
    // 3. 20,000 k-NN SEARCHES ACROSS 1,000,000 DRIVERS
    // =========================================================================
    std::cout << "[3/3] Running " << NUM_QUERIES << " spatial searches (k=" << K << ") on 1M drivers...\n";

    auto startQuery = std::chrono::high_resolution_clock::now();

    int totalFound = 0;
    for (int i = 0; i < NUM_QUERIES; ++i)
    {
        double queryLat = latDist(rng);
        double queryLng = lngDist(rng);
        auto results = tree.KNearestNeighBors(queryLat, queryLng, K, 50000.0);
        totalFound += results.size();
    }

    auto endQuery = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double, std::milli> queryDuration = endQuery - startQuery;

    std::cout << "  -> " << NUM_QUERIES << " queries completed in: " << queryDuration.count() << " ms\n";
    std::cout << "  -> Average Latency per Query: "
              << (queryDuration.count() * 1000.0 / NUM_QUERIES) << " microseconds (us)\n";
    std::cout << "  -> Query Throughput: "
              << (NUM_QUERIES / (queryDuration.count() / 1000.0)) << " queries/sec\n";
    std::cout << "  -> Total candidate matches verified: " << totalFound << "\n\n";

    std::cout << "========================================================\n";
    std::cout << "            1,000,000 BENCHMARK COMPLETE                \n";
    std::cout << "========================================================\n";

    return 0;
}
