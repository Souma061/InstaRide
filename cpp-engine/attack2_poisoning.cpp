#include "Quadtree.hpp"
#include <iostream>
#include <vector>
#include <string>
#include <limits>
#include <cmath>

int main()
{
    std::cout << "======================================================================\n";
    std::cout << "      ATTACK 2: COORDINATE POISONING & FUZZING TORTURE TEST\n";
    std::cout << "======================================================================\n\n";

    GeoBounds cityBounds = {12.80, 13.20, 77.40, 77.85};
    Quadtree tree(cityBounds, 8, 10);

    // Seed 10 valid drivers first
    for (int i = 0; i < 10; i++)
    {
        tree.insert("valid_drv_" + std::to_string(i), 12.97 + i * 0.01, 77.59 + i * 0.01);
    }
    std::cout << "[Setup] Seeded 10 valid drivers. Initial tree size: " << tree.size() << "\n\n";

    int passed = 0;
    int failed = 0;

    auto testCase = [&](const std::string &name, auto fn)
    {
        std::cout << "[Test] " << name << " ... ";
        try
        {
            fn();
            std::cout << "SURVIVED (Handled gracefully)\n";
            passed++;
        }
        catch (const std::exception &e)
        {
            std::cout << "EXCEPTION: " << e.what() << "\n";
            passed++;
        }
        catch (...)
        {
            std::cout << "CRASH / UNKNOWN ERROR!\n";
            failed++;
        }
    };

    // Vector 1: NaN Latitude Insertion
    testCase("Insert Point with NaN Latitude", [&]()
             {
        double nanVal = std::numeric_limits<double>::quiet_NaN();
        bool ok = tree.insert("poison_nan_lat", nanVal, 77.59);
        if (ok) std::cout << "(Warning: inserted NaN!) "; });

    // Vector 2: Infinity Longitude Insertion
    testCase("Insert Point with +Infinity Longitude", [&]()
             {
        double infVal = std::numeric_limits<double>::infinity();
        bool ok = tree.insert("poison_inf_lng", 12.97, infVal);
        if (ok) std::cout << "(Warning: inserted Inf!) "; });

    // Vector 3: Extreme Latitude > 90 (North Pole Overflow)
    testCase("Insert Point with Lat = 999.0 (OutOfPlanet)", [&]()
             {
        bool ok = tree.insert("poison_space_lat", 999.0, 77.59);
        if (ok) std::cout << "(Warning: inserted out of bounds!) "; });

    // Vector 4: Giant 100,000 Character Driver ID
    testCase("Insert Point with 100,000-character Driver ID", [&]()
             {
        std::string hugeId(100000, 'D');
        bool ok = tree.insert(hugeId, 12.98, 77.60);
        if (ok) {
            tree.remove(hugeId);
        } });

    // Vector 5: Empty String Driver ID
    testCase("Insert Point with Empty String ID (\"\")", [&]()
             {
        bool ok = tree.insert("", 12.98, 77.60);
        if (ok) {
            tree.remove("");
        } });

    // Vector 6: Duplicate ID Conflict with Different Coordinates
    testCase("Insert Duplicate ID at conflicting coordinate", [&]()
             { tree.insert("valid_drv_0", 13.10, 77.70); });

    // Vector 7: Query k-NN with Negative K (k = -10)
    testCase("Query k-NN with Negative k (-10)", [&]()
             { auto res = tree.KNearestNeighBors(12.97, 77.59, -10, 10000.0); });

    // Vector 8: Query k-NN with Giant K (k = 1,000,000)
    testCase("Query k-NN with Giant k (1,000,000)", [&]()
             { auto res = tree.KNearestNeighBors(12.97, 77.59, 1000000, 10000.0); });

    // Vector 9: Query k-NN with NaN Query Latitude
    testCase("Query k-NN with NaN query coordinate", [&]()
             {
        double nanVal = std::numeric_limits<double>::quiet_NaN();
        auto res = tree.KNearestNeighBors(nanVal, 77.59, 5, 10000.0); });

    // Vector 10: Query k-NN with Negative Search Radius (-50000m)
    testCase("Query k-NN with Negative Radius (-50,000m)", [&]()
             { auto res = tree.KNearestNeighBors(12.97, 77.59, 5, -50000.0); });

    // Vector 11: Update Non-Existent Driver ID
    testCase("Update Non-Existent Driver ID (\"ghost_driver\")", [&]()
             { bool ok = tree.update("ghost_driver_does_not_exist", 12.97, 77.59); });

    // Vector 12: Remove Non-Existent Driver ID
    testCase("Remove Non-Existent Driver ID (\"ghost_driver\")", [&]()
             { bool ok = tree.remove("ghost_driver_does_not_exist"); });

    std::cout << "\n----------------------------------------------------------------------\n";
    std::cout << "Attack 2 Summary: " << passed << " Passed, " << failed << " Crashed\n";
    std::cout << "======================================================================\n";

    return failed > 0 ? 1 : 0;
}
