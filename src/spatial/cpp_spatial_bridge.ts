import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CandidateDriver, GeoBounds } from "./quadtree.js";

interface CppResponse {
  status: "ok" | "error";
  action?: string;
  msg?: string;
  success?: boolean;
  id?: string;
  latencyUs?: number;
  count?: number;
  candidates?: CandidateDriver[];
  error?: string;
}

export class CppSpatialBridge {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private isReady = false;
  private pendingQueue: Array<(res: CppResponse) => void> = [];
  private lastLatencyUs = 0;
  private totalQueries = 0;
  private binaryPath: string;

  private static readonly SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

  public static isValidId(id: string): boolean {
    return Boolean(id) && CppSpatialBridge.SAFE_ID_REGEX.test(id);
  }

  constructor(customBinaryPath?: string) {
    this.binaryPath =
      customBinaryPath ||
      path.resolve(process.cwd(), "cpp-engine", "engine_bridge.exe");
  }

  public async start(): Promise<boolean> {
    if (!fs.existsSync(this.binaryPath)) {
      console.warn(
        `[CppSpatialBridge] Binary not found at: ${this.binaryPath}. Falling back to TypeScript engine.`,
      );
      return false;
    }

    try {
      this.process = spawn(this.binaryPath, [], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      if (!this.process.stdout || !this.process.stdin) {
        throw new Error("Failed to open stdio pipes to C++ engine bridge");
      }

      this.rl = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on("line", (line) => {
        try {
          const parsed = JSON.parse(line) as CppResponse;
          const nextResolver = this.pendingQueue.shift();
          if (nextResolver) {
            nextResolver(parsed);
          }
        } catch (err) {
          console.error(
            "[CppSpatialBridge] Error parsing line from C++:",
            line,
            err,
          );
          // Prevent queue desync: reject the waiting request instead of hanging forever
          const nextResolver = this.pendingQueue.shift();
          if (nextResolver) {
            nextResolver({
              status: "error",
              error: `JSON_PARSE_ERROR: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      });

      this.process.on("exit", (code) => {
        console.warn(
          `[CppSpatialBridge] C++ engine process exited with code ${code}`,
        );
        this.isReady = false;
        this.process = null;
        this.drainPendingQueue(`C++ process exited with code ${code}`);
      });

      // Send initial PING to verify readiness
      const pingResponse = await this.sendCommand("PING");
      if (pingResponse.msg === "PONG") {
        this.isReady = true;
        console.log(
          "⚡ [CppSpatialBridge] Connected to native C++ engine (engine_bridge.exe)",
        );
        return true;
      }
      return false;
    } catch (err) {
      console.error("[CppSpatialBridge] Failed to start C++ process:", err);
      this.isReady = false;
      this.drainPendingQueue(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private drainPendingQueue(reason: string): void {
    while (this.pendingQueue.length > 0) {
      const resolver = this.pendingQueue.shift();
      if (resolver) {
        resolver({ status: "error", error: reason });
      }
    }
  }

  private sendCommand(cmd: string): Promise<CppResponse> {
    return new Promise((resolve) => {
      if (!this.process || !this.process.stdin) {
        return resolve({
          status: "error",
          error: "C++ engine bridge is not running",
        });
      }
      this.pendingQueue.push(resolve);
      this.process.stdin.write(cmd + "\n");
    });
  }

  public isAvailable(): boolean {
    return this.isReady && this.process !== null;
  }

  public getLastLatencyUs(): number {
    return this.lastLatencyUs;
  }

  public getTotalQueries(): number {
    return this.totalQueries;
  }

  public async initRegion(
    bounds: GeoBounds,
    capacity: number = 8,
    maxDepth: number = 10,
  ): Promise<boolean> {
    if (!this.isAvailable()) return false;
    const res = await this.sendCommand(
      `INIT ${bounds.minLat} ${bounds.maxLat} ${bounds.minLng} ${bounds.maxLng} ${capacity} ${maxDepth}`,
    );
    return res.status === "ok";
  }

  public async insert(id: string, lat: number, lng: number): Promise<boolean> {
    if (!this.isAvailable() || !CppSpatialBridge.isValidId(id)) return false;
    const res = await this.sendCommand(`INSERT ${id} ${lat} ${lng}`);
    return res.success ?? false;
  }

  public update(id: string, lat: number, lng: number): void {
    if (!this.isAvailable() || !this.process?.stdin || !CppSpatialBridge.isValidId(id)) return;
    this.process.stdin.write(`UPDATE ${id} ${lat} ${lng}\n`);
  }

  public batchUpdate(
    updates: Array<{ id: string; lat: number; lng: number }>,
  ): void {
    if (!this.isAvailable() || !this.process?.stdin || updates.length === 0)
      return;
    const validUpdates = updates.filter((u) => CppSpatialBridge.isValidId(u.id));
    if (validUpdates.length === 0) return;

    let payload = `BATCH_UPDATE ${validUpdates.length}`;
    for (const update of validUpdates) {
      payload += ` ${update.id} ${update.lat} ${update.lng}`;
    }
    this.process.stdin.write(`${payload}\n`);
  }

  public async remove(id: string): Promise<boolean> {
    if (!this.isAvailable() || !CppSpatialBridge.isValidId(id)) return false;
    const res = await this.sendCommand(`REMOVE ${id}`);
    return res.success ?? false;
  }

  public async kNearestNeighbors(
    queryLat: number,
    queryLng: number,
    k: number = 5,
    maxRadiusMeters: number = 50000.0,
  ): Promise<{ candidates: CandidateDriver[]; latencyUs: number }> {
    if (!this.isAvailable()) {
      return { candidates: [], latencyUs: 0 };
    }
    const res = await this.sendCommand(
      `KNN ${queryLat} ${queryLng} ${k} ${maxRadiusMeters}`,
    );
    if (res.status === "ok") {
      this.lastLatencyUs = res.latencyUs ?? 0;
      this.totalQueries++;
      return {
        candidates: res.candidates ?? [],
        latencyUs: this.lastLatencyUs,
      };
    }
    return { candidates: [], latencyUs: 0 };
  }

  public stop(): void {
    if (this.process) {
      try {
        this.process.stdin?.write("QUIT\n");
      } catch {
        // Process might already be closed
      }
      this.process.kill();
      this.process = null;
      this.isReady = false;
      this.drainPendingQueue("C++ engine bridge stopped");
    }
  }
}
