#include "Quadtree.hpp"
#include <chrono>
#include <random>
#include <iomanip>

int main()
{
    std::cout << "========================================================\n";
    std::cout << "   InstaRide C++ Core Engine - 100,000 Driver Benchmark   \n";
    std::cout << "========================================================\n\n";

    // 1. Setup City Bounding Box (e.g. Delhi NCR)
    GeoBounds cityBounds{28.40, 28.90, 76.80, 77.50};
    Quadtree tree(cityBounds, 8, 12);

    const int NUM_DRIVERS = 100000;
    const int NUM_QUERIES = 10000;
    const int K = 5;

    // Random Number Generator for coordinates inside Delhi NCR
    std::mt19937 rng(42); // Seed 42 for reproducible results
    std::uniform_real_distribution<double> latDist(cityBounds.minLat, cityBounds.maxLat);
    std::uniform_real_distribution<double> lngDist(cityBounds.minLng, cityBounds.maxLng);

    // =========================================================================
    // BENCHMARK 1: INSERTION OF 100,000 DRIVERS
    // =========================================================================
    std::cout << "[1/3] Inserting " << NUM_DRIVERS << " drivers into PR-Quadtree...\n";

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

    std::cout << "  -> Inserted " << NUM_DRIVERS << " drivers in: "
              << std::fixed << std::setprecision(2) << insertDuration.count() << " ms\n";
    std::cout << "  -> Throughput: "
              << (NUM_DRIVERS / (insertDuration.count() / 1000.0)) << " inserts/sec\n\n";

    // =========================================================================
    // BENCHMARK 2: TELEMETRY UPDATES (10,000 Position Updates)
    // =========================================================================
    std::cout << "[2/3] Simulating 10,000 GPS telemetry updates (fast-path O(1))...\n";

    auto startUpdate = std::chrono::high_resolution_clock::now();

    for (int i = 0; i < 10000; ++i)
    {
        std::string driverId = "driver_" + std::to_string(i);
        // Small nudge in coordinates (typical GPS jitter)
        double lat = latDist(rng);
        double lng = lngDist(rng);
        tree.update(driverId, lat, lng);
    }

    auto endUpdate = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double, std::milli> updateDuration = endUpdate - startUpdate;

    std::cout << "  -> 10,000 updates in: " << updateDuration.count() << " ms\n";
    std::cout << "  -> Throughput: "
              << (10000 / (updateDuration.count() / 1000.0)) << " updates/sec\n\n";

    // =========================================================================
    // BENCHMARK 3: 10,000 k-NN SEARCHES (FIND TOP-5 CLOSEST DRIVERS)
    // =========================================================================
    std::cout << "[3/3] Running " << NUM_QUERIES << " k-NN queries (k=" << K << ")...\n";

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

    std::cout << "  -> " << NUM_QUERIES << " queries executed in: "
              << queryDuration.count() << " ms\n";
    std::cout << "  -> Average Latency: "
              << (queryDuration.count() * 1000.0 / NUM_QUERIES) << " microseconds (us) per query\n";
    std::cout << "  -> Query Throughput: "
              << (NUM_QUERIES / (queryDuration.count() / 1000.0)) << " queries/sec\n";
    std::cout << "  -> Total candidate matches found: " << totalFound << "\n\n";

    std::cout << "========================================================\n";
    std::cout << "                   BENCHMARK COMPLETE                   \n";
    std::cout << "========================================================\n";

    return 0;
}
