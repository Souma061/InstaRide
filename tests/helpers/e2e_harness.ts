import { spawn, spawnSync, ChildProcess } from "node:child_process";

function killTree(child: ChildProcess) {
  // spawn() with shell:true leaves node as a grandchild; taskkill /T reaps
  // the whole tree so the next run finds a free port.
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } else {
      child.kill();
    }
  } catch {
    /* already dead */
  }
}

async function portInUse(port: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 500);
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const TEST_BOUNDS = {
  minLat: 37.7,
  maxLat: 37.85,
  minLng: -122.55,
  maxLng: -122.35,
};

export const PICKUP = { lat: 37.7749, lng: -122.4194 };
export const DROPOFF = { lat: 37.7833, lng: -122.4167 };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Api {
  base: string;
  logs: string[];
  child: ChildProcess;
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** registerDriver is an upsert: re-spawning an existing id reports its live status. */
  driverStatus(
    id: string,
    lat: number,
    lng: number,
  ): Promise<{ status?: string; quadtreeSize?: number; totalDrivers?: number }>;
  stop(): Promise<void>;
}

export async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers:
        body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `${method} ${path}: server unreachable (${(e as Error).message})`,
    );
  }
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: parsed };
}

export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for: ${label}${last ? ` (${last})` : ""}`);
}

export async function startServer(port: number): Promise<Api> {
  // A leftover server from a previous run would answer /health while the fresh
  // one dies on EADDRINUSE — fail fast instead of testing the wrong process.
  if (await portInUse(port)) {
    throw new Error(
      `port ${port} is already in use — a leftover test server from an earlier ` +
        `run. Kill it, then retry:\n` +
        `  netstat -ano | findstr :${port}\n` +
        `  taskkill /pid <pid> /T /F`,
    );
  }

  const child = spawn("npx", ["tsx", "src/server.ts"], {
    shell: true,
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: "warn",
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  const get = (path: string) => request(base, "GET", path);
  const post = (path: string, body?: unknown) =>
    request(base, "POST", path, body);

  const api: Api = {
    base,
    logs,
    child,
    get,
    post,
    driverStatus: async (id, lat, lng) => {
      const r = await post("/drivers/spawn", { id, lat, lng });
      return {
        status: r.body?.driver?.status,
        quadtreeSize: r.body?.quadtreeSize,
        totalDrivers: r.body?.totalDrivers,
      };
    },
    stop: async () => {
      killTree(child);
      await sleep(400);
    },
  };

  // Ctrl+C / a thrown error must not strand the server: a surviving node
  // grandchild owns the port and blocks every later run.
  let reaped = false;
  const reap = () => {
    if (reaped) return;
    reaped = true;
    killTree(child);
  };
  process.once("exit", reap);
  process.once("SIGINT", () => {
    reap();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    reap();
    process.exit(143);
  });

  const abort = setTimeout(() => {
    console.error("---- server log tail ----");
    console.error(logs.slice(-50).join(""));
    reap();
  }, 75_000);

  try {
    await waitFor(
      async () => (await get("/health")).body?.status === "ok",
      70_000,
      `server /health on ${port}`,
    );
  } catch (e) {
    console.error("---- server log tail ----");
    console.error(logs.slice(-50).join(""));
    throw e;
  } finally {
    clearTimeout(abort);
  }

  return api;
}

export class Checker {
  passed = 0;
  failed = 0;

  check(name: string, ok: boolean, detail = "") {
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
    );
    if (ok) this.passed++;
    else this.failed++;
  }

  section(title: string) {
    console.log(`\n[${title}]`);
  }

  done(): never {
    console.log("\n=================================================================");
    console.log(
      this.failed === 0
        ? `ALL CHECKS PASSED — ${this.passed} passed`
        : `${this.failed} CHECK(S) FAILED — ${this.passed} passed`,
    );
    console.log("=================================================================");
    process.exit(this.failed ? 1 : 0);
  }
}

type Waiter = {
  pred: (m: any) => boolean;
  resolve: (m: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class WsTap {
  readonly messages: any[] = [];
  private readonly waiters: Waiter[] = [];

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static connect(port: number, role: string, id?: string): Promise<WsTap> {
    const url = `ws://127.0.0.1:${port}/ws?role=${role}${
      id ? `&id=${encodeURIComponent(id)}` : ""
    }`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const tap = new WsTap(ws);
      const timer = setTimeout(() => {
        reject(new Error(`ws open timeout for ${url}`));
        try {
          ws.close();
        } catch {
          /* not open */
        }
      }, 15_000);

      ws.addEventListener("message", (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        tap.push(msg);
      });
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(tap);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`ws error for ${url}`));
      });
    });
  }

  private push(msg: any) {
    msg.receivedAt = Date.now();
    this.messages.push(msg);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.pred(msg)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  }

  waitFor(
    pred: (m: any) => boolean,
    timeoutMs = 10_000,
    label = "ws message",
  ): Promise<any> {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `timed out waiting for ${label}; saw ${this.messages.length} messages: ` +
              this.messages
                .slice(-8)
                .map((m) => m.type)
                .join(","),
          ),
        );
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  count(pred: (m: any) => boolean): number {
    return this.messages.filter(pred).length;
  }

  ofType(type: string): any[] {
    return this.messages.filter((m) => m.type === type);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
