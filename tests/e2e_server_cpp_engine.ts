import { Checker, sleep, startServer, waitFor } from "./helpers/e2e_harness.js";

const PORT = Number(process.env.E2E_PORT) || 3999;

async function main() {
  console.log("=================================================================");
  console.log("  FULL-SERVER E2E: C++ engine through the real HTTP API");
  console.log("=================================================================\n");

  const c = new Checker();
  const api = await startServer(PORT);
  const get = async (path: string) => (await api.get(path)).body;
  const post = async (path: string, body?: unknown) =>
    (await api.post(path, body ?? {})).body;

  try {
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
    c.check("control run actually used the TS engine", tsRun.status.activeEngine === "ts", `engineUsed=${tsRun.race.metrics.engineUsed}`);
    if (tsRun.target) {
      const reportedLat = tsRun.race.alice.pickup.lat - 0.0003;
      const reportedLng = tsRun.race.alice.pickup.lng - 0.0003;
      const err = Math.max(Math.abs(reportedLat - tsRun.target.lat), Math.abs(reportedLng - tsRun.target.lng));
      c.check("TS-derived pickup matches true driver position", err < 1e-9, `err=${err}deg`);
    }

    console.log("\n[4] Race endpoint with C++ engine (the real consumer of quadtree_knn JSON)");
    const cppRun = await runRace("cpp");
    c.check("run actually used the C++ engine", cppRun.status.activeEngine === "cpp", `engineUsed=${cppRun.race.metrics.engineUsed}`);
    if (!cppRun.target) throw new Error("target driver not found in /drivers");
    const t = cppRun.target;
    const gotLat = cppRun.race.alice.pickup.lat - 0.0003;
    const gotLng = cppRun.race.alice.pickup.lng - 0.0003;
    const errDeg = Math.max(Math.abs(gotLat - t.lat), Math.abs(gotLng - t.lng));
    const errMeters = errDeg * 111320;
    console.log(`        target=${t.id}  true=${t.lat},${t.lng}`);
    console.log(`        C++ reported pickup->driver = ${gotLat},${gotLng}`);
    console.log(`        position error = ${errDeg.toFixed(6)} deg (~${errMeters.toFixed(0)} m)`);
    c.check(
      "C++ kNN candidate coordinates survive the IPC/JSON round-trip",
      errDeg < 1e-6,
      `error ~${errMeters.toFixed(0)} m`,
    );
  } finally {
    await api.stop();
  }

  c.done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
