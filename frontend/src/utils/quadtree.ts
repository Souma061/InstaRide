import { Driver, GeoBounds } from "../types";

export interface QuadTreeNodeData {
  bounds: GeoBounds;
  depth: number;
  points: Driver[];
  isDivided: boolean;
  children?: QuadTreeNodeData[];
}

/**
 * Builds an in-memory Point-Region Quadtree client-side for dynamic rendering
 * over any coordinate system and any city!
 */
export function buildClientQuadtree(
  drivers: Driver[],
  bounds: GeoBounds,
  maxCapacity: number = 4,
  maxDepth: number = 6
): QuadTreeNodeData {
  function createNode(nodeBounds: GeoBounds, depth: number): QuadTreeNodeData {
    return {
      bounds: nodeBounds,
      depth,
      points: [],
      isDivided: false,
    };
  }

  function inBounds(lat: number, lng: number, b: GeoBounds): boolean {
    return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
  }

  function insert(node: QuadTreeNodeData, driver: Driver): void {
    if (!inBounds(driver.lat, driver.lng, node.bounds)) return;

    if (!node.isDivided) {
      if (node.points.length < maxCapacity || node.depth >= maxDepth) {
        node.points.push(driver);
        return;
      }

      // Subdivide
      const midLat = (node.bounds.minLat + node.bounds.maxLat) / 2;
      const midLng = (node.bounds.minLng + node.bounds.maxLng) / 2;

      const nw = createNode({ minLat: midLat, maxLat: node.bounds.maxLat, minLng: node.bounds.minLng, maxLng: midLng }, node.depth + 1);
      const ne = createNode({ minLat: midLat, maxLat: node.bounds.maxLat, minLng: midLng, maxLng: node.bounds.maxLng }, node.depth + 1);
      const sw = createNode({ minLat: node.bounds.minLat, maxLat: midLat, minLng: node.bounds.minLng, maxLng: midLng }, node.depth + 1);
      const se = createNode({ minLat: node.bounds.minLat, maxLat: midLat, minLng: midLng, maxLng: node.bounds.maxLng }, node.depth + 1);

      node.children = [nw, ne, sw, se];
      node.isDivided = true;

      const currentPoints = node.points;
      node.points = [];
      for (const p of currentPoints) {
        for (const child of node.children) insert(child, p);
      }
    }

    if (node.children) {
      for (const child of node.children) insert(child, driver);
    }
  }

  const root = createNode(bounds, 0);
  for (const d of drivers) {
    if (d.status === "available") {
      insert(root, d);
    }
  }

  return root;
}

export function countQuadtreeNodes(node: QuadTreeNodeData): number {
  if (!node) return 0;
  if (!node.isDivided || !node.children) return 1;
  return 1 + node.children.reduce((acc, c) => acc + countQuadtreeNodes(c), 0);
}

