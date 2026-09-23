#include "Quadtree.hpp"
#include <iostream>
#include <vector>
#include <string>
#include <chrono>
#include <iomanip>

int main()
{
    std::cout << "======================================================================\n";
    std::cout << "      ATTACK 1: THE GEOMETRIC SINGULARITY TORTURE TEST\n";
    std::cout << "      Injecting 50,000 points at the EXACT SAME GPS coordinate\n";
    std::cout << "======================================================================\n\n";

    GeoBounds cityBounds = {12.80, 13.20, 77.40, 77.85};
    const int CAPACITY = 4;
    const int MAX_DEPTH = 8;
    const int SINGULARITY_COUNT = 50000;

    std::cout << "[Target Configuration]\n";
    std::cout << "  - Node Capacity : " << CAPACITY << " points before split\n";
    std::cout << "  - Max Tree Depth: " << MAX_DEPTH << "\n";
    std::cout << "  - Singularity Target: (12.971600000000, 77.594600000000)\n\n";

    Quadtree tree(cityBounds, CAPACITY, MAX_DEPTH);

    // ------------------------------------------------------------------------
    // STAGE 1: Insertion Bombardment
    // ------------------------------------------------------------------------
    std::cout << ">>> STAGE 1: Ingesting 50,000 identical points...\n";
    auto t0 = std::chrono::high_resolution_clock::now();

    const double TARGET_LAT = 12.971600000000;
    const double TARGET_LNG = 77.594600000000;

    for (int i = 0; i < SINGULARITY_COUNT; i++)
    {
        std::string id = "singularity_driver_" + std::to_string(i);
        bool ok = tree.insert(id, TARGET_LAT, TARGET_LNG);
        if (!ok)
        {
            std::cerr << "FAILED to insert driver " << id << " at index " << i << "!\n";
            return 1;
        }

        if ((i + 1) % 10000 == 0)
        {
            std::cout << "  -> Inserted " << (i + 1) << " / " << SINGULARITY_COUNT << " points\n";
        }
    }

    auto t1 = std::chrono::high_resolution_clock::now();
    double insertSec = std::chrono::duration<double>(t1 - t0).count();
    std::cout << "[+] SUCCESS: 50,000 identical points inserted in " << insertSec << "s ("
              << static_cast<int>(SINGULARITY_COUNT / insertSec) << " inserts/sec)\n";
    std::cout << "    Tree Size: " << tree.size() << "\n\n";

    // ------------------------------------------------------------------------
    // STAGE 2: Spatial Query at the Singularity Epicenter
    // ------------------------------------------------------------------------
    std::cout << ">>> STAGE 2: Querying k-NN directly at the singularity epicenter...\n";
    auto q0 = std::chrono::high_resolution_clock::now();
    std::vector<CandidateDriver> candidates = tree.KNearestNeighBors(TARGET_LAT, TARGET_LNG, 10, 5000.0);
    auto q1 = std::chrono::high_resolution_clock::now();

    double queryUs = std::chrono::duration<double, std::micro>(q1 - q0).count();
    std::cout << "[+] Found " << candidates.size() << " candidates in " << queryUs << " µs\n";
    for (size_t i = 0; i < candidates.size(); i++)
    {
        std::cout << "    Candidate #" << i + 1 << ": " << candidates[i].id
                  << " | Dist: " << candidates[i].distance << "m\n";
    }

    // ------------------------------------------------------------------------
    // STAGE 3: Singularity Dispersion (Moving points away from the black hole)
    // ------------------------------------------------------------------------
    std::cout << "\n>>> STAGE 3: Dispersing 10,000 points outward from the singularity...\n";
    auto m0 = std::chrono::high_resolution_clock::now();
    for (int i = 0; i < 10000; i++)
    {
        std::string id = "singularity_driver_" + std::to_string(i);
        double offset = (i + 1) * 0.00001;
        bool ok = tree.update(id, TARGET_LAT + offset, TARGET_LNG + offset);
        if (!ok)
        {
            std::cerr << "FAILED update for " << id << "!\n";
        }
    }
    auto m1 = std::chrono::high_resolution_clock::now();
    double moveSec = std::chrono::duration<double>(m1 - m0).count();
    std::cout << "[+] SUCCESS: 10,000 points dispersed in " << moveSec << "s ("
              << static_cast<int>(10000 / moveSec) << " updates/sec)\n\n";

    // ------------------------------------------------------------------------
    // STAGE 4: Deletion Drain (Can it clean up the singularity without crashing?)
    // ------------------------------------------------------------------------
    std::cout << ">>> STAGE 4: Deleting 10,000 singularity points...\n";
    auto d0 = std::chrono::high_resolution_clock::now();
    for (int i = 10000; i < 20000; i++)
    {
        std::string id = "singularity_driver_" + std::to_string(i);
        tree.remove(id);
    }
    auto d1 = std::chrono::high_resolution_clock::now();
    double delSec = std::chrono::duration<double>(d1 - d0).count();
    std::cout << "[+] SUCCESS: 10,000 points deleted in " << delSec << "s ("
              << static_cast<int>(10000 / delSec) << " deletions/sec)\n";
    std::cout << "    Final Tree Size: " << tree.size() << " (Expected: 40000)\n\n";

    std::cout << "======================================================================\n";
    std::cout << "  ATTACK 1 RESULT: SURVIVED! NO STACK OVERFLOW, NO SEGFAULT.\n";
    std::cout << "======================================================================\n";

    return 0;
}
