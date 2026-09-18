const EARTH_RADIUS_METERS = 6371000;

function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
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

class SpatialHashGrid {
  /**
   * @param {object} bounds { minLat, maxLat, minLng, maxLng }
   * @param {number} cellSizeMeters Cell resolution in meters (e.g. 500m or 1000m)
   */
  constructor(bounds, cellSizeMeters = 500) {
    this.bounds = bounds;
    this.cellSizeMeters = cellSizeMeters;

    // Convert meters to approximate degrees
    this.metersPerLatDegree = 111320;
    const avgLatRad = (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180;
    this.metersPerLngDegree = 111320 * Math.cos(avgLatRad);

    this.latStep = cellSizeMeters / this.metersPerLatDegree;
    this.lngStep = cellSizeMeters / this.metersPerLngDegree;

    this.numRows = Math.ceil((bounds.maxLat - bounds.minLat) / this.latStep);
    this.numCols = Math.ceil((bounds.maxLng - bounds.minLng) / this.lngStep);

    // Fast 1D array of Sets for grid buckets (cache-friendly flat layout)
    // bucketIndex = row * numCols + col
    this.cells = new Array(this.numRows * this.numCols);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = new Set();
    }

    // Driver records: driverId -> { id, lat, lng, cellIndex }
    this.drivers = new Map();
  }

  _getCellCoord(lat, lng) {
    if (
      lat < this.bounds.minLat ||
      lat > this.bounds.maxLat ||
      lng < this.bounds.minLng ||
      lng > this.bounds.maxLng
    ) {
      return null;
    }
    const row = Math.floor((lat - this.bounds.minLat) / this.latStep);
    const col = Math.floor((lng - this.bounds.minLng) / this.lngStep);
    const clampedRow = Math.min(this.numRows - 1, Math.max(0, row));
    const clampedCol = Math.min(this.numCols - 1, Math.max(0, col));
    return {
      row: clampedRow,
      col: clampedCol,
      index: clampedRow * this.numCols + clampedCol,
    };
  }

  /**
   * O(1) Insert
   */
  insert(id, lat, lng) {
    const cell = this._getCellCoord(lat, lng);
    if (!cell) return false;

    if (this.drivers.has(id)) {
      this.remove(id);
    }

    this.cells[cell.index].add(id);
    this.drivers.set(id, { id, lat, lng, cellIndex: cell.index });
    return true;
  }

  /**
   * O(1) Fast-Path Telemetry Update
   */
  update(id, lat, lng) {
    const record = this.drivers.get(id);
    if (!record) {
      return this.insert(id, lat, lng);
    }

    const newCell = this._getCellCoord(lat, lng);
    if (!newCell) return false;

    // Fast-path: Driver stayed in same cell (90%+ of continuous updates)
    if (record.cellIndex === newCell.index) {
      record.lat = lat;
      record.lng = lng;
      return true;
    }

    // Cell changed: move ID to new cell set
    this.cells[record.cellIndex].delete(id);
    this.cells[newCell.index].add(id);
    record.lat = lat;
    record.lng = lng;
    record.cellIndex = newCell.index;
    return true;
  }

  /**
   * O(1) Removal
   */
  remove(id) {
    const record = this.drivers.get(id);
    if (!record) return false;

    this.cells[record.cellIndex].delete(id);
    this.drivers.delete(id);
    return true;
  }

  /**
   * Concentric Ring Expansion k-NN Search
   * Evaluates center cell, then 1-ring (8 neighbors), 2-ring (16 neighbors)...
   */
  kNearestNeighbors(queryLat, queryLng, k = 4, maxRadiusMeters = 10000) {
    const center = this._getCellCoord(queryLat, queryLng);
    if (!center) return [];

    const candidates = [];
    const maxRing = Math.ceil(maxRadiusMeters / this.cellSizeMeters);

    for (let ring = 0; ring <= maxRing; ring++) {
      let foundInRing = false;

      const rMin = Math.max(0, center.row - ring);
      const rMax = Math.min(this.numRows - 1, center.row + ring);
      const cMin = Math.max(0, center.col - ring);
      const cMax = Math.min(this.numCols - 1, center.col + ring);

      for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
          // Only inspect cells strictly on perimeter of the current ring
          if (
            Math.max(Math.abs(r - center.row), Math.abs(c - center.col)) !==
            ring
          ) {
            continue;
          }

          const cellIdx = r * this.numCols + c;
          const bucket = this.cells[cellIdx];
          if (bucket.size === 0) continue;

          for (const id of bucket) {
            const driver = this.drivers.get(id);
            const dist = haversineDistance(
              queryLat,
              queryLng,
              driver.lat,
              driver.lng,
            );

            if (dist <= maxRadiusMeters) {
              candidates.push({
                id: driver.id,
                lat: driver.lat,
                lng: driver.lng,
                distance: dist,
              });
              foundInRing = true;
            }
          }
        }
      }

      // Early exit condition:
      // If we already have at least k candidates and the inner boundary of the next ring
      // is guaranteed to be farther than our current k-th candidate, we can terminate!
      if (candidates.length >= k) {
        candidates.sort((a, b) => a.distance - b.distance);
        const worstBestDistance = candidates[k - 1].distance;
        const nextRingMinDistance = ring * this.cellSizeMeters;

        if (nextRingMinDistance >= worstBestDistance) {
          break;
        }
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    return candidates.slice(0, k);
  }
}

export default { SpatialHashGrid, haversineDistance };
