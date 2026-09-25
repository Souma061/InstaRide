#include "Quadtree.hpp"
#include <cstring>
#include <memory>
#include <mutex>
#include <shared_mutex>

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

// Fast fixed-size C structs for direct zero-copy memory exchange
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

static std::unique_ptr<Quadtree> g_tree = nullptr;
static std::shared_mutex g_tree_mutex;

extern "C"
{

    EXPORT void quadtree_init(double minLat, double maxLat, double minLng, double maxLng, int capacity, int maxDepth)
    {
        std::unique_lock<std::shared_mutex> lock(g_tree_mutex);
        GeoBounds bounds = {minLat, maxLat, minLng, maxLng};
        g_tree = std::unique_ptr<Quadtree>(new Quadtree(bounds, capacity, maxDepth));
    }

    EXPORT bool quadtree_insert(const char *id, double lat, double lng)
    {
        std::unique_lock<std::shared_mutex> lock(g_tree_mutex);
        if (!g_tree || !id)
            return false;
        return g_tree->insert(std::string(id), lat, lng);
    }

    EXPORT bool quadtree_update(const char *id, double lat, double lng)
    {
        std::unique_lock<std::shared_mutex> lock(g_tree_mutex);
        if (!g_tree || !id)
            return false;
        return g_tree->update(std::string(id), lat, lng);
    }

    EXPORT bool quadtree_remove(const char *id)
    {
        std::unique_lock<std::shared_mutex> lock(g_tree_mutex);
        if (!g_tree || !id)
            return false;
        return g_tree->remove(std::string(id));
    }

    EXPORT int quadtree_size()
    {
        std::shared_lock<std::shared_mutex> lock(g_tree_mutex);
        if (!g_tree)
            return 0;
        return (int)g_tree->size();
    }

    EXPORT int quadtree_knn(double queryLat, double queryLng, int k, double maxRadiusMeters, CandidateC *outCandidates)
    {
        std::shared_lock<std::shared_mutex> lock(g_tree_mutex);
        if (!g_tree || !outCandidates || k <= 0)
            return 0;
        std::vector<CandidateDriver> found = g_tree->KNearestNeighBors(queryLat, queryLng, k, maxRadiusMeters);
        int count = (int)found.size();
        for (int i = 0; i < count; i++)
        {
            std::strncpy(outCandidates[i].id, found[i].id.c_str(), 63);
            outCandidates[i].id[63] = '\0';
            outCandidates[i].lat = found[i].lat;
            outCandidates[i].lng = found[i].lng;
            outCandidates[i].distance = found[i].distance;
        }
        return count;
    }

    EXPORT int quadtree_batch_update(int count, const DriverUpdateC *updates)
    {
        std::unique_lock<std::shared_mutex> lock(g_tree_mutex);
        if (!g_tree || !updates || count <= 0)
            return 0;
        int success = 0;
        for (int i = 0; i < count; i++)
        {
            if (g_tree->update(std::string(updates[i].id), updates[i].lat, updates[i].lng))
            {
                success++;
            }
        }
        return success;
    }
}
