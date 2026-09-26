import { spawn } from "node:child_process";

/**
 * Aggregate integration runner: executes every test suite in this folder
 * sequentially and prints one summary table.
 *
 *   npx tsx tests/integration_all.ts            # core suites
 *   npx tsx tests/integration_all.ts --stress   # core + long stress suites
 *   npx tsx tests/integration_all.ts --only lock
 *
 * A suite passes when its exit code is 0 AND its output carries no failure
 * marker (several suites here assert via console output rather than
 * process.exit, so exit code alone is not trustworthy).
 */

const FAIL_RE = /\[FAIL\]|FAILED|RACE DETECTED|TEST FAILED|Unhandled|AssertionError|INVARIANT VIOLATION/;
const PASS_RE = /\[PASS\]|PASSED|PASS\b|INVARIANTS PASSED|✓|ALL CHECKS PASSED/;

interface Suite {
  file: string;
  what: string;
  tier: "core" | "stress";
}

const SUITES: Suite[] = [
  { file: "test_quadtree.ts", what: "TS quadtree geometry + kNN", tier: "core" },
  { file: "test_driver_registry.ts", what: "driver registry + Redis locks", tier: "core" },
  { file: "test_trip_state_machine.ts", what: "trip state machine", tier: "core" },
  { file: "test_matching_service.ts", what: "matching service", tier: "core" },
  { file: "test_audit_fixes.ts", what: "audit-fix regression suite", tier: "core" },
  { file: "test_integration_edge_cases.ts", what: "integration edge cases", tier: "core" },
  { file: "test_concurrency_race.ts", what: "double-dispatch race", tier: "core" },
  { file: "test_redis_driver_lock.ts", what: "redis lock invariants", tier: "core" },
  { file: "test_redis_trip_store.ts", what: "redis trip store invariants", tier: "core" },
  { file: "test_full_redis_matching_integration.ts", what: "end-to-end redis matching", tier: "core" },
  { file: "test_cpp_bridge.ts", what: "C++ bridge spawn/protocol", tier: "core" },
  { file: "test_cpp_engine_e2e.ts", what: "engine_bridge.exe via koffi", tier: "core" },
  { file: "test_full_integration_stress.ts", what: "C++ DLLs + redis + concurrency", tier: "stress" },
  { file: "e2e_server_cpp_engine.ts", what: "full server over HTTP with C++ engine", tier: "stress" },
  { file: "benchmark_3M_ts.ts", what: "3M-point quadtree stress", tier: "stress" },
];

const argv = process.argv.slice(2);
const stress = argv.includes("--stress");
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? "") : "";
const TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS ?? 900_000);

const selected = SUITES.filter(
  (s) => (stress || s.tier === "core") && (only === "" || s.file.includes(only)),
);

if (selected.length === 0) {
  console.error(`No suite matched --only ${JSON.stringify(only)}`);
  process.exit(2);
}

function run(suite: Suite): Promise<{ ms: number; code: number; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(`npx tsx "tests\\${suite.file}"`, {
      shell: true,
      env: { ...process.env, FORCE_COLOR: "0", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    const started = Date.now();
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ ms: Date.now() - started, code: code ?? -1, out, timedOut });
    });
  });
}

function verdict(r: { code: number; out: string; timedOut: boolean }): { ok: boolean; why: string } {
  if (r.timedOut) return { ok: false, why: `timeout ${Math.round(TIMEOUT_MS / 1000)}s` };
  if (r.code !== 0) return { ok: false, why: `exit ${r.code}` };
  const hit = r.out.match(FAIL_RE);
  if (hit) return { ok: false, why: `output: ${hit[0]}` };
  return { ok: true, why: PASS_RE.test(r.out) ? "pass" : "clean exit" };
}

function tail(out: string, lines = 25): string {
  return out.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

async function main() {
  console.log("======================================================================");
  console.log("  INSTARIDE COMPLETE INTEGRATION RUN");
  console.log(`  ${selected.length} suite(s) | mode: ${stress ? "core + stress" : "core (use --stress for more)"} | Redis required`);
  console.log("======================================================================\n");

  const results: Array<{ s: Suite; ms: number; ok: boolean; why: string; out: string }> = [];
  const t0 = Date.now();

  for (const s of selected) {
    process.stdout.write(`  .. ${s.file.padEnd(40)}`);
    const r = await run(s);
    const v = verdict(r);
    const sec = (r.ms / 1000).toFixed(1);
    results.push({ s, ms: r.ms, ok: v.ok, why: v.why, out: r.out });
    console.log(`${v.ok ? "PASS" : "FAIL"}  ${sec.padStart(6)}s   ${v.why}   (${s.what})`);
    if (!v.ok) {
      console.log("\n  ---- output tail ----------------------------------------------------");
      console.log(tail(r.out).replace(/^/gm, "  | "));
      console.log("  ---------------------------------------------------------------------\n");
    }
  }

  const totalMs = Date.now() - t0;
  const bad = results.filter((r) => !r.ok);

  console.log("\n======================================================================");
  console.log("  SUMMARY");
  console.log("======================================================================");
  const w = Math.max(...results.map((r) => r.s.file.length));
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.s.file.padEnd(w)}  ${(r.ms / 1000).toFixed(1).padStart(7)}s  ${r.s.what}`);
  }
  console.log("----------------------------------------------------------------------");
  console.log(`  ${results.length - bad.length}/${results.length} suites passed | ${(totalMs / 1000).toFixed(1)}s total`);

  if (bad.length > 0) {
    console.log("\n  FAILING:");
    for (const b of bad) console.log(`    - ${b.s.file}: ${b.why}`);
    console.log("======================================================================");
    process.exit(1);
  }
  console.log("  ALL INTEGRATION SUITES PASSED");
  console.log("======================================================================");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
