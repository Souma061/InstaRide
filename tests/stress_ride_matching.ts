import {
  Api,
  Checker,
  DROPOFF,
  PICKUP,
  TEST_BOUNDS,
  WsTap,
  startServer,
  waitFor,
} from "./helpers/e2e_harness.js";

const PORT = Number(process.env.E2E_STRESS_PORT) || 3997;
const RUN = `${Date.now().toString(36)}`;

const DRIVERS = Number(process.env.STRESS_DRIVERS ?? 60);
const RIDES = Number(process.env.STRESS_RIDES ?? 300);
const WAVES = Number(process.env.STRESS_WAVES ?? 2);
const OFFER_TIMEOUT_MS = 2000;

let runnerApi: Api | null = null;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[i];
}

async function main() {
  console.log("=================================================================");
  console.log("  RIDE MATCHING STORM: concurrent rides through the real HTTP API");
  console.log(
    `  ${RIDES} rides x ${DRIVERS} drivers x ${WAVES} wave(s), offer timeout ${OFFER_TIMEOUT_MS}ms`,
  );
  console.log("=================================================================\n");

  const c = new Checker();
  const api = await startServer(PORT);
  runnerApi = api;
  let obs: WsTap | null = null;
  let acceptor: NodeJS.Timeout | null = null;

  try {
    const reset = await api.post("/simulator/reset", {
      bounds: TEST_BOUNDS,
      driverCount: 0,
      cityName: "Stress Region",
    });
    c.check(
      "Region reset to an empty fleet",
      reset.body?.totalDrivers === 0 && reset.body?.quadtreeSize === 0,
      `drivers=${reset.body?.totalDrivers}`,
    );

    // Seed a grid of drivers around the pickup point.
    const side = Math.ceil(Math.sqrt(DRIVERS));
    const drivers: Array<{ id: string; lat: number; lng: number }> = [];
    for (let i = 0; i < DRIVERS; i++) {
      const row = Math.floor(i / side);
      const col = i % side;
      const lat = Number((PICKUP.lat + (row - side / 2) * 0.004).toFixed(6));
      const lng = Number((PICKUP.lng + (col - side / 2) * 0.004).toFixed(6));
      const id = `stress_d${i}`;
      const r = await api.post("/drivers/spawn", { id, lat, lng });
      if (r.status !== 200) c.check(`Spawn driver ${id}`, false, `status=${r.status}`);
      drivers.push({ id, lat, lng });
    }

    const seeded = await api.driverStatus(
      drivers[0].id,
      drivers[0].lat,
      drivers[0].lng,
    );
    c.check(
      "Entire fleet is registered and indexed",
      seeded.totalDrivers === DRIVERS && seeded.quadtreeSize === DRIVERS,
      `drivers=${seeded.totalDrivers} quadtree=${seeded.quadtreeSize}`,
    );

    obs = await WsTap.connect(PORT, "observer");
    await obs.waitFor((m) => m.type === "connected", 10_000, "observer connected");

    // Simulated driver app: answer every dispatched offer as soon as it lands.
    let scanned = 0;
    acceptor = setInterval(() => {
      const messages = obs!.messages;
      while (scanned < messages.length) {
        const m = messages[scanned++];
        if (m.type !== "offer_dispatched" || !m.requestId?.startsWith(RUN)) {
          continue;
        }
        void api
          .post("/trips/driver-response", {
            driverId: m.driverId,
            requestId: m.requestId,
            response: "accepted",
          })
          .catch(() => undefined);
      }
    }, 10);

    /** Ride i is placed next to driver (i % DRIVERS) so demand is spread. */
    const pickupFor = (i: number) => {
      const d = drivers[i % DRIVERS];
      const off = ((i * 37) % 100) / 100_000;
      return { lat: d.lat + off, lng: d.lng - off / 2 };
    };

    const runWave = async (
      label: string,
      count: number,
      expectFullFleet: boolean,
    ) => {
      c.section(label);

      const submitted = new Map<string, number>();
      const posts = Array.from({ length: count }, (_, i) => {
        const requestId = `${RUN}_${label.replace(/\W/g, "")}_r${i}`;
        submitted.set(requestId, Date.now());
        return api.post("/rides", {
          riderId: `${RUN}_${label.replace(/\W/g, "")}_u${i}`,
          requestId,
          pickup: pickupFor(i),
          dropoff: DROPOFF,
          offerTimeoutMs: OFFER_TIMEOUT_MS,
        });
      });

      const waveStart = Date.now();
      const responses = await Promise.all(posts);
      const ok = responses.filter((r) => r.status === 202).length;
      const bad = responses.find((r) => r.status !== 202);
      c.check(
        "Every ride request is accepted into matching",
        ok === count,
        `ok=${ok}/${count} firstError=${
          bad ? `${bad.status} ${bad.body?.error}` : "-"
        }`,
      );
      const submitMs = Date.now() - waveStart;

      const resolvedFor = () =>
        obs!.messages.filter(
          (m) =>
            typeof m.requestId === "string" &&
            submitted.has(m.requestId) &&
            (m.type === "match_failed" ||
              (m.type === "trip_event" && m.status === "matched")),
        );

      await waitFor(
        async () => {
          const seen = new Set(resolvedFor().map((m) => m.requestId));
          return [...submitted.keys()].every((rid) => seen.has(rid));
        },
        240_000,
        `${label}: every ride to resolve`,
      );

      const resolved = resolvedFor();
      const matched = resolved.filter(
        (m) => m.type === "trip_event" && m.status === "matched",
      );
      const failed = resolved.filter((m) => m.type === "match_failed");
      const failReasons = new Map<string, number>();
      for (const f of failed) {
        failReasons.set(f.reason, (failReasons.get(f.reason) ?? 0) + 1);
      }

      c.check(
        "Every ride resolves as matched or match_failed",
        matched.length + failed.length === count,
        `matched=${matched.length} failed=${failed.length}`,
      );

      // Trips are never completed mid-wave, so a driver holding two trips is
      // a hard double-dispatch violation.
      const perDriver = new Map<string, string[]>();
      for (const m of matched) {
        const list = perDriver.get(m.driverId) ?? [];
        list.push(m.tripId);
        perDriver.set(m.driverId, list);
      }
      const offenders = [...perDriver.entries()]
        .filter(([, trips]) => trips.length > 1)
        .map(([id, trips]) => `${id}:${trips.join("+")}`);
      c.check(
        "No driver is ever assigned two trips at once",
        offenders.length === 0,
        `offenders=${offenders.join(",") || "none"}`,
      );
      c.check(
        "Match count never exceeds the fleet size",
        matched.length <= DRIVERS,
        `matched=${matched.length} drivers=${DRIVERS}`,
      );

      const offers = obs.messages.filter(
        (m) =>
          typeof m.requestId === "string" &&
          submitted.has(m.requestId) &&
          m.type === "offer_dispatched",
      );
      const revoked = obs.messages.filter(
        (m) =>
          typeof m.requestId === "string" &&
          submitted.has(m.requestId) &&
          m.type === "offer_revoked",
      );
      const revokeReasons = new Map<string, number>();
      for (const r of revoked) {
        revokeReasons.set(r.reason, (revokeReasons.get(r.reason) ?? 0) + 1);
      }

      const latencies: number[] = [];
      for (const m of resolved) {
        const t0 = submitted.get(m.requestId);
        if (t0) latencies.push(Math.max(0, m.receivedAt - t0));
      }
      latencies.sort((a, b) => a - b);
      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const p99 = percentile(latencies, 99);
      const settle = Date.now() - waveStart;

      console.log(
        `        offers=${offers.length} matched=${matched.length} ` +
          `failed=${failed.length} revoked=${revoked.length}${
            revokeReasons.size
              ? ` (${[...revokeReasons.entries()]
                  .map(([r, n]) => `${JSON.stringify(r)}=${n}`)
                  .join(" ")})`
              : ""
          }`,
      );
      console.log(
        `        submit=${submitMs}ms settle=${settle}ms ` +
          `p50=${p50}ms p95=${p95}ms p99=${p99}ms ` +
          `throughput=${((count / settle) * 1000).toFixed(1)} rides/s`,
      );
      if (failReasons.size > 0) {
        console.log(
          `        failure reasons: ${[...failReasons.entries()]
            .map(([r, n]) => `${JSON.stringify(r)}=${n}`)
            .join(" ")}`,
        );
      }

      c.check("Resolution latency stays within the 10s budget", p95 < 10_000, `p95=${p95}ms`);

      if (expectFullFleet) {
        c.check(
          "One uncontended ride per driver matches the whole fleet",
          matched.length === DRIVERS,
          `matched=${matched.length} drivers=${DRIVERS}`,
        );
      } else {
        c.check(
          "Oversubscribed storm still puts drivers to work",
          matched.length > 0,
          `matched=${matched.length}`,
        );
      }

      // Release every matched trip so the next wave starts from a clean slate.
      await Promise.all(
        matched.map((m) =>
          api.post(`/rides/${m.tripId}/cancel`, { riderId: m.riderId }),
        ),
      );

      await waitFor(
        async () => {
          const probe = await api.driverStatus(
            drivers[0].id,
            drivers[0].lat,
            drivers[0].lng,
          );
          return probe.quadtreeSize === DRIVERS;
        },
        30_000,
        `${label}: fleet back in the index`,
      );

      const statuses = await Promise.all(
        drivers.map((d) => api.driverStatus(d.id, d.lat, d.lng)),
      );
      const notAvailable = statuses
        .map((s, i) => ({ id: drivers[i].id, status: s.status }))
        .filter((s) => s.status !== "available");
      c.check(
        "No lock leaks: every driver is available after cleanup",
        notAvailable.length === 0,
        `busy=${notAvailable.map((s) => s.id).join(",") || "none"}`,
      );
      c.check(
        "Spatial index is fully repopulated (no stuck entries)",
        statuses[0].quadtreeSize === DRIVERS &&
          statuses[0].totalDrivers === DRIVERS,
        `quadtree=${statuses[0].quadtreeSize} drivers=${statuses[0].totalDrivers}`,
      );
    };

    await runWave("utilization", DRIVERS, true);
    for (let w = 0; w < WAVES; w++) {
      await runWave(`storm${w + 1}`, RIDES, false);
    }
  } finally {
    if (acceptor) clearInterval(acceptor);
    obs?.close();
    await api.stop();
  }

  c.done();
}

main().catch((err) => {
  console.error("stress runner error:", err);
  const logs = runnerApi?.logs;
  if (logs?.length) {
    console.error("---- server log tail ----");
    console.error(logs.slice(-60).join(""));
  }
  process.exit(1);
});
