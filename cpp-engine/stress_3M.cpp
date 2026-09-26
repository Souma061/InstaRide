// 3,000,000-point stress test: C++ Quadtree + Uber H3.
// Build: g++ -O3 -std=c++14 -I cpp-engine cpp-engine/stress_3M.cpp -L cpp-engine -lh3 -lpsapi -o cpp-engine/stress_3M.exe
#include "Quadtree.hpp"
#include "h3api.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
static size_t peakMemKB()
{
    PROCESS_MEMORY_COUNTERS pmc;
    return GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)) ? pmc.PeakWorkingSetSize / 1024 : 0;
}
static size_t curMemKB()
{
    PROCESS_MEMORY_COUNTERS pmc;
    return GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)) ? pmc.WorkingSetSize / 1024 : 0;
}
#else
static size_t peakMemKB() { return 0; }
static size_t curMemKB() { return 0; }
#endif

using Clock = std::chrono::high_resolution_clock;

static double secSince(const Clock::time_point &t0)
{
    return std::chrono::duration<double>(Clock::now() - t0).count();
}

// degsToRads()/radsToDegs() are exported by h3api.h itself — do not redeclare.

static void hdr(const std::string &title)
{
    std::cout << "\n----------------------------------------------------------------------------------------\n";
    std::cout << ">>> " << title << "\n";
    std::cout << "----------------------------------------------------------------------------------------\n";
}

static double percentile(std::vector<double> &v, double p)
{
    if (v.empty())
        return 0.0;
    size_t idx = static_cast<size_t>(p * (v.size() - 1));
    return v[idx];
}

// Haversine, meters (same formula Quadtree.hpp uses)
static double haversine(double lat1, double lng1, double lat2, double lng2)
{
    static const double R = 6371000.0;
    double p1 = degsToRads(lat1), p2 = degsToRads(lat2);
    double dp = p2 - p1, dl = degsToRads(lng2 - lng1);
    double a = std::sin(dp / 2) * std::sin(dp / 2) +
               std::cos(p1) * std::cos(p2) * std::sin(dl / 2) * std::sin(dl / 2);
    return 2 * R * std::asin(std::sqrt(a));
}

static int g_failures = 0;
static void check(const std::string &name, bool ok, const std::string &detail = "")
{
    std::cout << "  [" << (ok ? "PASS" : "FAIL") << "] " << name;
    if (!detail.empty())
        std::cout << " - " << detail;
    std::cout << "\n";
    if (!ok)
        g_failures++;
}

// ============================================================================ PART A
static void stressQuadtree(int N)
{
    const GeoBounds bounds = {12.80, 13.20, 77.40, 77.85}; // Greater Bengaluru metro
    Quadtree tree(bounds, 16, 12);

    std::mt19937_64 rng(20260926);
    std::uniform_real_distribution<double> latDist(bounds.minLat + 0.01, bounds.maxLat - 0.01);
    std::uniform_real_distribution<double> lngDist(bounds.minLng + 0.01, bounds.maxLng - 0.01);

    std::cout << "\n======================================================================\n";
    std::cout << "       PART A: C++ QUADTREE " << N / 1000000 << ",000,000 POINT STRESS\n";
    std::cout << "======================================================================\n";
    std::cout << "  - Capacity = 16, MaxDepth = 12\n  - Region: [" << bounds.minLat << "," << bounds.maxLat
              << "] x [" << bounds.minLng << "," << bounds.maxLng << "]\n";

    // ---- A1: bulk ingestion
    hdr("A1: BULK INGESTION");
    {
        auto t0 = Clock::now();
        for (int i = 0; i < N; ++i)
        {
            tree.insert("drv_" + std::to_string(i), latDist(rng), lngDist(rng));
            if ((i + 1) % 1000000 == 0)
            {
                double s = secSince(t0);
                std::cout << "  -> " << std::setw(9) << (i + 1) << " drivers in " << std::fixed
                          << std::setprecision(2) << s << " s (" << std::setprecision(0)
                          << ((i + 1) / s) << " inserts/s) | heap " << curMemKB() / 1024 << " MB\n";
            }
        }
        double s = secSince(t0);
        std::cout << "  -> TOTAL " << N << " inserts in " << std::fixed << std::setprecision(2) << s
                  << " s (" << std::setprecision(0) << (N / s) << " inserts/s)\n";
        check("all points ingested", tree.size() == static_cast<size_t>(N),
              "size=" + std::to_string(tree.size()));
    }

    // ---- A2: GPS telemetry updates
    hdr("A2: GPS TELEMETRY UPDATES");
    {
        auto t0 = Clock::now();
        for (int i = 0; i < N; ++i)
        {
            tree.update("drv_" + std::to_string(i), latDist(rng), lngDist(rng));
            if ((i + 1) % 1000000 == 0)
                std::cout << "  -> " << (i + 1) << " updates @ "
                          << std::fixed << std::setprecision(0) << ((i + 1) / secSince(t0))
                          << " updates/s\n";
        }
        double s = secSince(t0);
        std::cout << "  -> TOTAL " << N << " updates in " << std::setprecision(2) << s << " s ("
                  << std::setprecision(0) << (N / s) << " updates/s)\n";
        check("size stable after updates", tree.size() == static_cast<size_t>(N),
              "size=" + std::to_string(tree.size()));
    }

    // ---- A3: KNN query throughput + tail latency
    const int QUERIES = 100000;
    hdr("A3: k-NN MATCHING QUERIES (k=5, radius 10km)");
    {
        std::vector<double> latUs;
        latUs.reserve(QUERIES);
        size_t totalFound = 0;
        auto t0 = Clock::now();
        for (int i = 0; i < QUERIES; ++i)
        {
            double qlat = latDist(rng), qlng = lngDist(rng);
            auto q0 = Clock::now();
            auto res = tree.KNearestNeighBors(qlat, qlng, 5, 10000.0);
            latUs.push_back(std::chrono::duration<double, std::micro>(Clock::now() - q0).count());
            totalFound += res.size();
        }
        double s = secSince(t0);
        std::sort(latUs.begin(), latUs.end());
        std::cout << "  -> " << QUERIES << " queries in " << std::fixed << std::setprecision(2) << s
                  << " s | " << std::setprecision(0) << (QUERIES / s) << " queries/s\n";
        std::cout << "  -> Latency: avg " << std::setprecision(1)
                  << (std::accumulate(latUs.begin(), latUs.end(), 0.0) / latUs.size())
                  << " us | p50 " << percentile(latUs, 0.50) << " us | p95 " << percentile(latUs, 0.95)
                  << " us | p99 " << percentile(latUs, 0.99) << " us | max " << latUs.back() << " us\n";
        check("every query returned at least one neighbour", totalFound > 0,
              "total=" + std::to_string(totalFound));
    }

    // ---- A4: correctness vs brute force on an independent 200k replica
    hdr("A4: ACCURACY AUDIT vs BRUTE FORCE (40 PROBES x 200,000 POINTS)");
    {
        Quadtree ref(bounds, 16, 12);
        const int REF_N = 200000;
        std::mt19937_64 r3(99);
        std::vector<std::pair<double, double>> coords;
        coords.reserve(REF_N);
        for (int i = 0; i < REF_N; ++i)
        {
            double la = latDist(r3), ln = lngDist(r3);
            coords.push_back({la, ln});
            ref.insert("ref_" + std::to_string(i), la, ln);
        }

        struct BF
        {
            std::string id;
            double d;
        };
        int mismatches = 0;
        double worstGap = 0;
        for (int q = 0; q < 400; q += 10)
        {
            double qlat = coords[q].first, qlng = coords[q].second;
            auto got = ref.KNearestNeighBors(qlat, qlng, 5, 100000.0);

            std::vector<BF> all;
            all.reserve(REF_N);
            for (int i = 0; i < REF_N; ++i)
                all.push_back({"ref_" + std::to_string(i),
                               haversine(qlat, qlng, coords[i].first, coords[i].second)});
            std::partial_sort(all.begin(), all.begin() + 5, all.end(),
                              [](const BF &a, const BF &b) { return a.d < b.d; });

            bool same = got.size() == 5;
            for (int i = 0; same && i < 5; ++i)
            {
                if (got[i].id != all[i].id)
                    same = false;
                double gap = std::fabs(got[i].distance - all[i].d);
                worstGap = std::max(worstGap, gap);
                if (gap > 1.0)
                    same = false;
            }
            if (!same)
                mismatches++;
        }
        check("k-NN top-5 identical to brute force", mismatches == 0,
              "mismatches=" + std::to_string(mismatches) +
                  " worstDistanceGap=" + std::to_string(worstGap) + "m");
    }

    // ---- A5: churn — half the fleet removed then re-inserted
    hdr("A5: CHURN (1,500,000 REMOVES + 1,500,000 RE-INSERTS)");
    {
        const int HALF = N / 2;
        auto t0 = Clock::now();
        int removed = 0;
        for (int i = 0; i < HALF; ++i)
            if (tree.remove("drv_" + std::to_string(i)))
                removed++;
        double rmS = secSince(t0);
        std::cout << "  -> removed " << removed << " in " << std::fixed << std::setprecision(2) << rmS
                  << " s (" << std::setprecision(0) << (removed / rmS) << " removes/s)\n";
        check("half the fleet removed", tree.size() == static_cast<size_t>(N - HALF),
              "size=" + std::to_string(tree.size()));

        auto t1 = Clock::now();
        for (int i = 0; i < HALF; ++i)
            tree.insert("drv_" + std::to_string(i), latDist(rng), lngDist(rng));
        double inS = secSince(t1);
        std::cout << "  -> re-inserted " << HALF << " in " << std::setprecision(2) << inS << " s ("
                  << std::setprecision(0) << (HALF / inS) << " inserts/s)\n";
        check("fleet restored after churn", tree.size() == static_cast<size_t>(N),
              "size=" + std::to_string(tree.size()));
    }

    // ---- A6: mixed saturation
    hdr("A6: MIXED SATURATION (250,000 UPDATES + 250,000 KNN)");
    {
        auto t0 = Clock::now();
        for (int i = 0; i < 250000; ++i)
            tree.update("drv_" + std::to_string(rng() % N), latDist(rng), lngDist(rng));
        for (int i = 0; i < 250000; ++i)
            tree.KNearestNeighBors(latDist(rng), lngDist(rng), 5, 10000.0);
        double s = secSince(t0);
        std::cout << "  -> 500,000 mixed ops in " << std::fixed << std::setprecision(2) << s << " s ("
                  << std::setprecision(0) << (500000 / s) << " ops/s)\n";
        check("size unchanged after mixed load", tree.size() == static_cast<size_t>(N),
              "size=" + std::to_string(tree.size()));
    }

    std::cout << "  -> Peak working set: " << peakMemKB() / 1024 << " MB | final "
              << curMemKB() / 1024 << " MB\n";
}

// ============================================================================ PART B
static void stressH3(int N)
{
    std::cout << "\n======================================================================\n";
    std::cout << "       PART B: UBER H3 ENGINE " << N / 1000000 << ",000,000 POINT STRESS\n";
    std::cout << "======================================================================\n";
    std::cout << "  - H3 v" << H3_VERSION_MAJOR << "." << H3_VERSION_MINOR << "." << H3_VERSION_PATCH
              << " | resolutions 8 (~460m), 9 (~174m), 10 (~65m)\n";

    const double minLat = 12.80, maxLat = 13.20, minLng = 77.40, maxLng = 77.85;
    std::mt19937_64 rng(20260926);
    std::uniform_real_distribution<double> latDist(minLat + 0.01, maxLat - 0.01);
    std::uniform_real_distribution<double> lngDist(minLng + 0.01, maxLng - 0.01);

    std::vector<LatLng> pts(N);
    for (int i = 0; i < N; ++i)
    {
        pts[i].lat = degsToRads(latDist(rng));
        pts[i].lng = degsToRads(lngDist(rng));
    }

    const int resolutions[] = {8, 9, 10};
    std::unordered_map<uint64_t, int> cellCount;
    cellCount.reserve(4000000);

    // ---- B1: bulk latLngToCell across 3 resolutions
    hdr("B1: BULK latLngToCell (3,000,000 POINTS x 3 RESOLUTIONS = 9,000,000 CONVERSIONS)");
    for (int r : resolutions)
    {
        int errors = 0;
        cellCount.clear();
        auto t0 = Clock::now();
        uint64_t last = 0;
        for (int i = 0; i < N; ++i)
        {
            H3Index cell = 0;
            if (latLngToCell(&pts[i], r, &cell) != E_SUCCESS || cell == 0)
                errors++;
            else
            {
                last = cell;
                cellCount[cell]++;
            }
        }
        double s = secSince(t0);
        std::cout << "  -> res " << r << ": " << N << " conversions in " << std::fixed
                  << std::setprecision(2) << s << " s (" << std::setprecision(0) << (N / s)
                  << " conv/s) | distinct cells: " << cellCount.size() << "\n";

        // busiest cell + coverage sanity
        uint64_t busiest = 0;
        int best = 0;
        for (const auto &kv : cellCount)
            if (kv.second > best)
            {
                best = kv.second;
                busiest = kv.first;
            }
        (void)busiest;
        check("res " + std::to_string(r) + " conversions succeeded", errors == 0,
              "errors=" + std::to_string(errors));
        check("res " + std::to_string(r) + " produced distinct cells", !cellCount.empty(),
              "cells=" + std::to_string(cellCount.size()) +
                  " busiest=" + std::to_string(best) + " drivers");
        if (last == 0)
            check("res " + std::to_string(r) + " last cell valid", false);
    }

    // ---- B2: round-trip accuracy
    hdr("B2: cellToLatLng ROUND-TRIP (100,000 CELLS, RES 9)");
    {
        // cellToLatLng returns the cell CENTRE, not the input point, so the
        // distance back to the source is bounded by the res-9 circumradius
        // (~250 m), not by zero. The exact property to assert is idempotence:
        // re-encoding the centre must land in the same cell.
        const int SAMPLES = 100000;
        double worstM = 0, sumM = 0;
        int errors = 0, idempotenceFailures = 0;
        auto t0 = Clock::now();
        for (int i = 0; i < SAMPLES; ++i)
        {
            H3Index cell = 0;
            if (latLngToCell(&pts[i], 9, &cell) != E_SUCCESS)
            {
                errors++;
                continue;
            }
            LatLng back;
            if (cellToLatLng(cell, &back) != E_SUCCESS)
            {
                errors++;
                continue;
            }
            H3Index again = 0;
            if (latLngToCell(&back, 9, &again) != E_SUCCESS || again != cell)
                idempotenceFailures++;

            double errM = haversine(radsToDegs(pts[i].lat), radsToDegs(pts[i].lng),
                                    radsToDegs(back.lat), radsToDegs(back.lng));
            worstM = std::max(worstM, errM);
            sumM += errM;
        }
        double s = secSince(t0);
        std::cout << "  -> " << SAMPLES << " round-trips in " << std::fixed << std::setprecision(2)
                  << s << " s | point->centre mean " << std::setprecision(1) << (sumM / SAMPLES)
                  << " m | worst " << worstM << " m (res-9 circumradius ~250 m)\n";
        check("cell centre re-encodes to the same cell", idempotenceFailures == 0,
              "failures=" + std::to_string(idempotenceFailures));
        check("point-to-centre stays inside the res-9 circumradius", worstM < 250.0,
              "worst=" + std::to_string(worstM) + "m");
        check("no H3 errors during round-trip", errors == 0, "errors=" + std::to_string(errors));
    }

    // ---- B3: neighbourhood expansion
    hdr("B3: gridDisk NEIGHBOUR EXPANSION (50,000 ORIGINS x k=2 = 950,000 CELLS)");
    {
        const int ORIGINS = 50000;
        const int K = 2;
        int64_t maxOut = 0;
        if (maxGridDiskSize(K, &maxOut) != E_SUCCESS)
        {
            check("maxGridDiskSize", false);
            return;
        }
        std::vector<H3Index> out(maxOut);
        int errors = 0;
        int nonEmpty = 0;
        long long total = 0;
        auto t0 = Clock::now();
        for (int i = 0; i < ORIGINS; ++i)
        {
            H3Index cell = 0;
            if (latLngToCell(&pts[i], 9, &cell) != E_SUCCESS)
            {
                errors++;
                continue;
            }
            std::fill(out.begin(), out.end(), 0);
            if (gridDisk(cell, K, out.data()) != E_SUCCESS)
            {
                errors++;
                continue;
            }
            int n = 0;
            for (int64_t j = 0; j < maxOut; ++j)
                if (out[j] != 0)
                    n++;
            if (n > 0)
                nonEmpty++;
            total += n;
        }
        double s = secSince(t0);
        std::cout << "  -> " << ORIGINS << " disks in " << std::fixed << std::setprecision(2) << s
                  << " s (" << std::setprecision(0) << (ORIGINS / s) << " disks/s, "
                  << std::setprecision(0) << (total / s) << " cells/s)\n";
        std::cout << "  -> avg ring-2 neighbourhood size: " << std::setprecision(2)
                  << (double)total / ORIGINS << " cells (expected 19 = 1 + 3k(k+1))\n";
        check("all gridDisk calls succeeded", errors == 0, "errors=" + std::to_string(errors));
        check("every origin produced a neighbourhood", nonEmpty == ORIGINS,
              "nonEmpty=" + std::to_string(nonEmpty));
        check("ring-2 neighbourhood size == 19", total == (long long)ORIGINS * 19,
              "total=" + std::to_string(total));
    }

    // ---- B4: surge aggregation on the full 3M
    hdr("B4: CITY-WIDE SURGE AGGREGATION (3,000,000 POINTS -> RES 8 CELLS)");
    {
        cellCount.clear();
        auto t0 = Clock::now();
        for (int i = 0; i < N; ++i)
        {
            H3Index cell = 0;
            if (latLngToCell(&pts[i], 8, &cell) == E_SUCCESS)
                cellCount[cell]++;
        }
        double s = secSince(t0);
        size_t occupied = cellCount.size();
        int busiest = 0;
        for (const auto &kv : cellCount)
            busiest = std::max(busiest, kv.second);
        std::cout << "  -> " << N << " points aggregated in " << std::fixed << std::setprecision(2)
                  << s << " s (" << std::setprecision(0) << (N / s) << " points/s)\n";
        std::cout << "  -> occupied hexes: " << occupied << " | busiest hex: " << busiest
                  << " drivers | avg " << std::setprecision(1) << ((double)N / occupied) << "/hex\n";
        check("aggregation covers the whole fleet", occupied > 0 && busiest > 0,
              "cells=" + std::to_string(occupied));
        check("hash map held 3M insertions without rehash loss",
              [&] {
                  long long sum = 0;
                  for (const auto &kv : cellCount)
                      sum += kv.second;
                  return sum == N;
              }(),
              "sum check");
    }

    std::cout << "  -> Peak working set: " << peakMemKB() / 1024 << " MB | final "
              << curMemKB() / 1024 << " MB\n";
}

int main()
{
    const int N = 3000000;
    std::ios_base::sync_with_stdio(false);
    std::cout << "======================================================================\n";
    std::cout << "     INSTARIDE 3,000,000-POINT STRESS: C++ QUADTREE vs UBER H3\n";
    std::cout << "======================================================================\n";
    std::cout << "  Fleet: " << N << " points | Peak RSS at start: " << peakMemKB() / 1024 << " MB\n";

    stressQuadtree(N);
    stressH3(N);

    std::cout << "\n======================================================================\n";
    if (g_failures == 0)
        std::cout << "     3M STRESS COMPLETE: ALL CHECKS PASSED\n";
    else
        std::cout << "     3M STRESS COMPLETE: " << g_failures << " CHECK(S) FAILED\n";
    std::cout << "  Peak working set: " << peakMemKB() / 1024 << " MB\n";
    std::cout << "======================================================================\n";
    return g_failures == 0 ? 0 : 1;
}
