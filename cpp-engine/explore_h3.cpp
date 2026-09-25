#include <iostream>
#include <iomanip>
#include <vector>
#include <chrono>
#include "h3/build/src/h3lib/include/h3api.h"

// Helper function to convert radians to degrees and vice versa
inline double degsToRads(double deg) {
    return deg * 3.14159265358979323846 / 180.0;
}
inline double radsToDegs(double rad) {
    return rad * 180.0 / 3.14159265358979323846;
}

int main() {
    std::cout << "========================================================================================\n";
    std::cout << "               UBER H3 OFFICIAL C++ NATIVE LIBRARY: EXPLORATION & PLAYGROUND            \n";
    std::cout << "========================================================================================\n\n";

    // Greater Bengaluru location (MG Road)
    LatLng location;
    location.lat = degsToRads(12.9715987);
    location.lng = degsToRads(77.5945627);

    // ========================================================================
    // 1. ALL RESOLUTIONS (0 to 15)
    // ========================================================================
    std::cout << ">>> [1] H3 INDEX CONVERSION AT MULTIPLE RESOLUTIONS:\n";
    std::cout << "----------------------------------------------------------------------------------------\n";
    std::cout << std::left << std::setw(12) << "Resolution"
              << std::setw(22) << "H3 Index (Hex)"
              << std::setw(22) << "H3 Index (uint64)"
              << "Approx. Cell Edge Length\n";
    std::cout << "----------------------------------------------------------------------------------------\n";

    const char* edgeLengths[] = {
        "1,107 km", "418 km", "158 km", "59.8 km", "22.6 km",
        "8.54 km", "3.23 km", "1.22 km", "461 meters", "174 meters",
        "65.9 meters", "24.9 meters", "9.4 meters", "3.5 meters", "1.3 meters", "0.5 meters"
    };

    for (int res = 6; res <= 15; ++res) {
        H3Index cell;
        H3Error err = latLngToCell(&location, res, &cell);
        if (err == E_SUCCESS) {
            char hexString[17];
            h3ToString(cell, hexString, sizeof(hexString));
            std::cout << "Res " << std::setw(8) << res
                      << std::setw(22) << hexString
                      << std::setw(22) << cell
                      << edgeLengths[res] << "\n";
        }
    }

    // ========================================================================
    // 2. PARENT & CHILDREN (APERTURE 7 ZOOMING)
    // ========================================================================
    std::cout << "\n>>> [2] APERTURE 7 HIERARCHY (ZOOM OUT & ZOOM IN):\n";
    std::cout << "----------------------------------------------------------------------------------------\n";

    H3Index cityCell; // Res 8 (~461m)
    latLngToCell(&location, 8, &cityCell);
    char cityHex[17];
    h3ToString(cityCell, cityHex, sizeof(cityHex));
    std::cout << "Base Cell (Resolution 8): " << cityHex << " (~461m edge)\n";

    // Zoom out to Parent (Res 7)
    H3Index parentCell;
    cellToParent(cityCell, 7, &parentCell);
    char parentHex[17];
    h3ToString(parentCell, parentHex, sizeof(parentHex));
    std::cout << "  -> Zoom Out to Parent (Res 7): " << parentHex << " (~1.22km edge)\n";

    // Zoom in to 7 Children (Res 9)
    int64_t childCount;
    cellToChildrenSize(cityCell, 9, &childCount);
    std::vector<H3Index> children(childCount);
    cellToChildren(cityCell, 9, children.data());

    std::cout << "  -> Zoom In to 7 Children (Res 9, ~174m edge):\n";
    for (int i = 0; i < childCount; ++i) {
        char childHex[17];
        h3ToString(children[i], childHex, sizeof(childHex));
        std::cout << "     Child [" << i << "]: " << childHex << "\n";
    }

    // ========================================================================
    // 3. CONCENTRIC RING EXPANSION (GRID DISK)
    // ========================================================================
    std::cout << "\n>>> [3] CONCENTRIC RINGS (GRID DISK):\n";
    std::cout << "----------------------------------------------------------------------------------------\n";
    int kRingRadius = 2; // 2 rings = 19 hexes
    int64_t diskSize;
    maxGridDiskSize(kRingRadius, &diskSize);
    std::vector<H3Index> disk(diskSize);
    gridDisk(cityCell, kRingRadius, disk.data());

    std::cout << "Grid Disk of radius k=" << kRingRadius << " around origin contains " << diskSize << " hexagons:\n";
    for (int i = 0; i < std::min<int>(6, diskSize); ++i) {
        char dHex[17];
        h3ToString(disk[i], dHex, sizeof(dHex));
        std::cout << "  Neighbor [" << i << "]: " << dHex << "\n";
    }
    std::cout << "  ... and " << (diskSize - 6) << " more neighbors.\n";

    // ========================================================================
    // 4. HIGH-SPEED THROUGHPUT BENCHMARK (NATIVE C CORE)
    // ========================================================================
    std::cout << "\n>>> [4] NATIVE C++ THROUGHPUT BENCHMARK:\n";
    std::cout << "----------------------------------------------------------------------------------------\n";

    const int OPS = 2000000; // 2 Million operations
    auto t0 = std::chrono::high_resolution_clock::now();
    H3Index dummy = 0;
    for (int i = 0; i < OPS; ++i) {
        LatLng p;
        p.lat = degsToRads(12.80 + (i % 4000) * 0.0001);
        p.lng = degsToRads(77.40 + (i % 4000) * 0.0001);
        latLngToCell(&p, 9, &dummy);
    }
    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsedSec = std::chrono::duration<double>(t1 - t0).count();

    std::cout << "  Computed 2,000,000 latLngToCell conversions in: " << std::fixed << std::setprecision(3) << elapsedSec << " s\n";
    std::cout << "  Throughput: " << std::fixed << std::setprecision(0) << (OPS / elapsedSec) << " conversions / second!\n";
    std::cout << "  Latency:    " << std::fixed << std::setprecision(2) << ((elapsedSec * 1e9) / OPS) << " nanoseconds per coordinate!\n";

    std::cout << "\n========================================================================================\n";
    std::cout << "                  OFFICIAL UBER H3 EXPLORATION COMPLETED SUCCESSFULLY                   \n";
    std::cout << "========================================================================================\n";

    return 0;
}
