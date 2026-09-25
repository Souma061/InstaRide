#pragma once

#include <iostream>
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <cstdint>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// data structures and geostatic math

struct HexCandidateDriver
{
    std::string id;
    double lat;
    double lng;
    double distance; // in meters
};

const double HEX_EARTH_RADIUS = 6371000.0; // in meters
inline double hexDeg2Rad(double deg)
{
    return (deg * M_PI) / 180.0;
}

inline double hexHaversine(double lat1, double lng1, double lat2, double lng2)
{
    double dLat = hexDeg2Rad(lat2 - lat1);
    double dLng = hexDeg2Rad(lng2 - lng1);
    double a = std::sin(dLat / 2) * std::sin(dLat / 2) +
               std::cos(hexDeg2Rad(lat1)) * std::cos(hexDeg2Rad(lat2)) *
                   std::sin(dLng / 2) * std::sin(dLng / 2);
    double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1 - a));
    return HEX_EARTH_RADIUS * c;
}

// driver record stored in meomoy
struct HexDriverRecord
{
    std::string id;
    double lat;
    double lng;
    uint64_t cellId;
};

// core hexgrod engine class

class HexGrid
{
private:
    double centerLat;
    double centerLng;
    double hexRadiusMeters;
    double metersPerLatDeg;
    double metersPerLngDeg;

    // fast storage:64 bit cell id -> list of driver records
    std::unordered_map<uint64_t, std::vector<HexDriverRecord *>> hexBuckets;
    std::unordered_map<std::string, HexDriverRecord *> driverIndex;
    static inline uint64_t packCellId(int32_t q, int32_t r)
    {
        return ((uint64_t)(uint32_t)q << 32) | (uint32_t)r;
    }
    static inline void unpackCellId(uint64_t cellId, int32_t &q, int32_t &r)
    {
        q = (int32_t)(cellId >> 32);
        r = (int32_t)(cellId & 0xFFFFFFFF);
    }
    // convert lat/lng to cartessian coordinates in meters relative to center
    inline void latLngToMeters(double lat, double lng, double &x, double &y)
    {
        y = (lat - centerLat) * metersPerLatDeg;
        x = (lng - centerLng) * metersPerLngDeg;
    }
    // 10 line cube rounding: convert continuous (x,y) meters into exact hex cell coordinates (q,r)
    uint64_t pointToCell(double x, double y) const
    {
        // pointy-top hex geometry
        double q_frac = (std::sqrt(3.0) / 3.0 * x - (1.0 / 3.0) * y) / hexRadiusMeters;
        double r_frac = (2.0 / 3.0 * y) / hexRadiusMeters;
        double s_frac = -q_frac - r_frac;
        int32_t q_round = static_cast<int32_t>(std::round(q_frac));
        int32_t r_round = static_cast<int32_t>(std::round(r_frac));
        int32_t s_round = static_cast<int32_t>(std::round(s_frac));
        double q_diff = std::abs(q_round - q_frac);
        double r_diff = std::abs(r_round - r_frac);
        double s_diff = std::abs(s_round - s_frac);
        if (q_diff > r_diff && q_diff > s_diff)
        {
            q_round = -r_round - s_round;
        }
        else if (r_diff > s_diff)
        {
            r_round = -q_round - s_round;
        }
        else
        {
            s_round = -q_round - r_round;
        }
        return packCellId(q_round, r_round);
    }

public:
    HexGrid(double cLat, double cLng, double radiusMeters = 460.0) : centerLat(cLat), centerLng(cLng), hexRadiusMeters(radiusMeters)
    {
        metersPerLatDeg = 111132.92 - 559.82 * std::cos(2 * hexDeg2Rad(centerLat)) + 1.175 * std::cos(4 * hexDeg2Rad(centerLat));
        metersPerLngDeg = 111412.84 * std::cos(hexDeg2Rad(centerLat)) - 93.5 * std::cos(3 * hexDeg2Rad(centerLat)) + 0.118 * std::cos(5 * hexDeg2Rad(centerLat));
    }
    ~HexGrid()
    {
        clear();
    }
    void clear()
    {
        for (auto &pair : driverIndex)
        {
            delete pair.second;
        }
        driverIndex.clear();
        hexBuckets.clear();
    }
    size_t size() const
    {
        return driverIndex.size();
    }
    uint64_t latLngToCell(double lat, double lng)
    {
        double x, y;
        latLngToMeters(lat, lng, x, y);
        return pointToCell(x, y);
    }
    // insert driver
    bool insert(const std::string &id, double lat, double lng)
    {
        if (driverIndex.find(id) != driverIndex.end())
        {
            remove(id);
        }
        uint64_t cellId = latLngToCell(lat, lng);
        HexDriverRecord *record = new HexDriverRecord{id, lat, lng, cellId};
        driverIndex[id] = record;
        hexBuckets[cellId].push_back(record);
        return true;
    }
    bool remove(const std::string &id)
    {
        auto it = driverIndex.find(id);
        if (it == driverIndex.end())
        {
            return false;
        }
        HexDriverRecord *record = it->second;
        auto &bucket = hexBuckets[record->cellId];
        for (size_t i = 0; i < bucket.size(); i++)
        {
            if (bucket[i]->id == id)
            {
                bucket.erase(bucket.begin() + i);
                break;
            }
        }
        delete record;
        driverIndex.erase(it);
        return true;
    }
    // fast path in=hex update: 90% telemetry updates stay in the same hex cell, so we can just update the lat/lng and return
    bool update(const std::string &id, double lat, double lng)
    {
        auto it = driverIndex.find(id);
        if (it == driverIndex.end())
        {
            return false;
        }
        HexDriverRecord *record = it->second;
        uint64_t newCellId = latLngToCell(lat, lng);
        // fast path:same hexagon (5ns,zero allocation)
        if (newCellId == record->cellId)
        {
            record->lat = lat;
            record->lng = lng;
            return true;
        }
        // slow path:crossed hexagon boundary (100ns,1 allocation)
        auto &oldBucket = hexBuckets[record->cellId];
        for (size_t i = 0; i < oldBucket.size(); i++)
        {
            if (oldBucket[i]->id == id)
            {
                oldBucket.erase(oldBucket.begin() + i);
                break;
            }
        }
        record->lat = lat;
        record->lng = lng;
        record->cellId = newCellId;
        hexBuckets[newCellId].push_back(record);
        return true;
    }
    // concentric ring k-nn query with early mathematical pruning: returns a list of driver candidates sorted by distance
    std::vector<HexCandidateDriver> KNearestNeighbours(double queryLat, double queryLng, int k, double maxRadiusMeters = 25000.0)
    {
        std::vector<HexCandidateDriver> candidate;
        if (k <= 0 || maxRadiusMeters <= 0.0)
        {
            return candidate;
        }
        uint64_t centerCell = latLngToCell(queryLat, queryLng);
        int32_t cq, cr;
        unpackCellId(centerCell, cq, cr);

        // 6 axial direction of a hexagon
        const int32_t directions[6][2] = {
            {1, 0}, {1, -1}, {0, -1}, {-1, 0}, {-1, 1}, {0, 1}};
        double hexWidth = std::sqrt(3.0) * hexRadiusMeters;
        int maxRings = (int)std::ceil(maxRadiusMeters / hexWidth) + 1;
        for (int ring = 0; ring <= maxRings; ++ring)
        {
            // early mathematical prune:
            // if the inner edge of the next ring is already darther than our worst k-th candidate, break immediately
            if ((int)candidate.size() >= k)
            {
                double minRingDist = (ring > 0) ? (ring - 0.5) * hexWidth : 0.0;
                if (minRingDist >= candidate.back().distance)
                {
                    break;
                }
            }
            std::vector<uint64_t> ringCells;
            if (ring == 0)
            {
                ringCells.push_back(centerCell);
            }
            else
            {
                // traverse the 6 sides of the hexagonal ring of radius 'ring'
                int32_t curQ = cq + directions[4][0] * ring;
                int32_t curR = cr + directions[4][1] * ring;

                for (int side = 0; side < 6; ++side)
                {
                    for (int step = 0; step < ring; ++step)
                    {
                        ringCells.push_back(packCellId(curQ, curR));
                        curQ += directions[side][0];
                        curR += directions[side][1];
                    }
                }
            }
            // inspect drivers in these ring buckets
            for (uint64_t cellId : ringCells)
            {
                auto itBucket = hexBuckets.find(cellId);
                if (itBucket == hexBuckets.end() || itBucket->second.empty())
                {
                    continue;
                }
                for (const auto *driver : itBucket->second)
                {
                    double d = hexHaversine(queryLat, queryLng, driver->lat, driver->lng);
                    if (d <= maxRadiusMeters)
                    {
                        if ((int)candidate.size() < k || d < candidate.back().distance)
                        {
                            HexCandidateDriver cd{driver->id, driver->lat, driver->lng, d};
                            auto insertPos = std::lower_bound(candidate.begin(), candidate.end(), cd, [](const HexCandidateDriver &a, const HexCandidateDriver &b)
                                                              { return a.distance < b.distance; });
                            candidate.insert(insertPos, cd);
                            if ((int)candidate.size() > k)
                            {
                                candidate.pop_back();
                            }
                        }
                    }
                }
            }
        }
        return candidate;
    }
};
