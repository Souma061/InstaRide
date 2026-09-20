import {
  QuadTree,
  type GeoBounds,
  haversineDistance,
} from "../src/spatial/quadtree";

// ============================================================
// Helpers
// ============================================================

function section(title: string): void {
  console.log("\n");
  console.log("=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

function printResult(label: string, value: unknown): void {
  console.log(`\n${label}`);
  console.dir(value, { depth: null });
}

// ============================================================
// TEST AREA
// ============================================================
//
// Small artificial area.
//
// We intentionally use a small geographic region and
// capacity = 2 so that subdivision happens quickly.
//
//                 longitude
//
//          -122.50             -122.40
//             │                    │
//             ┌────────────────────┐
//             │                    │
//             │                    │
//             │       ROOT         │
//             │                    │
//             │                    │
//             └────────────────────┘
//             │                    │
//          latitude
//
// ============================================================

const bounds: GeoBounds = {
  minLat: 37.7,
  maxLat: 37.8,
  minLng: -122.5,
  maxLng: -122.4,
};

// ============================================================
// Create tree
// ============================================================
//
// capacity = 2
//
// This is intentionally smaller than production's 8 so that
// we can easily observe subdivision.
//
// ============================================================

const tree = new QuadTree(
  bounds,
  2, // capacity
  5, // maxDepth
);

// ============================================================
// TEST 1 — Empty tree
// ============================================================

section("TEST 1 — EMPTY TREE");

console.log("Tree size:", tree.size());

console.log("Expected: 0");

// ============================================================
// TEST 2 — Insert first driver
// ============================================================

section("TEST 2 — INSERT FIRST DRIVER");

console.log("Inserting D1...");

const d1 = tree.insert("D1", 37.75, -122.45);

console.log("Insert result:", d1);
console.log("Tree size:", tree.size());

console.log("Expected:", "\n  insert = true", "\n  size   = 1");

// ============================================================
// TEST 3 — Insert second driver
// ============================================================

section("TEST 3 — INSERT SECOND DRIVER");

console.log("Inserting D2...");

const d2 = tree.insert("D2", 37.76, -122.44);

console.log("Insert result:", d2);
console.log("Tree size:", tree.size());

console.log("Expected:", "\n  insert = true", "\n  size   = 2");

console.log("\nAt this point the root should still be a leaf.");

// ============================================================
// TEST 4 — Third driver causes subdivision
// ============================================================

section("TEST 4 — THIRD DRIVER → SUBDIVISION");

console.log("Inserting D3...");

const d3 = tree.insert("D3", 37.74, -122.46);

console.log("Insert result:", d3);
console.log("Tree size:", tree.size());

console.log(
  "\nD3 is the 3rd point.",
  "\nCapacity is only 2.",
  "\nTherefore the root must subdivide.",
);

// ============================================================
// TEST 5 — Insert fourth driver
// ============================================================

section("TEST 5 — INSERT FOURTH DRIVER");

console.log("Inserting D4...");

const d4 = tree.insert("D4", 37.78, -122.43);

console.log("Insert result:", d4);
console.log("Tree size:", tree.size());

console.log("\nExpected size = 4");

// ============================================================
// TEST 6 — Test duplicate insertion
// ============================================================

section("TEST 6 — INSERT EXISTING DRIVER ID");

console.log("Updating D1 using insert()...");

const duplicate = tree.insert("D1", 37.751, -122.451);

console.log("Result:", duplicate);

console.log("Tree size:", tree.size());

console.log(
  "\nBecause insert() removes an existing ID first,",
  "\nsize should remain 4.",
);

// ============================================================
// TEST 7 — Update inside same leaf
// ============================================================

section("TEST 7 — UPDATE INSIDE SAME LEAF");

console.log("Moving D2 slightly...");

const updateSameLeaf = tree.update("D2", 37.7601, -122.4401);

console.log("Update result:", updateSameLeaf);

console.log(
  "\nThis should use the fast path:",
  "\n",
  "driverMap.get(D2)",
  "\n       ↓",
  "\n  driverLeaves.get(D2)",
  "\n       ↓",
  "\n  contains(newPosition)",
  "\n       ↓",
  "\n  mutate Point",
);

console.log("\nNo remove() + insert() should happen.");

// ============================================================
// TEST 8 — Update across leaf boundary
// ============================================================

section("TEST 8 — UPDATE ACROSS LEAF BOUNDARY");

console.log("Moving D2 to a completely different area...");

const updateDifferentLeaf = tree.update("D2", 37.71, -122.49);

console.log("Update result:", updateDifferentLeaf);

console.log(
  "\nThis should use the slow path:",
  "\n",
  "old leaf",
  "\n    ↓",
  "\n remove D2",
  "\n    ↓",
  "\n insert D2 into new leaf",
);

console.log("\nTree size:", tree.size());

console.log("Expected size = 4");

// ============================================================
// TEST 9 — Update unknown driver
// ============================================================

section("TEST 9 — UPDATE UNKNOWN DRIVER");

const unknownUpdate = tree.update("UNKNOWN", 37.75, -122.45);

console.log("Result:", unknownUpdate);

console.log("Expected: false");

// ============================================================
// TEST 10 — Remove driver
// ============================================================

section("TEST 10 — REMOVE DRIVER");

console.log("Removing D3...");

const removed = tree.remove("D3");

console.log("Remove result:", removed);

console.log("Tree size:", tree.size());

console.log("Expected:", "\n  remove = true", "\n  size   = 3");

// ============================================================
// TEST 11 — Remove same driver again
// ============================================================

section("TEST 11 — REMOVE SAME DRIVER AGAIN");

const removedAgain = tree.remove("D3");

console.log("Result:", removedAgain);

console.log("Expected: false");

// ============================================================
// TEST 12 — kNN
// ============================================================

section("TEST 12 — K NEAREST NEIGHBORS");

const queryLat = 37.75;
const queryLng = -122.45;

console.log("Query point:", queryLat, queryLng);

console.log("Searching for 2 nearest drivers...");

const nearest = tree.kNearestNeighbors(queryLat, queryLng, 2, 10000);

printResult("Nearest drivers:", nearest);

// ============================================================
// TEST 13 — Verify sorted order
// ============================================================

section("TEST 13 — VERIFY KNN SORT ORDER");

let sorted = true;

for (let i = 1; i < nearest.length; i++) {
  if (nearest[i].distance < nearest[i - 1].distance) {
    sorted = false;
  }
}

console.log("Sorted:", sorted);

console.log("Expected: true");

// ============================================================
// TEST 14 — Verify distances independently
// ============================================================

section("TEST 14 — VERIFY HAVERSINE DISTANCES");

for (const driver of nearest) {
  const independentDistance = haversineDistance(
    queryLat,
    queryLng,
    driver.lat,
    driver.lng,
  );

  console.log(`\n${driver.id}`);

  console.log("Tree distance:", driver.distance);

  console.log("Independent:", independentDistance);

  console.log("Difference:", Math.abs(driver.distance - independentDistance));
}

// ============================================================
// TEST 15 — k = 1
// ============================================================

section("TEST 15 — K = 1");

const nearestOne = tree.kNearestNeighbors(queryLat, queryLng, 1, 10000);

printResult("Nearest single driver:", nearestOne);

// ============================================================
// TEST 16 — k larger than number of drivers
// ============================================================

section("TEST 16 — K LARGER THAN DRIVER COUNT");

const nearestMany = tree.kNearestNeighbors(queryLat, queryLng, 100, 10000);

console.log("Requested k = 100");

console.log("Returned:", nearestMany.length);

console.log("Current tree size:", tree.size());

console.log("Expected returned <= tree size");

// ============================================================
// TEST 17 — max radius
// ============================================================

section("TEST 17 — MAX RADIUS");

const nearby = tree.kNearestNeighbors(
  queryLat,
  queryLng,
  10,
  100, // only 100 meters
);

printResult("Drivers within 100m:", nearby);

console.log("\nEvery returned driver should have", "\ndistance <= 100m");

// ============================================================
// TEST 18 — Empty result using tiny radius
// ============================================================

section("TEST 18 — NO DRIVER WITHIN RADIUS");

const none = tree.kNearestNeighbors(
  37.799,
  -122.499,
  4,
  1, // 1 meter
);

console.log("Result:", none);

console.log("Expected: []");

// ============================================================
// FINAL
// ============================================================

section("FINAL TREE STATE");

console.log("Total drivers:", tree.size());

console.log("\nAll dry-run tests completed.");
