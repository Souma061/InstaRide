import { CppSpatialBridge } from "../src/spatial/cpp_spatial_bridge.js";
import { DriverRegistry } from "../src/core/driver_registry.js";
import { TripStateMachine } from "../src/core/trip_state_machine.js";
import { DriverSimulator } from "../src/simulation/driver_simulator.js";
import { QuadTree } from "../src/spatial/quadtree.js";
import { GeoBounds } from "../src/spatial/quadtree.js";

const BOUNDS: GeoBounds = { minLat: 12.86, maxLat: 13.06, minLng: 77.5, maxLng: 77.72 };

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=================================================================");
  console.log("  C++ ENGINE END-TO-END VERIFICATION (no code changes)");
  console.log("=================================================================\n");

  const bridge = new CppSpatialBridge();
  if (!(await bridge.start())) {
    console.error("Cannot start C++ bridge");
    process.exit(1);
  }
  await bridge.initRegion(BOUNDS, 8, 7);

  // ---------------------------------------------------------------- E1
  console.log("[E1] KNN coordinate fidelity through Node -> engine_bridge.exe");
  const truth: Record<string, { lat: number; lng: number }> = {
    e1_a: { lat: 12.9717123, lng: 77.5945678 },
    e1_b: { lat: 12.9750987, lng: 77.6001234 },
    e1_c: { lat: 12.9800456, lng: 77.6100789 },
    e1_d: { lat: 12.9900321, lng: 77.6200654 },
    e1_e: { lat: 13.0000111, lng: 77.6300999 },
  };
  for (const [id, p] of Object.entries(truth)) await bridge.insert(id, p.lat, p.lng);
  const e1 = await bridge.kNearestNeighbors(12.9717123, 77.5945678, 5, 50000);
  let maxErr = 0;
  for (const c of e1.candidates) {
    const t = truth[c.id];
    if (!t) continue;
    maxErr = Math.max(maxErr, Math.abs(c.lat - t.lat), Math.abs(c.lng - t.lng));
  }
  const errMeters = maxErr * 111320;
  check(
    "returned lat/lng match inserted lat/lng",
    e1.candidates.length === 5 && maxErr < 1e-6,
    `count=${e1.candidates.length} maxErr=${maxErr.toFixed(6)}deg (~${errMeters.toFixed(0)} m)`,
  );
  for (const c of e1.candidates) {
    const t = truth[c.id];
    if (t) console.log(`        ${c.id}: got ${c.lat},${c.lng}  want ${t.lat},${t.lng}`);
  }

  // ---------------------------------------------------------------- E2
  console.log("\n[E2] Out-of-bounds telemetry -> does the driver survive?");
  const tsTree = new QuadTree(BOUNDS, 8, 7);
  const registry = new DriverRegistry(tsTree);
  registry.registerDriver("e2_d", 13.05, 77.7, "available");
  await bridge.insert("e2_d", 13.05, 77.7);

  // exact overshoot the simulator produces when bouncing at maxLat
  const overshoot = { lat: BOUNDS.maxLat + 0.0001, lng: 77.7 };
  bridge.batchUpdate([{ id: "e2_d", lat: overshoot.lat, lng: overshoot.lng }]);
  const tsAfterOob = registry.updateLocation("e2_d", overshoot.lat, overshoot.lng);
  await sleep(50);
  // next tick the driver is back inside the region
  bridge.batchUpdate([{ id: "e2_d", lat: 13.051, lng: 77.701 }]);
  registry.updateLocation("e2_d", 13.051, 77.701);
  await sleep(50);
  const e2 = await bridge.kNearestNeighbors(13.05, 77.7, 10, 1e7);
  const cppHasDriver = e2.candidates.some((c) => c.id === "e2_d");
  check("TS registry still indexes driver after OOB tick", tsTree.size() === 1, `tsSize=${tsTree.size()} registryUpdate=${tsAfterOob}`);
  check(
    "C++ engine still indexes driver after OOB tick + recovery tick",
    cppHasDriver,
    `cppCandidates=${e2.candidates.map((c) => c.id).join(",") || "(none)"}`,
  );

  // ---------------------------------------------------------------- E3
  console.log("\n[E3] FR10 'available-only index' invariant on the C++ mirror");
  registry.registerDriver("e3_d", 12.95, 77.6, "available");
  await bridge.insert("e3_d", 12.95, 77.6);
  await registry.acquireLock("e3_d", "req_e3", 15000); // TS index must drop it
  const e3 = await bridge.kNearestNeighbors(12.95, 77.6, 10, 1e7);
  const cppStillHasLocked = e3.candidates.some((c) => c.id === "e3_d");
  check("TS tree honours available-only (driver removed on lock)", !tsTree.kNearestNeighbors(12.95, 77.6, 10, 1e7).some((c) => c.id === "e3_d"));
  check("C++ tree honours available-only (driver removed on lock)", !cppStillHasLocked, cppStillHasLocked ? "locked driver still returned by C++ kNN" : "");

  // ---------------------------------------------------------------- E4
  console.log("\n[E4] Real DriverSimulator -> cpp mirror divergence over 12s");
  const bounds = BOUNDS;
  const tree2 = new QuadTree(bounds, 8, 7);
  const reg2 = new DriverRegistry(tree2);
  const sim = new DriverSimulator(bounds, reg2, new TripStateMachine());
  const mirror = new CppSpatialBridge();
  if (!(await mirror.start())) {
    console.error("Cannot start second bridge");
    process.exit(1);
  }
  await mirror.initRegion(bounds, 8, 7);

  sim.start(80, 100);
  for (const d of sim.getAllVirtualDrivers()) await mirror.insert(d.id, d.lat, d.lng);

  let oobTicks = 0;
  const oobIds = new Set<string>();
  sim.onTelemetryTick = (updates) => {
    for (const u of updates) {
      if (u.lat < bounds.minLat || u.lat > bounds.maxLat || u.lng < bounds.minLng || u.lng > bounds.maxLng) {
        oobTicks++;
        oobIds.add(u.id);
      }
    }
    mirror.batchUpdate(updates);
  };

  await sleep(12000);
  sim.stop();

  const all = await mirror.kNearestNeighbors((bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2, 500, 1e7);
  const cppIds = new Set(all.candidates.map((c) => c.id));
  const tsIds = new Set(
    tree2.kNearestNeighbors((bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2, 500, 1e7).map((c) => c.id),
  );
  const lost = [...tsIds].filter((id) => !cppIds.has(id));
  console.log(`        simulator drivers=${sim.getAllVirtualDrivers().length} tsIndexed=${tsIds.size} cppIndexed=${cppIds.size}`);
  console.log(`        out-of-bounds telemetry ticks=${oobTicks} driversAffected=${[...oobIds].join(",") || "none"}`);
  console.log(`        drivers indexed in TS but missing from C++: ${lost.join(",") || "none"}`);
  check(
    "C++ mirror stays in sync with TS index under normal telemetry",
    lost.length === 0,
    lost.length ? `${lost.length} driver(s) permanently lost: ${lost.slice(0, 5).join(",")}` : "",
  );
  mirror.stop();

  // ---------------------------------------------------------------- E5
  console.log("\n[E5] Reachability of Quadtree::clear() (UAF) through the shipped system");
  const bridgeSource = await import("node:fs").then((fs) =>
    fs.readFileSync("cpp-engine/engine_bridge.cpp", "utf8"),
  );
  const hasClearCmd = /cmd == "CLEAR"/.test(bridgeSource);
  const bridgeUsesClear = /\bclear\(\)/.test(bridgeSource);
  const srcFiles = await (async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|cpp|hpp)$/.test(e.name)) out.push(p);
      }
    };
    walk("src");
    walk("cpp-engine");
    return out;
  })();
  const callers: string[] = [];
  for (const f of srcFiles) {
    if (f.endsWith("Quadtree.hpp")) continue; // skip the definition + its own destructor
    const txt = await import("node:fs").then((fs) => fs.readFileSync(f, "utf8"));
    txt.split("\n").forEach((line, i) => {
      if (/(?<![\w.])clear\(\)/.test(line) && !/driverIndex\.clear|node->point\.clear|drivers\.clear|virtualDrivers\.clear|pendingQueue|this\.clear/.test(line))
        callers.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  console.log(`        engine_bridge implements CLEAR command: ${hasClearCmd}`);
  console.log(`        engine_bridge calls clear(): ${bridgeUsesClear}`);
  console.log(`        external Quadtree::clear() call sites: ${callers.length ? callers.join("\n          ") : "none"}`);
  check("clear() is reachable end-to-end (would mean UAF is live)", hasClearCmd || bridgeUsesClear || callers.length > 0, "not reachable: only the destructor calls it");

  console.log("\n=================================================================");
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  console.log("=================================================================");
  bridge.stop();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
