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
        }
      });

      this.process.on("exit", (code) => {
        console.warn(
          `[CppSpatialBridge] C++ engine process exited with code ${code}`,
        );
        this.isReady = false;
        this.process = null;
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
      return false;
    }
  }

  private sendCommand(cmd: string): Promise<CppResponse> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        return reject(new Error("C++ engine bridge is not running"));
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
    if (!this.isAvailable()) return false;
    const res = await this.sendCommand(`INSERT ${id} ${lat} ${lng}`);
    return res.success ?? false;
  }

  public async update(id: string, lat: number, lng: number): Promise<boolean> {
    if (!this.isAvailable()) return false;
    const res = await this.sendCommand(`UPDATE ${id} ${lat} ${lng}`);
    return res.success ?? false;
  }

  public async remove(id: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
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
    }
  }
}
