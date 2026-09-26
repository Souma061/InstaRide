import { MinHeap } from "../utils/min_heap.js";

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface CandidateDriver {
  id: string;
  lat: number;
  lng: number;
  distance: number; // distance in meters
}

interface Point {
  id: string;
  lat: number;
  lng: number;
}

const EARTH_RADIUS_METERS = 6371000;

/**
 * Computes exact spherical distance between two points on Earth.
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculates the exact minimum Haversine distance from a point to an AABB bounding box.
 * If the point is inside the bounding box, the minimum distance is 0.
 */
export function minDistanceToBox(
  lat: number,
  lng: number,
  bounds: GeoBounds,
): number {
  const closestLat = Math.max(bounds.minLat, Math.min(lat, bounds.maxLat));
  const closestLng = Math.max(bounds.minLng, Math.min(lng, bounds.maxLng));
  return haversineDistance(lat, lng, closestLat, closestLng);
}

export class QuadTreeNode {
  public bounds: GeoBounds;
  public depth: number;
  public points: Point[] = [];
  public isDivided: boolean = false;

  // 4 Quadrants
  public nw: QuadTreeNode | null = null;
  public ne: QuadTreeNode | null = null;
  public sw: QuadTreeNode | null = null;
  public se: QuadTreeNode | null = null;
  public parent: QuadTreeNode | null = null;

  constructor(
    bounds: GeoBounds,
    depth: number,
    parent: QuadTreeNode | null = null,
  ) {
    this.bounds = bounds;
    this.depth = depth;
    this.parent = parent;
  }

  public subdivide(): void {
    const midLat = (this.bounds.minLat + this.bounds.maxLat) / 2;
    const midLng = (this.bounds.minLng + this.bounds.maxLng) / 2;

    this.nw = new QuadTreeNode(
      {
        minLat: midLat,
        maxLat: this.bounds.maxLat,
        minLng: this.bounds.minLng,
        maxLng: midLng,
      },
      this.depth + 1,
      this,
    );
    this.ne = new QuadTreeNode(
      {
        minLat: midLat,
        maxLat: this.bounds.maxLat,
        minLng: midLng,
        maxLng: this.bounds.maxLng,
      },
      this.depth + 1,
      this,
    );
    this.sw = new QuadTreeNode(
      {
        minLat: this.bounds.minLat,
        maxLat: midLat,
        minLng: this.bounds.minLng,
        maxLng: midLng,
      },
      this.depth + 1,
      this,
    );
    this.se = new QuadTreeNode(
      {
        minLat: this.bounds.minLat,
        maxLat: midLat,
        minLng: midLng,
        maxLng: this.bounds.maxLng,
      },
      this.depth + 1,
      this,
    );

    this.isDivided = true;
  }
}

interface NodeCandidate {
  node: QuadTreeNode;
  minDist: number;
}

function insertSortedCandidate(
  candidates: CandidateDriver[],
  candidate: CandidateDriver,
  k: number,
): void {
  if (
    candidates.length === k &&
    candidate.distance >= candidates[k - 1].distance
  ) {
    return;
  }

  let idx = 0;
  while (
    idx < candidates.length &&
    candidates[idx].distance <= candidate.distance
  ) {
    idx++;
  }

  candidates.splice(idx, 0, candidate);

  if (candidates.length > k) {
    candidates.pop();
  }
}

export class QuadTree {
  public readonly root: QuadTreeNode;
  public readonly capacity: number;
  public readonly maxDepth: number;
  private readonly driverMap = new Map<string, Point>();
  private readonly driverLeaves = new Map<string, QuadTreeNode>();

  /**
   * @param bounds Geographic bounding box of the city
   * @param capacity Points per leaf before subdividing (default 8)
   * @param maxDepth Deepest allowed tree level to avoid infinite splits (default 7)
   */
  constructor(bounds: GeoBounds, capacity: number = 8, maxDepth: number = 7) {
    this.root = new QuadTreeNode(bounds, 0);
    this.capacity = capacity;
    this.maxDepth = maxDepth;
    this.driverMap = new Map<string, Point>();
    this.driverLeaves = new Map<string, QuadTreeNode>();
  }

  private contains(bounds: GeoBounds, lat: number, lng: number): boolean {
    return (
      lat >= bounds.minLat &&
      lat <= bounds.maxLat &&
      lng >= bounds.minLng &&
      lng <= bounds.maxLng
    );
  }

  /**
   * Insert a driver point into the QuadTree.
   */
  public insert(id: string, lat: number, lng: number): boolean {
    if (this.driverMap.has(id)) {
      this.remove(id);
    }

    const point: Point = { id, lat, lng };
    const leaf = this._insertNode(this.root, point);
    if (leaf) {
      this.driverMap.set(id, point);
      this.driverLeaves.set(id, leaf);
      return true;
    }
    return false;
  }

  private _insertNode(node: QuadTreeNode, point: Point): QuadTreeNode | null {
    if (!this.contains(node.bounds, point.lat, point.lng)) {
      return null;
    }

    // Leaf node: if under capacity OR max depth reached, keep point here
    if (
      !node.isDivided &&
      (node.points.length < this.capacity || node.depth >= this.maxDepth)
    ) {
      node.points.push(point);
      return node;
    }

    // Exceeded capacity and depth allows: subdivide and push existing down
    if (!node.isDivided) {
      node.subdivide();
      const existing = node.points;
      node.points = [];
      for (const p of existing) {
        const targetLeaf = this._insertChild(node, p);
        if (targetLeaf) {
          this.driverLeaves.set(p.id, targetLeaf);
        }
      }
    }

    return this._insertChild(node, point);
  }

  private _insertChild(node: QuadTreeNode, point: Point): QuadTreeNode | null {
    const midLat = (node.bounds.minLat + node.bounds.maxLat) / 2;
    const midLng = (node.bounds.minLng + node.bounds.maxLng) / 2;

    let targetChild: QuadTreeNode;
    if (point.lat >= midLat) {
      targetChild = point.lng < midLng ? node.nw! : node.ne!;
    } else {
      targetChild = point.lng < midLng ? node.sw! : node.se!;
    }

    return this._insertNode(targetChild, point);
  }

  /**
   * Fast-path telemetry update: O(1) in-place mutation if inside same leaf.
   */
  public update(id: string, lat: number, lng: number): boolean {
    const point = this.driverMap.get(id);
    const leaf = this.driverLeaves.get(id);
    if (!point || !leaf) {
      return false;
    }

    // Fast path: driver remained within the same leaf bounding box
    if (this.contains(leaf.bounds, lat, lng)) {
      point.lat = lat;
      point.lng = lng;
      return true;
    }

    // Slow path: driver crossed leaf boundary
    this.remove(id);
    return this.insert(id, lat, lng);
  }

  /**
   * O(1) direct removal via cached leaf reference (no tree traversal).
   */
  public remove(id: string): boolean {
    const leaf = this.driverLeaves.get(id);

    if (!leaf) {
      return false;
    }

    const idx = leaf.points.findIndex((p) => p.id === id);

    if (idx === -1) {
      return false;
    }

    leaf.points.splice(idx, 1);

    this.driverMap.delete(id);
    this.driverLeaves.delete(id);

    // Memory optimization: collapse parent if all sibling quadrants become empty
    this.tryCollapse(leaf.parent);

    return true;
  }

  private tryCollapse(node: QuadTreeNode | null): void {
    if (!node || !node.isDivided) return;

    const nw = node.nw!;
    const ne = node.ne!;
    const sw = node.sw!;
    const se = node.se!;

    // Can only collapse if all children are undivided leaves
    if (nw.isDivided || ne.isDivided || sw.isDivided || se.isDivided) {
      return;
    }

    const totalPoints =
      nw.points.length + ne.points.length + sw.points.length + se.points.length;

    if (totalPoints <= this.capacity) {
      // Gather all points into parent and collapse children
      const allPoints = [
        ...nw.points,
        ...ne.points,
        ...sw.points,
        ...se.points,
      ];
      node.points = allPoints;
      node.isDivided = false;
      node.nw = null;
      node.ne = null;
      node.sw = null;
      node.se = null;

      // Update cached leaf pointers
      for (const p of allPoints) {
        this.driverLeaves.set(p.id, node);
      }

      // Propagate collapse up the tree
      this.tryCollapse(node.parent);
    }
  }

  /**
   * Branch-and-Bound Best-First Search with MinHeap Priority Queue.
   * Order subtrees by minimum bounding-box distance.
   * Prunes entire quadrants once their minimum distance exceeds the k-th best candidate.
   */
  public kNearestNeighbors(
    queryLat: number,
    queryLng: number,
    k: number = 4,
    maxRadiusMeters: number = 10000,
  ): CandidateDriver[] {
    if (k <= 0) return [];

    const candidates: CandidateDriver[] = [];

    // Min-Priority Queue of nodes to visit: ordered by minimum distance to query point
    const pq = new MinHeap<NodeCandidate>((a, b) => a.minDist - b.minDist);
    pq.push({
      node: this.root,
      minDist: minDistanceToBox(queryLat, queryLng, this.root.bounds),
    });

    while (pq.size > 0) {
      // Pop the node closest to the query point in O(log M)
      const current = pq.pop()!;

      // Mathematical Pruning:
      // If the closest possible boundary of this node is farther than our current worst k-th driver:
      if (candidates.length >= k) {
        const worstBestDistance = candidates[k - 1].distance;
        if (current.minDist >= worstBestDistance) {
          break; // Stop: all remaining nodes in pq are strictly farther away
        }
      }

      if (current.minDist > maxRadiusMeters) {
        continue;
      }

      if (!current.node.isDivided) {
        // Leaf node: evaluate points inside
        for (const pt of current.node.points) {
          const dist = haversineDistance(queryLat, queryLng, pt.lat, pt.lng);
          if (dist <= maxRadiusMeters) {
            insertSortedCandidate(
              candidates,
              { id: pt.id, lat: pt.lat, lng: pt.lng, distance: dist },
              k,
            );
          }
        }
      } else {
        // Subdivided node: push 4 child quadrants with their exact box distance
        const children = [
          current.node.nw!,
          current.node.ne!,
          current.node.sw!,
          current.node.se!,
        ];
        for (const child of children) {
          const dist = minDistanceToBox(queryLat, queryLng, child.bounds);
          if (dist <= maxRadiusMeters) {
            pq.push({ node: child, minDist: dist });
          }
        }
      }
    }

    return candidates;
  }

  public size(): number {
    return this.driverMap.size;
  }
}
