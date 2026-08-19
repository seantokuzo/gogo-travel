/**
 * On-device distance (T-8.3 / MAP-2 — §2.3 "distance from user (when puck
 * active)"; §2.6: distance labels computed on-device, position never sent
 * to the server).
 *
 * Haversine over the WGS-84 mean radius — the standard small-arc formula;
 * city-scale error is centimeters, far under label rounding. Formatting is
 * metric (PR interpretation: the spec names no unit system; locale-aware
 * units are a later polish, not improvised here): "850 m" under 1 km,
 * "1.2 km" under 10, whole "23 km" beyond.
 */
import type { MapLocationCoordinate } from "./location";

/** WGS-84 mean Earth radius, meters. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineMeters(a: MapLocationCoordinate, b: MapLocationCoordinate): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "850 m" · "1.2 km" · "23 km" (module doc). */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** The sheet's label: null while no position is known (label simply absent). */
export function distanceLabelFor(
  position: MapLocationCoordinate | null,
  place: { lat: number; lng: number },
): string | null {
  if (position === null) return null;
  return `${formatDistance(haversineMeters(position, { lat: place.lat, lng: place.lng }))} away`;
}
