import { spawn, ChildProcess } from "node:child_process";

const PORT = Number(process.env.E2E_PORT) || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string) {
  const res = await fetch(BASE + path);
  return res.json() as Promise<any>;
}
async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json() as Promise<any>;
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* server not up yet */
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function main() {
  console.log("=================================================================");
  console.log("  FULL-SERVER E2E: C++ engine through the real HTTP API");
  console.log("=================================================================\n");

  const server: ChildProcess = spawn("npx", ["tsx", "src/server.ts"], {
    shell: true,
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));

  const kill = () => {
    try {
      server.kill();
    } catch {
      /* already dead */
    }
  };
  process.on("exit", kill);

  try {
    await waitFor(async () => (await get("/health")).status === "ok", 60000, "server /health");
    console.log("[1] Server is up");
    await waitFor(async () => (await get("/api/engine/status")).cppAvailable === true, 30000, "C++ bridge available");
    await sleep(2000); // let the bridge finish initial inserts + a few telemetry ticks

    const drivers: Array<{ id: string; lat: number; lng: number; status: string }> = await get("/drivers");
    console.log(`[2] ${drivers.length} simulated drivers registered`);
    if (drivers.length < 10) throw new Error("simulator did not seed drivers");

    const runRace = async (engine: "ts" | "cpp") => {
      await post("/api/engine/select", { engine });
      const status = await get("/api/engine/status");
      const race = await post("/simulator/concurrency-race", {});
      const target = drivers.find((d) => d.id === race.targetContendedDriverId);
      return { status, race, target };
    };

    console.log("\n[3] Race endpoint with TypeScript engine (control)");
    const tsRun = await runRace("ts");
    check("control run actually used the TS engine", tsRun.status.activeEngine === "ts", `engineUsed=${tsRun.race.metrics.engineUsed}`);
    if (tsRun.target) {
      const reportedLat = tsRun.race.alice.pickup.lat - 0.0003;
      const reportedLng = tsRun.race.alice.pickup.lng - 0.0003;
      const err = Math.max(Math.abs(reportedLat - tsRun.target.lat), Math.abs(reportedLng - tsRun.target.lng));
      check("TS-derived pickup matches true driver position", err < 1e-9, `err=${err}deg`);
    }

    console.log("\n[4] Race endpoint with C++ engine (the real consumer of quadtree_knn JSON)");
    const cppRun = await runRace("cpp");
    check("run actually used the C++ engine", cppRun.status.activeEngine === "cpp", `engineUsed=${cppRun.race.metrics.engineUsed}`);
    if (!cppRun.target) throw new Error("target driver not found in /drivers");
    const t = cppRun.target;
    const gotLat = cppRun.race.alice.pickup.lat - 0.0003;
    const gotLng = cppRun.race.alice.pickup.lng - 0.0003;
    const errDeg = Math.max(Math.abs(gotLat - t.lat), Math.abs(gotLng - t.lng));
    const errMeters = errDeg * 111320;
    console.log(`        target=${t.id}  true=${t.lat},${t.lng}`);
    console.log(`        C++ reported pickup->driver = ${gotLat},${gotLng}`);
    console.log(`        position error = ${errDeg.toFixed(6)} deg (~${errMeters.toFixed(0)} m)`);
    check(
      "C++ kNN candidate coordinates survive the IPC/JSON round-trip",
      errDeg < 1e-6,
      `error ~${errMeters.toFixed(0)} m`,
    );
  } finally {
    kill();
    await sleep(1000);
  }

  console.log("\n=================================================================");
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  console.log("=================================================================");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
