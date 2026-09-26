C++ Engine Deep Audit Report
NOTE

Audit covers all 18 files in cpp-engine/: core data structures (Quadtree.hpp, HexGrid.hpp), the IPC bridge (engine_bridge.cpp), FFI C APIs (quadtree_c_api.cpp, hexgrid_c_api.cpp), the TS bridge (src/spatial/cpp_spatial_bridge.ts), and all attack/benchmark files.

## ⚠️ Re-audit Status (2026-09-26)

All **14 findings below are still open** — nothing in `cpp-engine/` has been changed.

**Two exceptions, both added 2026-09-26:**

- **#6 was not theoretical — it was live.** The original claim ("this doesn't currently cause a bug because those commands don't output floats") was wrong: the KNN response itself emits `lat`/`lng` after setting precision, so candidate #1 came back at 2 decimals and candidates #2+ at 1 decimal. `tests/test_cpp_engine_e2e.ts` measured `maxErr = 0.030 deg` (~3.3 km). **Fixed**: each float field now sets its own formatting.
- **#15 (new)**: `Quadtree::update()` permanently dropped a driver on an out-of-bounds telemetry tick. Found by the same e2e suite and **fixed**.

Three statements in this document describe TypeScript-side mitigations that had stopped being true: commit `b37eb89` reverted `SAFE_ID_REGEX` (§5), the TS `tryCollapse()` counterpart to §4, and the parse-error queue guard referenced in §5. All three were **restored** and are now locked by `tests/test_audit_fixes.ts` §8–§9, so a future revert fails the suite.

§5 is now **demonstrably reachable, not theoretical**: the regression test drives `INSERT evil" 12.97 77.59` through the bridge and the C++ side emits `{"id":"evil"",…}` — unparseable JSON. The TS side now absorbs it (queue stays aligned), but the root cause, unescaped ID interpolation in `engine_bridge.cpp`, is still unfixed.

**Newly found, not in the original list:** `CppSpatialBridge.stop()` wrote `QUIT` then killed the child with no `stdin.on("error")` handler. The resulting asynchronous `EPIPE` is an unhandled stream error that **crashes the host Node process**. Fixed alongside the restore.

🔴 Critical / High-Severity Issues
1. engine_bridge.cpp — UPDATE / BATCH_UPDATE Silent Fire-and-Forget Breaks IPC Protocol
File:
engine_bridge.cpp

The Bug: UPDATE (line 72-73) and BATCH_UPDATE (line 88) intentionally produce no JSON response and no flush. The comment says "fire and forget".

Why it's dangerous: The TS bridge's sendCommand() pushes a resolver onto pendingQueue for every command. If UPDATE ever goes through sendCommand() instead of update(), the resolver will never fire — it stays in the queue and causes a permanent 1-off desync: every subsequent response goes to the wrong promise. The current TS code uses a separate stdin.write() path for update() and batchUpdate() which avoids sendCommand, but this is extremely fragile.

WARNING

If anyone adds await this.sendCommand("UPDATE ...") in the future, the entire IPC promise queue permanently desyncs. There's no guard or documentation.

Impact: Queue desync → all future KNN/INSERT/REMOVE responses go to wrong callers → silent data corruption.

2. Quadtree.hpp — O(n) Vector Erase in remove() and update() Slow Path
File:
Quadtree.hpp#L209-L216

cpp

pts.erase(pts.begin() + i);  // O(n) shift of remaining elements
Each remove() does a linear scan + erase() on the leaf's vector, which shifts all remaining elements. At maxDepth with capacity=8, this is fine. But under singularity attack (50,000 points at same coordinate), all points pile into one leaf, making remove() O(n²) in aggregate.

Impact: Remove 50k co-located points → ~1.25 billion element shifts. Acceptable for your attack test (it survived), but could cause latency spikes in production if many drivers cluster at a single hotspot (e.g., airport).

3. HexGrid.hpp — Same O(n) Vector Erase in remove() and update() Slow Path
File:
HexGrid.hpp#L159-L165

Same issue as Quadtree. A single hex cell with thousands of drivers causes O(n) per removal.

4. Quadtree.hpp — Node Memory Only Grows, Never Shrinks (Quadtree Nodes Never Collapse)
File:
Quadtree.hpp#L90-L101

Once subDivide() creates 4 child nodes, they never get reclaimed even when all drivers leave the area. The TS-side quadtree has tryCollapse() (added in our previous audit), but the C++ engine does not.

After a high-churn attack (100k insert+remove cycles), the tree retains all the subdivided nodes as empty husks. In a real deployment where drivers cycle through different areas, this is a slow memory leak of tree structure.

Impact: Monotonically growing tree structure. Won't crash, but memory footprint only ever increases.

5. engine_bridge.cpp — No Input Validation / Command Injection via Malformed IDs
File:
engine_bridge.cpp#L56-L65

The bridge reads IDs directly from stdin via ss >> id. There's no validation of the ID content. While the TS bridge now has SAFE_ID_REGEX, this only guards the TS→C++ path. If anyone sends raw commands to the C++ process stdin (e.g., another process, a test script), crafted IDs containing " or \ could break the JSON output:

INSERT "id_with_"quotes" 12.97 77.59
Produces broken JSON: {"status":"ok","action":"INSERT","id":"id_with_"quotes"","success":true}

Impact: JSON parse error on TS side → queue desync (resolver skipped). This was partially mitigated in the TS bridge audit (catch block now rejects the pending promise), but the root cause is unquoted string interpolation in C++ JSON output.

6. engine_bridge.cpp — std::setprecision Side Effect Persists Across Commands
File:
engine_bridge.cpp#L122-L132

cpp

std::cout << std::fixed << std::setprecision(2) << durationMicroseconds  // sets precision to 2
          << ... << std::setprecision(1) << c.distance << ...            // changes to 1
std::fixed and setprecision are sticky on std::cout. After the first KNN query, all subsequent floating-point output (including INSERT/REMOVE responses echoing id strings, INIT responses) uses std::fixed with whatever precision was last set. This was assessed as harmless because INSERT/REMOVE/INIT echo no floats. That assessment was wrong: the KNN response emits `lat`/`lng` *after* `setprecision(2)` and, for every candidate after the first, after `setprecision(1)` — so coordinates were truncated to 2 then 1 decimal inside a single response. `tests/test_cpp_engine_e2e.ts` E1 measured `maxErr=0.030 deg` (~3.3 km of positional error). Fixed 2026-09-26 by setting the format explicitly per field (`std::defaultfloat` + precision 12 for coordinates).

🟡 Medium-Severity Issues
7. HexGrid.hpp — metersPerLngDeg Becomes Incorrect at Extreme Latitudes
File:
HexGrid.hpp#L111-L112

cpp

metersPerLngDeg = 111412.84 * cos(hexDeg2Rad(centerLat)) - 93.5 * cos(3*...) + 0.118 * cos(5*...);
At equator (~0°): metersPerLngDeg ≈ 111,319m. At 80° latitude: ≈ 19,344m. At 89°: ≈ 1,945m. This is computed once at construction using centerLat. For a city-scale deployment (Bengaluru at ~13°) this is fine. But if someone initializes HexGrid with centerLat=0 but has drivers at lat ±30°, the cell mapping will be significantly distorted.

Impact: Not a bug for your use case, but not a general-purpose solution.

8. quadtree_c_api.cpp / hexgrid_c_api.cpp — KNN Writes Unbounded to Caller's Buffer
File:
quadtree_c_api.cpp#L76-L91

cpp

EXPORT int quadtree_knn(double queryLat, double queryLng, int k, double maxRadiusMeters, CandidateC *outCandidates)
{
    // ... writes up to 'count' entries into outCandidates
    for (int i = 0; i < count; i++) {
        std::strncpy(outCandidates[i].id, ...);
    }
}
The C API trusts that the caller allocated enough CandidateC structs for k results. If the caller passes k=1000000 but allocates only 10 structs → buffer overflow / heap corruption. The FFI layer (koffi) on the TS side does allocate based on k, so it's safe in practice, but the C API itself has no bounds check.

9. Quadtree.hpp — insert() Accepts Empty String IDs and Allows ID Collisions with Re-insert
File:
Quadtree.hpp#L250-L272

cpp

bool insert(const std::string &id, double lat, double lng) {
    if (driverIndex.find(id) != driverIndex.end()) {
        remove(id);  // silently replaces existing
    }
    // ... insert
}
Empty string ID ("") is accepted — this is used in attack2_poisoning.cpp and survives, but it's semantically wrong.
Silent replacement on duplicate ID: no error, no warning. The old point's memory is freed, new one inserted. This is intentional behavior but could hide bugs in the calling layer.
10. Quadtree.hpp — driverIndex Stores Raw Pointer to QuadtreeNode Leaf That Can Become Stale
File:
Quadtree.hpp#L104-L108

cpp

struct DriverRecord {
    Point *point;
    QuadtreeNode *leaf;  // cached leaf pointer
};
The leaf pointer is cached when a driver is inserted. When another driver is inserted into the same leaf and triggers subDivide(), the code correctly updates driverIndex[p->id].leaf = targetLeaf for existing points that get redistributed (line 169). This is correct.

However, if the tree is ever modified to support concurrent access without the C API mutex, this cached pointer pattern is unsafe — a parallel subDivide() could invalidate the pointer between read and use.

Impact: Not a bug today (single-threaded Quadtree + external mutex in C API), but a latent footgun for future refactoring.

11. engine_bridge.cpp — BATCH_UPDATE Parses Unbounded Count from Input
File:
engine_bridge.cpp#L75-L88

cpp

int count = 0;
ss >> count;
for (int i = 0; i < count; i++) {
    if (ss >> id >> lat >> lng) {
        tree->update(id, lat, lng);
    }
}
If a malicious client sends BATCH_UPDATE 2000000000 ... with insufficient trailing data, the loop runs 2 billion times. Each iteration attempts ss >> id >> lat >> lng which will fail immediately after the data runs out, so the loop body is skipped but the loop still iterates — causing a CPU spin of ~2 billion empty iterations.

Impact: Denial-of-service via CPU exhaustion on the C++ bridge process.

🟢 Low-Severity / Cosmetic Issues
12. Typo: EART_RADIUS_METERS → EARTH_RADIUS_METERS
File:
Quadtree.hpp#L40

13. Duplicate Struct Names Across Translation Units
CandidateC and DriverUpdateC are defined in both quadtree_c_api.cpp and hexgrid_c_api.cpp with identical layout. Works fine as separate TUs but would break if someone tries to compile them together.

14. HexGrid.hpp — Unused Variable s_round After Cube Rounding
File:
HexGrid.hpp#L103

s_round = -q_round - r_round; — result is computed but never used. Harmless but triggers compiler warnings.

Newly Found & Fixed (2026-09-26)
15. Quadtree.hpp - update() Permanently Drops a Driver on an Out-of-Bounds Telemetry Tick
File:
Quadtree.hpp (update(), slow path)

The Bug: update() took the slow path whenever the new coordinate left the current leaf, and that path was `remove(id)` followed by `insert(id, ...)`. `insert()` rejects anything outside the root bounds and returns false — so one GPS tick that overshoots the region (the simulator produces these every time a driver bounces off `maxLat`) deleted the driver, and every later in-bounds tick failed because `driverIndex` no longer held the id.

Symptom: the TS index still reported the driver (`updateLocation` rejects out-of-region coordinates) while the C++ mirror silently lost it. `tests/test_cpp_engine_e2e.ts` E4 saw 4 of 80 drivers permanently missing after 12 seconds of normal telemetry.

Fix: bounds-check the new coordinate *before* mutating. An out-of-bounds update now returns false and leaves the driver at its last good position, matching the TS behaviour.

Summary Matrix
#	Severity	File	Issue	Fixable?
1	🔴 High	engine_bridge.cpp	UPDATE/BATCH_UPDATE produce no response — fragile IPC contract	Yes
2	🔴 High	Quadtree.hpp	O(n) erase in leaf vector on remove	Yes (swap-and-pop)
3	🔴 High	HexGrid.hpp	O(n) erase in bucket vector on remove	Yes (swap-and-pop)
4	🔴 High	Quadtree.hpp	Nodes never collapse/reclaim memory	Yes (add tryCollapse)
5	🔴 High	engine_bridge.cpp	Unescaped ID in JSON output → parse error	Yes (escape " and \)
6	🟡 Med	engine_bridge.cpp	setprecision is sticky across commands	**FIXED 2026-09-26** (per-field format)
7	🟡 Med	HexGrid.hpp	metersPerLngDeg fixed at construction	By design
8	🟡 Med	*_c_api.cpp	KNN writes unbounded to caller buffer	Yes (add maxOut param)
9	🟡 Med	Quadtree.hpp	Empty string ID accepted	Yes (add guard)
10	🟡 Med	Quadtree.hpp	Cached leaf pointer is latent footgun	Document
11	🟡 Med	engine_bridge.cpp	BATCH_UPDATE unbounded count → CPU spin	Yes (cap count)
12	🟢 Low	Quadtree.hpp	Typo EART_RADIUS_METERS	Yes
13	🟢 Low	*_c_api.cpp	Duplicate struct names	Yes (shared header)
14	🟢 Low	HexGrid.hpp	Unused s_round variable	Yes
15	🟡 Fixed	Quadtree.hpp	update() drops driver on out-of-bounds tick	Done 2026-09-26
What's Actually Solid ✅
NaN/Inf guards in contains() — properly reject poisoned coordinates
maxDepth cap — prevents infinite recursion under singularity attack
Reader-writer locks in C APIs — shared_mutex correctly separates reads (KNN/size) from writes (insert/update/remove)
driverIndex (O(1) lookup) — both Quadtree and HexGrid have O(1) ID-to-record lookup via unordered_map
Fast-path update — both engines skip tree restructuring when the driver stays in the same leaf/cell (90%+ of GPS updates)
Memory ownership — clear() and destructors properly delete all heap-allocated points
KNN branch-and-bound pruning — correctly prunes nodes whose bounding box is farther than the k-th candidate
