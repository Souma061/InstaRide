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
   * @param {object} bounds
   * @param {number} cellSizeMeters
   */
  constructor(bounds, cellSizeMeters = 500) {
    this.bounds = bounds;
    this.cellSizeMeters = cellSizeMeters;

    this.metersPerLatDegree = 111320;

    const avgLatRad = (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180;

    this.metersPerLngDegree = 111320 * Math.cos(avgLatRad);

    this.latStep = cellSizeMeters / this.metersPerLatDegree;

    this.lngStep = cellSizeMeters / this.metersPerLngDegree;

    this.numRows = Math.ceil((bounds.maxLat - bounds.minLat) / this.latStep);

    this.numCols = Math.ceil((bounds.maxLng - bounds.minLng) / this.lngStep);

    // Flat array of Sets.
    //
    // bucketIndex = row * numCols + col
    this.cells = new Array(this.numRows * this.numCols);

    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = new Set();
    }

    // driverId -> {
    //   id,
    //   lat,
    //   lng,
    //   cellIndex
    // }
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
   * O(1) average insertion
   */
  insert(id, lat, lng) {
    const cell = this._getCellCoord(lat, lng);

    if (!cell) {
      return false;
    }

    // Prevent duplicate records.
    if (this.drivers.has(id)) {
      this.remove(id);
    }

    this.cells[cell.index].add(id);

    this.drivers.set(id, {
      id,
      lat,
      lng,
      cellIndex: cell.index,
    });

    return true;
  }

  /**
   * Fast telemetry update.
   *
   * If the driver remains inside the same cell,
   * we only update coordinates.
   *
   * If the driver crosses a cell boundary,
   * move the ID between buckets.
   */
  update(id, lat, lng) {
    const record = this.drivers.get(id);

    if (!record) {
      return this.insert(id, lat, lng);
    }

    const newCell = this._getCellCoord(lat, lng);

    if (!newCell) {
      return false;
    }

    // Fast path.
    if (record.cellIndex === newCell.index) {
      record.lat = lat;
      record.lng = lng;

      return true;
    }

    // Driver crossed a cell boundary.
    this.cells[record.cellIndex].delete(id);

    this.cells[newCell.index].add(id);

    record.lat = lat;
    record.lng = lng;
    record.cellIndex = newCell.index;

    return true;
  }

  /**
   * O(1) average removal.
   */
  remove(id) {
    const record = this.drivers.get(id);

    if (!record) {
      return false;
    }

    this.cells[record.cellIndex].delete(id);

    this.drivers.delete(id);

    return true;
  }

  /**
   * k-NN search using concentric cell-ring expansion.
   *
   * IMPORTANT:
   *
   * We intentionally don't use the previous early-exit:
   *
   *     ring * cellSize >= kthDistance
   *
   * That isn't a mathematically safe lower bound for
   * the distance between the query point and every cell
   * in the next ring.
   *
   * So this version prioritizes correctness:
   * expand the required rings, calculate exact Haversine
   * distances, then sort the candidates.
   */
  kNearestNeighbors(queryLat, queryLng, k = 4, maxRadiusMeters = 10000) {
    const center = this._getCellCoord(queryLat, queryLng);

    if (!center || k <= 0) {
      return [];
    }

    const candidates = [];

    const maxRing = Math.ceil(maxRadiusMeters / this.cellSizeMeters);

    for (let ring = 0; ring <= maxRing; ring++) {
      const rMin = Math.max(0, center.row - ring);

      const rMax = Math.min(this.numRows - 1, center.row + ring);

      const cMin = Math.max(0, center.col - ring);

      const cMax = Math.min(this.numCols - 1, center.col + ring);

      for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
          // Only inspect the perimeter
          // of the current ring.
          if (
            Math.max(Math.abs(r - center.row), Math.abs(c - center.col)) !==
            ring
          ) {
            continue;
          }

          const cellIndex = r * this.numCols + c;

          const bucket = this.cells[cellIndex];

          if (bucket.size === 0) {
            continue;
          }

          for (const id of bucket) {
            const driver = this.drivers.get(id);

            const distance = haversineDistance(
              queryLat,
              queryLng,
              driver.lat,
              driver.lng,
            );

            if (distance <= maxRadiusMeters) {
              candidates.push({
                id: driver.id,
                lat: driver.lat,
                lng: driver.lng,
                distance,
              });
            }
          }
        }
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    return candidates.slice(0, k);
  }
}

export default {
  SpatialHashGrid,
  haversineDistance,
};
