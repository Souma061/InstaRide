export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export type DriverStatus =
  | "available"
  | "busy"
  | "offline"
  | "locked"
  | "en_route"
  | "in_progress";

export interface Driver {
  id: string;
  lat: number;
  lng: number;
  status: DriverStatus;
  hasLock?: boolean;
  heading?: number;
  speed?: number;
}

export type TripStatus =
  | "idle"
  | "requested"
  | "matching"
  | "matched"
  | "en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface ActiveTrip {
  id: string;
  requestId: string;
  riderId: string;
  driverId?: string | null;
  status: TripStatus;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  distanceMeters?: number;
  offerTimeoutMs?: number;
  activeCandidate?: {
    id: string;
    distanceMeters: number;
    expiresAt: number;
  } | null;
}

export interface LandmarkPreset {
  name: string;
  point: GeoPoint;
}

export interface CityPreset {
  id: string;
  name: string;
  country: string;
  center: GeoPoint;
  zoom: number;
  bounds: GeoBounds;
  landmarks: LandmarkPreset[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  type: "info" | "dispatch" | "lock" | "transition" | "revoke" | "error" | "concurrency";
  message: string;
  details?: Record<string, any>;
}

export interface SystemStats {
  availableDrivers: number;
  busyDrivers: number;
  totalDrivers: number;
  quadtreeNodes: number;
  knnLatencyMs: number;
  activeTripsCount: number;
  observersCount: number;
}

