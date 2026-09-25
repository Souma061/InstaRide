#include "HexGrid.hpp"
#include <cstring>
#include <memory>
#include <shared_mutex>
#include <mutex>

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

#pragma pack(push, 1)
struct CandidateC
{
    char id[64];
    double lat;
    double lng;
    double distance;
};

struct DriverUpdateC
{
    char id[64];
    double lat;
    double lng;
};
#pragma pack(pop)

static std::unique_ptr<HexGrid> g_hexGrid = nullptr;
static std::shared_mutex g_hexgrid_mutex; // reader-writer lock for thread safety

extern "C"
{
    // writer lock:exclusive
    EXPORT void hexgrid_init(double centerLat, double centerLng, double hexRadiusMeters)
    {
        std::unique_lock<std::shared_mutex> lock(g_hexgrid_mutex);
        g_hexGrid = std::unique_ptr<HexGrid>(new HexGrid(centerLat, centerLng, hexRadiusMeters));
    }
    EXPORT bool hexgrid_insert(const char *id, double lat, double lng)
    {
        std::unique_lock<std::shared_mutex> lock(g_hexgrid_mutex);
        if (!g_hexGrid || !id)
        {
            return false;
        }
        return g_hexGrid->insert(std::string(id), lat, lng);
    }
    // writer lock:exclusive(fast path:90% of updates stay in the same hex cell)
    EXPORT bool hexgrid_update(const char *id, double lat, double lng)
    {
        std::unique_lock<std::shared_mutex> lock(g_hexgrid_mutex);
        if (!g_hexGrid || !id)
        {
            return false;
        }
        return g_hexGrid->update(std::string(id), lat, lng);
    }
    // write lock:exclusive
    EXPORT bool hexgrid_remove(const char *id)
    {
        std::unique_lock<std::shared_mutex> lock(g_hexgrid_mutex);
        if (!g_hexGrid || !id)
        {
            return false;
        }
        return g_hexGrid->remove(std::string(id));
    }
    // read lock:shared
    EXPORT int hexgrid_size()
    {
        std::shared_lock<std::shared_mutex> lock(g_hexgrid_mutex);
        if (!g_hexGrid)
        {
            return 0;
        }
        return (int)g_hexGrid->size();
    }
    // read lock:shared
    EXPORT int hexgrid_knn(double queryLat, double queryLng, int k, double maxRadiusMeters, CandidateC *outCandidates)
    {
        std::shared_lock<std::shared_mutex> lock(g_hexgrid_mutex);
        if (!g_hexGrid || !outCandidates || k <= 0)
        {
            return 0;
        }
        std::vector<HexCandidateDriver> found = g_hexGrid->KNearestNeighbours(queryLat, queryLng, k, maxRadiusMeters);
        int count = (int)found.size();
        for (int i = 0; i < count; i++)
        {
            std::strncpy(outCandidates[i].id, found[i].id.c_str(), 63);
            outCandidates[i].id[63] = '\0'; // ensure null termination
            outCandidates[i].lat = found[i].lat;
            outCandidates[i].lng = found[i].lng;
            outCandidates[i].distance = found[i].distance;
        }
        return count;
    }
    // write lock:exclusive accross telemetry batch update
    EXPORT int hexgrid_batch_update(int count, const DriverUpdateC *updates)
    {
        std::unique_lock<std::shared_mutex> lock(g_hexgrid_mutex);
        if (!g_hexGrid || !updates || count <= 0)
        {
            return 0;
        }
        int success = 0;
        for (int i = 0; i < count; i++)
        {
            if (g_hexGrid->update(std::string(updates[i].id), updates[i].lat, updates[i].lng))
            {
                success++;
            }
            else if (g_hexGrid->insert(std::string(updates[i].id), updates[i].lat, updates[i].lng))
            {
                success++;
            }
        }
        return success;
    }
}
