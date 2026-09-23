#pragma once

#include <iostream>
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <queue>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// data structure

struct GeoBounds
{
    double minLat;
    double maxLat;
    double minLng;
    double maxLng;
};

struct Point
{
    std::string id;
    double lat;
    double lng;
};

struct CandidateDriver
{
    std::string id;
    double lat;
    double lng;
    double distance; // in meters
};

const double EART_RADIUS_METERS = 6371000.0; // Earth's radius in meters

inline double degreesToradians(double deg)
{
    return (deg * M_PI) / 180.0;
}
inline double haversineDistance(double lat1, double lng1, double lat2, double lng2)
{
    double dLat = degreesToradians(lat2 - lat1);
    double dLng = degreesToradians(lng2 - lng1);
    double a = std::sin(dLat / 2) * std::sin(dLat / 2) +
               std::cos(degreesToradians(lat1)) * std::cos(degreesToradians(lat2)) *
                   std::sin(dLng / 2) * std::sin(dLng / 2);
    double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1 - a));
    return EART_RADIUS_METERS * c;
}

inline double minDistanceToBox(double lat, double lng, const GeoBounds &bounds)
{
    double closestLat = std::max(bounds.minLat, std::min(lat, bounds.maxLat));
    double closestLng = std::max(bounds.minLng, std::min(lng, bounds.maxLng));
    return haversineDistance(lat, lng, closestLat, closestLng);
}

// quadtree node

class QuadtreeNode
{
public:
    GeoBounds bounds;
    int depth;
    std::vector<Point *> point;
    bool isDivided;

    QuadtreeNode *nw;
    QuadtreeNode *ne;
    QuadtreeNode *sw;
    QuadtreeNode *se;

    QuadtreeNode(GeoBounds b, int d)
        : bounds(b), depth(d), isDivided(false), nw(nullptr), ne(nullptr), sw(nullptr), se(nullptr) {}

    // destructor to free memory
    ~QuadtreeNode()
    {
        delete nw;
        delete ne;
        delete sw;
        delete se;
    }
    void subDivide()
    {
        double midLat = (bounds.minLat + bounds.maxLat) / 2.0;
        double midLng = (bounds.minLng + bounds.maxLng) / 2.0;

        nw = new QuadtreeNode({midLat, bounds.maxLat, bounds.minLng, midLng}, depth + 1);
        ne = new QuadtreeNode({midLat, bounds.maxLat, midLng, bounds.maxLng}, depth + 1);
        sw = new QuadtreeNode({bounds.minLat, midLat, bounds.minLng, midLng}, depth + 1);
        se = new QuadtreeNode({bounds.minLat, midLat, midLng, bounds.maxLng}, depth + 1);
        isDivided = true;
    }
};

// quadtree
struct DriverRecord
{
    Point point;
    QuadtreeNode *leaf;
};

class Quadtree
{
public:
    QuadtreeNode *root;
    int capacity;
    int maxDepth;

private:
    std::unordered_map<std::string, DriverRecord> driverIndex;

    bool contains(const GeoBounds &b, double lat, double lng) const
    {
        return (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng);
    }
    QuadtreeNode *insertChild(QuadtreeNode *node, Point *point)
    {
        double midLat = (node->bounds.minLat + node->bounds.maxLat) / 2.0;
        double midLng = (node->bounds.minLng + node->bounds.maxLng) / 2.0;

        QuadtreeNode *targetChild = nullptr;
        if (point->lat >= midLat)
        {
            targetChild = (point->lng < midLng) ? node->nw : node->ne;
        }
        else
        {
            targetChild = (point->lng < midLng) ? node->sw : node->se;
        }
        return insertNode(targetChild, point); // <-- Pass 'point', not '*point'
    }

    QuadtreeNode *insertNode(QuadtreeNode *node, Point *point) // <-- Change 'const Point &' to 'Point *'
    {
        if (!contains(node->bounds, point->lat, point->lng))
        {
            return nullptr;
        }
        // leafnode: under capacity or at maxdepth limit
        if (!node->isDivided && ((int)node->point.size() < capacity || node->depth >= maxDepth))
        {
            node->point.push_back(point); // <-- Now types match! (Point* into vector<Point*>)
            return node;
        }
        // subdivide if not already divided
        if (!node->isDivided)
        {
            node->subDivide();
            std::vector<Point *> existing = std::move(node->point); // <-- std::vector<Point*>
            node->point.clear();
            for (Point *p : existing)
            {
                // Insert the existing point into the appropriate child node
                QuadtreeNode *targetLeaf = insertChild(node, p);
                if (targetLeaf)
                {
                    driverIndex[p->id].leaf = targetLeaf;
                }
            }
        }
        return insertChild(node, point);
    }

public:
    Quadtree(GeoBounds b, int cap = 8, int maxD = 10) : capacity(cap), maxDepth(maxD)
    {
        root = new QuadtreeNode(b, 0);
    }

    ~Quadtree()
    {
        delete root;
    }

    bool remove(const std::string &id)
    {
        auto itLeaf = driverIndex.find(id);
        if (itLeaf == driverIndex.end() || !itLeaf->second.leaf)
            return false;

        QuadtreeNode *leaf = itLeaf->second.leaf;
        auto &pts = leaf->point;
        for (size_t i = 0; i < pts.size(); ++i)
        {
            if (pts[i]->id == id)
            {
                pts.erase(pts.begin() + i);
                driverIndex.erase(itLeaf);
                return true;
            }
        }
        driverIndex.erase(itLeaf);
        return true;
    }

    bool update(const std::string &id, double lat, double lng)
    {
        auto it = driverIndex.find(id);
        if (it == driverIndex.end() || !it->second.leaf)
        {
            return false;
        }

        // Fast path: still in the same leaf bounding box
        if (contains(it->second.leaf->bounds, lat, lng))
        {
            it->second.point.lat = lat;
            it->second.point.lng = lng;
            return true;
        }

        // Slow path: crossed leaf boundary
        remove(id);
        return insert(id, lat, lng);
    }

    bool insert(const std::string &id, double lat, double lng)
    {
        if (!contains(root->bounds, lat, lng))
        {
            return false;
        }
        Point *newPoint = new Point{id, lat, lng};
        QuadtreeNode *leaf = insertNode(root, newPoint);
        if (leaf)
        {
            driverIndex[id] = {*newPoint, leaf};
            return true;
        }
        else
        {
            delete newPoint; // Clean up if insertion failed
            return false;
        }
    }
    // branch-end-Bound KNN using a Min-priority Queue
    std::vector<CandidateDriver> KNearestNeighBors(double queryLat, double queryLng, int k, double maxSearchRadiusMeters = 50000.0)
    {
        std::vector<CandidateDriver> candidates;

        // priority queue element:holds a node ptr and its min bouunding box doistance
        struct NodeCandidate
        {
            QuadtreeNode *node;
            double minDist;
            // minheap comparetor: smaller distance has higher priority
            bool operator>(const NodeCandidate &other) const
            {
                return minDist > other.minDist;
            }
        };
        std::priority_queue<NodeCandidate, std::vector<NodeCandidate>, std::greater<NodeCandidate>> PQ;

        double rootMinDist = minDistanceToBox(queryLat, queryLng, root->bounds);
        if (rootMinDist <= maxSearchRadiusMeters)
        {
            PQ.push({root, rootMinDist});
        }
        while (!PQ.empty())
        {
            NodeCandidate current = PQ.top();
            PQ.pop();

            // branch and bound pruning:if current node's closest border is farther than the k-th candidate,stop!
            if ((int)candidates.size() == k && current.minDist >= candidates.back().distance)
            {
                break;
            }
            QuadtreeNode *node = current.node;
            // evaluates point inside thios node
            for (const auto *pt : node->point)
            {
                double d = haversineDistance(queryLat, queryLng, pt->lat, pt->lng);
                if (d <= maxSearchRadiusMeters)
                {
                    if ((int)candidates.size() < k || d < candidates.back().distance)
                    {
                        // insert in sorted order
                        CandidateDriver cd{pt->id, pt->lat, pt->lng, d};
                        auto insertPos = std::lower_bound(candidates.begin(), candidates.end(), cd, [](const CandidateDriver &a, const CandidateDriver &b)
                                                          { return a.distance < b.distance; });
                        candidates.insert(insertPos, cd);
                        if ((int)candidates.size() > k)
                        {
                            candidates.pop_back();
                        }
                    }
                }
            }
            // push child quadrants into the priority queue
            if (node->isDivided)
            {
                QuadtreeNode *children[4] = {node->nw, node->ne, node->sw, node->se};
                for (int i = 0; i < 4; i++)
                {
                    QuadtreeNode *child = children[i];
                    if (child)
                    {
                        double dist = minDistanceToBox(queryLat, queryLng, child->bounds);
                        if (dist <= maxSearchRadiusMeters)
                        {
                            if ((int)candidates.size() < k || dist < candidates.back().distance)
                            {
                                PQ.push({child, dist});
                            }
                        }
                    }
                }
            }
        }
        return candidates;
    }
};
