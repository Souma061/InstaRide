export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Validates that an input is a non-null object with finite, valid latitude and longitude.
 * Latitude must be within [-90, 90] and Longitude within [-180, 180].
 */
export function isValidGeoPoint(point: any): point is GeoPoint {
  if (!point || typeof point !== "object") {
    return false;
  }

  const { lat, lng } = point;

  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Clamps timing values (like offer timeout) to safe bounds, preventing negative or absurd values.
 */
export function clampTimeout(
  timeout: any,
  defaultMs: number = 15_000,
  minMs: number = 1_000,
  maxMs: number = 60_000,
): number {
  if (
    typeof timeout !== "number" ||
    isNaN(timeout) ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    return defaultMs;
  }
  return Math.min(Math.max(timeout, minMs), maxMs);
}
