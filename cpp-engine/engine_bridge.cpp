#include "Quadtree.hpp"
#include <iostream>
#include <string>
#include <sstream>
#include <vector>
#include <chrono>
#include <memory>
#include <iomanip>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

int main()
{
    // Disable synchronization with C stdio streams for maximum throughput
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(NULL);

    // Default Bounding Box (Bengaluru)
    GeoBounds defaultBounds{12.86, 13.06, 77.50, 77.72};
    std::unique_ptr<Quadtree> tree(new Quadtree(defaultBounds, 8, 10));

    std::string line;
    // Main IPC command loop: process commands line-by-line from stdin
    while (std::getline(std::cin, line))
    {
        if (line.empty())
            continue;

        std::stringstream ss(line);
        std::string cmd;
        ss >> cmd;

        if (cmd == "PING")
        {
            std::cout << "{\"status\":\"ok\",\"msg\":\"PONG\"}\n"
                      << std::flush;
        }
        else if (cmd == "INIT")
        {
            // INIT minLat maxLat minLng maxLng capacity maxDepth
            double minLat, maxLat, minLng, maxLng;
            int capacity = 8, maxDepth = 10;
            ss >> minLat >> maxLat >> minLng >> maxLng;
            if (ss >> capacity)
            {
                ss >> maxDepth;
            }
            GeoBounds bounds{minLat, maxLat, minLng, maxLng};
            tree.reset(new Quadtree(bounds, capacity, maxDepth));
            std::cout << "{\"status\":\"ok\",\"action\":\"INIT\"}\n"
                      << std::flush;
        }
        else if (cmd == "INSERT")
        {
            // INSERT id lat lng
            std::string id;
            double lat, lng;
            ss >> id >> lat >> lng;
            bool ok = tree->insert(id, lat, lng);
            std::cout << "{\"status\":\"ok\",\"action\":\"INSERT\",\"id\":\"" << id
                      << "\",\"success\":" << (ok ? "true" : "false") << "}\n"
                      << std::flush;
        }
        else if (cmd == "UPDATE")
        {
            std::string id;
            double lat, lng;
            ss >> id >> lat >> lng;
            tree->update(id, lat, lng);
            // fire and forget, no need to return success/failure for update, no std flush
        }
        else if (cmd == "BATCH_UPDATE")
        {
            int count = 0;
            ss >> count;
            double lat, lng;
            std::string id;
            for (int i = 0; i < count; i++)
            {
                if (ss >> id >> lat >> lng)
                {
                    tree->update(id, lat, lng);
                }
            }
        } // fire and forgetr. No json and no std::flush here.
        else if (cmd == "REMOVE")
        {
            // REMOVE id
            std::string id;
            ss >> id;
            bool ok = tree->remove(id);
            std::cout << "{\"status\":\"ok\",\"action\":\"REMOVE\",\"id\":\"" << id
                      << "\",\"success\":" << (ok ? "true" : "false") << "}\n"
                      << std::flush;
        }
        else if (cmd == "KNN")
        {
            // KNN queryLat queryLng k maxRadiusMeters
            double qLat, qLng;
            int k = 5;
            double maxRadius = 50000.0;
            ss >> qLat >> qLng >> k >> maxRadius;

#ifdef _WIN32
            LARGE_INTEGER freq, tStart, tEnd;
            QueryPerformanceFrequency(&freq);
            QueryPerformanceCounter(&tStart);
            auto results = tree->KNearestNeighBors(qLat, qLng, k, maxRadius);
            QueryPerformanceCounter(&tEnd);
            double durationMicroseconds = (double)(tEnd.QuadPart - tStart.QuadPart) * 1000000.0 / (double)freq.QuadPart;
#else
            auto t0 = std::chrono::high_resolution_clock::now();
            auto results = tree->KNearestNeighBors(qLat, qLng, k, maxRadius);
            auto t1 = std::chrono::high_resolution_clock::now();
            double durationMicroseconds = std::chrono::duration<double, std::micro>(t1 - t0).count();
#endif

            // Format candidate matches as JSON
            std::cout << "{\"status\":\"ok\",\"action\":\"KNN\",\"latencyUs\":"
                      << std::fixed << std::setprecision(2) << durationMicroseconds
                      << ",\"count\":" << results.size() << ",\"candidates\":[";

            for (size_t i = 0; i < results.size(); ++i)
            {
                const auto &c = results[i];
                if (i > 0)
                    std::cout << ",";
                std::cout << "{\"id\":\"" << c.id << "\",\"lat\":" << c.lat
                          << ",\"lng\":" << c.lng << ",\"distance\":" << std::setprecision(1) << c.distance << "}";
            }
            std::cout << "]}\n"
                      << std::flush;
        }
        else if (cmd == "QUIT" || cmd == "EXIT")
        {
            std::cout << "{\"status\":\"ok\",\"msg\":\"BYE\"}\n"
                      << std::flush;
            break;
        }
        else
        {
            std::cout << "{\"status\":\"error\",\"error\":\"UNKNOWN_COMMAND\"}\n"
                      << std::flush;
        }
    }

    return 0;
}
