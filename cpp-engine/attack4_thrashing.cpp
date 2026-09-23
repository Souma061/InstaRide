#include <iostream>
#include <iomanip>
#include <chrono>
#include <vector>
#include <string>
#include <cassert>
#include "Quadtree.hpp"

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
size_t getProcessMemoryBytes()
{
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
    {
        return pmc.WorkingSetSize;
    }
    return 0;
}
#else
size_t getProcessMemoryBytes() { return 0; }
#endif

int main()
{
    std::cout << "======================================================================\n";
    std::cout << "      ATTACK 4: LEAF BOUNDARY OSCILLATION & MEMORY LEAK TEST          \n";
    std::cout << "      Torturing Quadtree with Rapid Cross-Quadrant Thrashing          \n";
    std::cout << "======================================================================\n\n";

    GeoBounds bounds{12.86, 13.06, 77.50, 77.72};
    // Center point (boundary) of root:
    // midLat = (12.86 + 13.06) / 2 = 12.96
    // midLng = (77.50 + 77.72) / 2 = 77.61
    double midLat = (bounds.minLat + bounds.maxLat) / 2.0;
    double midLng = (bounds.minLng + bounds.maxLng) / 2.0;

    std::cout << "[Setup] Root boundary partition at: (" << midLat << ", " << midLng << ")\n";

    // TEST 1: In-Leaf Update Coordinate Freshness Test
    std::cout << "\n[Test 1] Testing In-Leaf Coordinate Freshness...\n";
    {
        Quadtree tree(bounds, 4, 8);
        tree.insert("driver_fresh", 12.90, 77.55); // in SW quadrant

        // Initial query
        auto c1 = tree.KNearestNeighBors(12.90, 77.55, 1);
        assert(!c1.empty());
        assert(c1[0].distance < 1.0);

        // Update driver position within the SAME leaf (e.g. moved 1km away)
        tree.update("driver_fresh", 12.91, 77.55);

        // Query at the NEW position (12.91, 77.55)
        auto c2 = tree.KNearestNeighBors(12.91, 77.55, 1);
        if (c2.empty() || c2[0].distance > 10.0)
        {
            std::cerr << "💥 STALE COORDINATE DETECTED! KNN returned distance: "
                      << (c2.empty() ? -1.0 : c2[0].distance) << " m (expected ~0 m)!\n";
        }
        else
        {
            std::cout << "  Passed: Fast-path in-leaf update reflected in KNN (dist = "
                      << c2[0].distance << " m).\n";
        }
    }

    // TEST 2: Boundary Oscillation Thrashing (500,000 flips across border)
    std::cout << "\n[Test 2] Oscillating 1 Driver across Quadrant Boundary 500,000 times...\n";
    {
        Quadtree tree(bounds, 4, 8);
        std::string oscDriver = "driver_oscillating";

        // Seed with 10 background drivers
        for (int i = 0; i < 10; ++i)
        {
            tree.insert("bg_" + std::to_string(i), 12.90 + (i * 0.01), 77.55);
        }

        double northLat = midLat + 0.0001; // North side of border
        double southLat = midLat - 0.0001; // South side of border
        double currentLng = midLng;

        tree.insert(oscDriver, northLat, currentLng);

        size_t memBefore = getProcessMemoryBytes();
        auto start = std::chrono::high_resolution_clock::now();

        const int OSCILLATIONS = 500000;
        for (int i = 0; i < OSCILLATIONS; ++i)
        {
            double targetLat = (i % 2 == 0) ? southLat : northLat;
            bool ok = tree.update(oscDriver, targetLat, currentLng);
            if (!ok)
            {
                std::cerr << "💥 FAILED: update returned false at iteration " << i << "\n";
                return 1;
            }
        }

        auto finish = std::chrono::high_resolution_clock::now();
        size_t memAfter = getProcessMemoryBytes();
        double elapsedSec = std::chrono::duration<double>(finish - start).count();

        std::cout << "  Completed " << OSCILLATIONS << " boundary crossings in "
                  << std::fixed << std::setprecision(3) << elapsedSec << " s ("
                  << (int)(OSCILLATIONS / elapsedSec) << " updates/sec)\n";
        std::cout << "  Memory Before: " << (memBefore / 1024.0 / 1024.0) << " MB\n";
        std::cout << "  Memory After : " << (memAfter / 1024.0 / 1024.0) << " MB\n";
        long long memDeltaBytes = (long long)memAfter - (long long)memBefore;
        std::cout << "  Memory Delta : " << (memDeltaBytes / 1024.0 / 1024.0) << " MB\n";

        // Invariant check: size must remain exactly 11 (10 bg + 1 osc)
        assert(tree.size() == 11);

        // Verify driver is accurately queried
        double finalExpectedLat = (OSCILLATIONS % 2 == 1) ? southLat : northLat;
        auto knn = tree.KNearestNeighBors(finalExpectedLat, currentLng, 1);
        assert(!knn.empty());
        assert(knn[0].id == oscDriver);
        std::cout << "  Tree size invariant: " << tree.size() << " drivers (Expected: 11)\n";
        std::cout << "  Final KNN position check passed: distance = " << knn[0].distance << " m\n";

        if (memDeltaBytes > 10 * 1024 * 1024)
        { // More than 10MB leaked for 1 driver
            std::cerr << "💥 MEMORY LEAK CONFIRMED: " << (memDeltaBytes / 1024.0 / 1024.0)
                      << " MB leaked during 500k boundary oscillations!\n";
        }
        else
        {
            std::cout << "  Zero critical memory leak detected during oscillation.\n";
        }
    }

    // TEST 3: Rapid Churn (100,000 Insert + Remove cycles)
    std::cout << "\n[Test 3] Testing 100,000 Full Insert + Remove Churn Cycles...\n";
    {
        Quadtree tree(bounds, 4, 8);
        size_t memBefore = getProcessMemoryBytes();

        for (int i = 0; i < 100000; ++i)
        {
            std::string id = "churn_driver_" + std::to_string(i % 100);
            tree.insert(id, 12.95, 77.60);
            tree.remove(id);
        }

        size_t memAfter = getProcessMemoryBytes();
        long long churnDelta = (long long)memAfter - (long long)memBefore;
        std::cout << "  Final Tree Size: " << tree.size() << " (Expected: 0)\n";
        std::cout << "  Memory Delta: " << (churnDelta / 1024.0 / 1024.0) << " MB\n";

        assert(tree.size() == 0);
    }

    std::cout << "\n======================================================================\n";
    std::cout << "  ATTACK 4 TEST COMPLETE                                             \n";
    std::cout << "======================================================================\n";
    return 0;
}
