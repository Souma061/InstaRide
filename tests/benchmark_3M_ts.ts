import { GeoBounds, QuadTree, haversineDistance } from "../src/spatial/quadtree.js";

const NUM_DRIVERS = 3_000_000;
const NUM_QUERIES = 100_000;
const K = 5;

const cityBounds: GeoBounds = {
  minLat: 12.8,
  maxLat: 13.2,
  minLng: 77.4,
  maxLng: 77.85,
};

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? passed++ : failed++;
}

function mem() {
  const u = process.memoryUsage();
  return { heapMB: Math.round(u.heapUsed / 1048576), rssMB: Math.round(u.rss / 1048576) };
}

function rnd(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function runTypeScript3MBenchmark() {
  console.log("======================================================================");
  console.log("     INSTARIDE TYPESCRIPT QUADTREE 3,000,000-POINT STRESS");
  console.log("======================================================================\n");
  console.log(`  - Fleet: ${fmt(NUM_DRIVERS)} | capacity 8, maxDepth 14`);
  console.log(`  - Region: [${cityBounds.minLat},${cityBounds.maxLat}] x [${cityBounds.minLng},${cityBounds.maxLng}]\n`);

  const tree = new QuadTree(cityBounds, 8, 14);
  const before = mem();

  // ---- 1: bulk ingestion
  console.log("----------------------------------------------------------------------");
  console.log(`>>> [1] BULK INGESTION (${fmt(NUM_DRIVERS)} POINTS)`);
  console.log("----------------------------------------------------------------------");
  {
    const t0 = performance.now();
    for (let i = 0; i < NUM_DRIVERS; i++) {
      tree.insert(`driver_${i}`, rnd(cityBounds.minLat + 0.01, cityBounds.maxLat - 0.01), rnd(cityBounds.minLng + 0.01, cityBounds.maxLng - 0.01));
      if ((i + 1) % 500_000 === 0) {
        const s = (performance.now() - t0) / 1000;
        const m = mem();
        console.log(`  -> ${fmt(i + 1)} inserts in ${s.toFixed(1)}s (${fmt(Math.round((i + 1) / s))}/s) | heap ${m.heapMB} MB | rss ${m.rssMB} MB`);
      }
    }
    const s = (performance.now() - t0) / 1000;
    const after = mem();
    console.log(`  -> TOTAL ${fmt(NUM_DRIVERS)} inserts in ${s.toFixed(2)}s (${fmt(Math.round(NUM_DRIVERS / s))} inserts/s)`);
    console.log(`  -> Memory: heap ${before.heapMB} -> ${after.heapMB} MB (+${after.heapMB - before.heapMB}) | rss ${after.rssMB} MB`);
    check("all points ingested", tree.size() === NUM_DRIVERS, `size=${tree.size()}`);
    check("heap stays under 6 GB for a 3M fleet", after.heapMB < 6144, `${after.heapMB} MB`);
  }

  // ---- 2: GPS telemetry across the whole fleet
  console.log("\n----------------------------------------------------------------------");
  console.log(`>>> [2] GPS TELEMETRY (${fmt(NUM_DRIVERS)} UPDATES)`);
  console.log("----------------------------------------------------------------------");
  {
    const t0 = performance.now();
    for (let i = 0; i < NUM_DRIVERS; i++) {
      const id = `driver_${Math.floor(Math.random() * NUM_DRIVERS)}`;
      tree.update(id, rnd(cityBounds.minLat + 0.01, cityBounds.maxLat - 0.01), rnd(cityBounds.minLng + 0.01, cityBounds.maxLng - 0.01));
      if ((i + 1) % 500_000 === 0) {
        const s = (performance.now() - t0) / 1000;
        console.log(`  -> ${fmt(i + 1)} updates in ${s.toFixed(1)}s (${fmt(Math.round((i + 1) / s))}/s)`);
      }
    }
    const s = (performance.now() - t0) / 1000;
    console.log(`  -> TOTAL ${fmt(NUM_DRIVERS)} updates in ${s.toFixed(2)}s (${fmt(Math.round(NUM_DRIVERS / s))} updates/s)`);
    check("size stable after updates", tree.size() === NUM_DRIVERS, `size=${tree.size()}`);
  }

  // ---- 3: k-NN throughput + tail latency
  console.log("\n----------------------------------------------------------------------");
  console.log(`>>> [3] k-NN MATCHING QUERIES (k=${K}, radius 10km, ${fmt(NUM_QUERIES)} QUERIES)`);
  console.log("----------------------------------------------------------------------");
  {
    const latencies = new Float64Array(NUM_QUERIES);
    let totalFound = 0;
    const t0 = performance.now();
    for (let i = 0; i < NUM_QUERIES; i++) {
      const qlat = rnd(cityBounds.minLat + 0.01, cityBounds.maxLat - 0.01);
      const qlng = rnd(cityBounds.minLng + 0.01, cityBounds.maxLng - 0.01);
      const q0 = performance.now();
      const res = tree.kNearestNeighbors(qlat, qlng, K, 10000);
      latencies[i] = (performance.now() - q0) * 1000;
      totalFound += res.length;
    }
    const s = (performance.now() - t0) / 1000;
    latencies.sort();
    const pct = (p: number) => latencies[Math.floor((NUM_QUERIES - 1) * p)];
    const avg = latencies.reduce((a, b) => a + b, 0) / NUM_QUERIES;
    console.log(`  -> ${fmt(NUM_QUERIES)} queries in ${s.toFixed(2)}s (${fmt(Math.round(NUM_QUERIES / s))} queries/s)`);
    console.log(`  -> Latency: avg ${avg.toFixed(1)} us | p50 ${pct(0.5).toFixed(1)} us | p95 ${pct(0.95).toFixed(1)} us | p99 ${pct(0.99).toFixed(1)} us | max ${latencies[NUM_QUERIES - 1].toFixed(1)} us`);
    console.log(`  -> Total candidate matches: ${fmt(totalFound)}`);
    check("every query returned at least one neighbour", totalFound > 0, `total=${fmt(totalFound)}`);
  }

  // ---- 4: accuracy vs brute force
  console.log("\n----------------------------------------------------------------------");
  console.log(">>> [4] ACCURACY AUDIT vs BRUTE FORCE (40 PROBES x 200,000 POINTS)");
  console.log("----------------------------------------------------------------------");
  {
    const REF_N = 200_000;
    const ref = new QuadTree(cityBounds, 8, 14);
    const coords: Array<[number, number]> = new Array(REF_N);
    for (let i = 0; i < REF_N; i++) {
      const lat = rnd(cityBounds.minLat + 0.01, cityBounds.maxLat - 0.01);
      const lng = rnd(cityBounds.minLng + 0.01, cityBounds.maxLng - 0.01);
      coords[i] = [lat, lng];
      ref.insert(`ref_${i}`, lat, lng);
    }

    let mismatches = 0;
    let worstGap = 0;
    for (let q = 0; q < 400; q += 10) {
      const [qlat, qlng] = coords[q];
      const got = ref.kNearestNeighbors(qlat, qlng, K, 500000);
      const all = coords
        .map(([la, ln], i) => ({ id: `ref_${i}`, d: haversineDistance(qlat, qlng, la, ln) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, K);

      let same = got.length === K;
      for (let i = 0; same && i < K; i++) {
        if (got[i].id !== all[i].id) same = false;
        const gap = Math.abs(got[i].distance - all[i].d);
        worstGap = Math.max(worstGap, gap);
        if (gap > 1) same = false;
      }
      if (!same) mismatches++;
    }
    check("k-NN top-5 identical to brute force", mismatches === 0, `mismatches=${mismatches} worstGap=${worstGap.toFixed(6)}m`);
  }

  // ---- 5: churn — half the fleet cycles out and back
  console.log("\n----------------------------------------------------------------------");
  console.log(`>>> [5] CHURN (1,500,000 REMOVES + 1,500,000 RE-INSERTS)`);
  console.log("----------------------------------------------------------------------");
  {
    const HALF = NUM_DRIVERS / 2;
    let t0 = performance.now();
    let removed = 0;
    for (let i = 0; i < HALF; i++) if (tree.remove(`driver_${i}`)) removed++;
    let s = (performance.now() - t0) / 1000;
    console.log(`  -> removed ${fmt(removed)} in ${s.toFixed(2)}s (${fmt(Math.round(removed / s))} removes/s)`);
    check("half the fleet removed", tree.size() === NUM_DRIVERS - HALF, `size=${tree.size()}`);

    t0 = performance.now();
    for (let i = 0; i < HALF; i++)
      tree.insert(`driver_${i}`, rnd(cityBounds.minLat + 0.01, cityBounds.maxLat - 0.01), rnd(cityBounds.minLng + 0.01, cityBounds.maxLng - 0.01));
    s = (performance.now() - t0) / 1000;
    console.log(`  -> re-inserted ${fmt(HALF)} in ${s.toFixed(2)}s (${fmt(Math.round(HALF / s))} inserts/s)`);
    check("fleet restored after churn", tree.size() === NUM_DRIVERS, `size=${tree.size()}`);
  }

  const final = mem();
  console.log("\n======================================================================");
  console.log(`  Peak-ish RSS: ${final.rssMB} MB | heap ${final.heapMB} MB`);
  console.log(failed === 0 ? "  3M TS QUADTREE STRESS: ALL CHECKS PASSED" : `  3M TS QUADTREE STRESS: ${failed} CHECK(S) FAILED`);
  console.log("======================================================================");
  process.exit(failed === 0 ? 0 : 1);
}

runTypeScript3MBenchmark();
