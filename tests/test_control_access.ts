/**
 * Regression suite for the control-gateway access gate.
 *
 * Two bugs are locked down here:
 *
 *  1. HOST=0.0.0.0 used to be classified as loopback. It is the wildcard bind,
 *     so every default install both listened on all interfaces AND skipped the
 *     token check, and the startup guard could never fire.
 *  2. The /ws handshake had no Origin check. WebSocket is the one cross-site
 *     vector with no preflight, so any web page could open a socket to a
 *     loopback-bound server and drive it as a driver or rider.
 */
import { spawnSync } from "node:child_process";
import { WsTap, startServer } from "./helpers/e2e_harness.js";

const PORT = Number(process.env.CONTROL_ACCESS_PORT ?? 3996);
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "[PASS]" : "[FAIL]"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Resolves true if the socket is refused, false if the server accepted it. */
async function refusedByOrigin(origin?: string): Promise<boolean> {
  try {
    const tap = await WsTap.connect(PORT, "driver", "ctrl_probe", origin);
    tap.close();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  console.log("\n[control access] startup guard");

  // 1. Wildcard bind without a token must refuse to boot.
  const boot = spawnSync("npx", ["tsx", "src/server.ts"], {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      PORT: String(PORT + 1),
      HOST: "0.0.0.0",
      LOG_LEVEL: "silent",
      CONTROL_API_TOKEN: "",
    },
  });
  const bootOut = `${boot.stdout ?? ""}${boot.stderr ?? ""}`;
  check(
    "HOST=0.0.0.0 without CONTROL_API_TOKEN refuses to boot",
    boot.status !== 0 && /CONTROL_API_TOKEN is required/.test(bootOut),
    `exit ${boot.status}`,
  );

  console.log("[control access] WebSocket Origin enforcement");

  const api = await startServer(PORT);
  try {
    check(
      "cross-site Origin is refused",
      await refusedByOrigin("https://evil.example"),
    );
    check(
      "same-origin-style loopback Origin is accepted",
      !(await refusedByOrigin("http://localhost:5173")),
      "vite dev server proxy case",
    );
    check("no Origin (native client) is accepted", !(await refusedByOrigin()));
  } finally {
    await api.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n----------------------------------------------------------------------");
  console.log(
    `  ${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name} ${f.detail}`);
    process.exit(1);
  }
  console.log("  CONTROL ACCESS INVARIANTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
