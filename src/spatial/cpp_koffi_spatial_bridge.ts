import koffi from "koffi";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CandidateDriver, GeoBounds } from "./quadtree.js";

// ============================================================================
// Zero-Copy C Structs (Matching quadtree_c_api.cpp and hexgrid_c_api.cpp)
// ============================================================================

const CandidateC = koffi.struct("KoffiCandidateC", {
  id: koffi.array("char", 64),
  lat: "double",
  lng: "double",
  distance: "double",
});

const DriverUpdateC = koffi.struct("KoffiDriverUpdateC", {
  id: koffi.array("char", 64),
  lat: "double",
  lng: "double",
});

export type NativeEngineType = "cpp_quadtree" | "cpp_hexgrid";

export class CppKoffiSpatialBridge {
  private isLoaded = false;
  private currentEngine: NativeEngineType = "cpp_quadtree";
  private lastLatencyUs = 0;
  private totalQueries = 0;

  // Bound function references
  private qt_init: any;
  private qt_insert: any;
  private qt_update: any;
  private qt_remove: any;
  private qt_size: any;
  private qt_knn: any;
  private qt_batch_update: any;

  private hg_init: any;
  private hg_insert: any;
  private hg_update: any;
  private hg_remove: any;
  private hg_size: any;
  private hg_knn: any;
  private hg_batch_update: any;

  private activeBounds: GeoBounds = { minLat: 12.8, maxLat: 13.2, minLng: 77.4, maxLng: 77.85 };

  constructor() {
    this.loadLibraries();
  }

  private loadLibraries(): boolean {
    const qtDll = path.resolve(process.cwd(), "cpp-engine", "quadtree.dll");
    const hgDll = path.resolve(process.cwd(), "cpp-engine", "hexgrid.dll");

    if (!fs.existsSync(qtDll) || !fs.existsSync(hgDll)) {
      console.warn(`[CppKoffiSpatialBridge] DLLs not found. Expected: ${qtDll}, ${hgDll}`);
      return false;
    }

    try {
      // 1. Bind Quadtree DLL
      const qtLib = koffi.load(qtDll);
      this.qt_init = qtLib.func("quadtree_init", "void", ["double", "double", "double", "double", "int", "int"]);
      this.qt_insert = qtLib.func("quadtree_insert", "bool", ["str", "double", "double"]);
      this.qt_update = qtLib.func("quadtree_update", "bool", ["str", "double", "double"]);
      this.qt_remove = qtLib.func("quadtree_remove", "bool", ["str"]);
      this.qt_size = qtLib.func("quadtree_size", "int", []);
      this.qt_knn = qtLib.func("quadtree_knn", "int", ["double", "double", "int", "double", "_Out_ KoffiCandidateC *"]);
      this.qt_batch_update = qtLib.func("quadtree_batch_update", "int", ["int", "KoffiDriverUpdateC *"]);

      // 2. Bind HexGrid DLL
      const hgLib = koffi.load(hgDll);
      this.hg_init = hgLib.func("hexgrid_init", "void", ["double", "double", "double"]);
      this.hg_insert = hgLib.func("hexgrid_insert", "bool", ["str", "double", "double"]);
      this.hg_update = hgLib.func("hexgrid_update", "bool", ["str", "double", "double"]);
      this.hg_remove = hgLib.func("hexgrid_remove", "bool", ["str"]);
      this.hg_size = hgLib.func("hexgrid_size", "int", []);
      this.hg_knn = hgLib.func("hexgrid_knn", "int", ["double", "double", "int", "double", "_Out_ KoffiCandidateC *"]);
      this.hg_batch_update = hgLib.func("hexgrid_batch_update", "int", ["int", "KoffiDriverUpdateC *"]);

      this.isLoaded = true;
      console.log("⚡ [CppKoffiSpatialBridge] 64-bit QuadTree & HexGrid native DLLs loaded successfully!");
      return true;
    } catch (err) {
      console.error("[CppKoffiSpatialBridge] Failed to load native DLLs via Koffi:", err);
      this.isLoaded = false;
      return false;
    }
  }

  public isAvailable(): boolean {
    return this.isLoaded;
  }

  public async start(): Promise<boolean> {
    return this.isLoaded;
  }

  public stop(): void {
    // In-process DLL, no child process to kill
  }

  public getActiveEngine(): NativeEngineType {
    return this.currentEngine;
  }

  public setEngine(engine: NativeEngineType | "cpp"): void {
    if (engine === "cpp" || engine === "cpp_quadtree") {
      this.currentEngine = "cpp_quadtree";
    } else if (engine === "cpp_hexgrid") {
      this.currentEngine = "cpp_hexgrid";
    }
    console.log(`🚀 [CppKoffiSpatialBridge] Active C++ spatial engine switched to: ${this.currentEngine}`);
  }

  public getLastLatencyUs(): number {
    return this.lastLatencyUs;
  }

  public getTotalQueries(): number {
    return this.totalQueries;
  }

  public initRegion(bounds: GeoBounds, capacity = 16, maxDepth = 12): void {
    if (!this.isLoaded) return;
    this.activeBounds = bounds;

    // Init Quadtree
    this.qt_init(bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng, capacity, maxDepth);

    // Init HexGrid (Center of bounding box, 460m radius)
    const centerLat = (bounds.minLat + bounds.maxLat) / 2.0;
    const centerLng = (bounds.minLng + bounds.maxLng) / 2.0;
    this.hg_init(centerLat, centerLng, 460.0);
  }

  public insert(id: string, lat: number, lng: number): boolean {
    if (!this.isLoaded) return false;
    this.qt_insert(id, lat, lng);
    this.hg_insert(id, lat, lng);
    return true;
  }

  public update(id: string, lat: number, lng: number): boolean {
    if (!this.isLoaded) return false;
    this.qt_update(id, lat, lng);
    this.hg_update(id, lat, lng);
    return true;
  }

  public remove(id: string): boolean {
    if (!this.isLoaded) return false;
    const r1 = this.qt_remove(id);
    const r2 = this.hg_remove(id);
    return r1 || r2;
  }

  public size(): number {
    if (!this.isLoaded) return 0;
    return this.currentEngine === "cpp_quadtree" ? this.qt_size() : this.hg_size();
  }

  public batchUpdate(updates: Array<{ id: string; lat: number; lng: number }>): void {
    if (!this.isLoaded || updates.length === 0) return;
    this.qt_batch_update(updates.length, updates);
    this.hg_batch_update(updates.length, updates);
  }

  public kNearestNeighbors(
    queryLat: number,
    queryLng: number,
    k = 5,
    maxRadiusMeters = 25000.0,
  ): { candidates: CandidateDriver[]; latencyUs: number } {
    if (!this.isLoaded || k <= 0) {
      return { candidates: [], latencyUs: 0 };
    }

    const outCandidates = Array.from({ length: k }, () => ({
      id: "",
      lat: 0,
      lng: 0,
      distance: 0,
    }));

    const t0 = performance.now();
    let count = 0;

    if (this.currentEngine === "cpp_quadtree") {
      count = this.qt_knn(queryLat, queryLng, k, maxRadiusMeters, outCandidates);
    } else {
      count = this.hg_knn(queryLat, queryLng, k, maxRadiusMeters, outCandidates);
    }

    const t1 = performance.now();
    this.lastLatencyUs = Number(((t1 - t0) * 1000).toFixed(2));
    this.totalQueries++;

    const candidates: CandidateDriver[] = [];
    for (let i = 0; i < count; ++i) {
      const c = outCandidates[i];
      candidates.push({
        id: c.id,
        lat: c.lat,
        lng: c.lng,
        distance: c.distance,
      });
    }

    return { candidates, latencyUs: this.lastLatencyUs };
  }
}
