/**
 * Offline pack state machine — PURE module (T-8.5 / MAP-5, map spec §2.5,
 * R-map-18..22). No React, no SDK imports (types aside): everything here is a
 * function of its inputs, so jest exercises the whole lifecycle without the
 * native `offlineManager` (P-8 prep ruling — jest never renders native
 * Mapbox). The SDK adapter that carries these decisions to the device lives
 * in `offline-pack-controller.ts`.
 *
 * Region contract (§2.5): TileRegion bounds = envelope of
 * `regionCellsForDestination` from `@gogo/shared` — the EXACT cells the POI
 * ingest used (places spec §3.5). One definition of "the destination area";
 * no new geometry here, only the envelope of those cells.
 *
 * State machine (§2.5): `none → downloading(progress) → ready(size,
 * completed_at)`; `ready → stale` when the style URL or destination region
 * changed; `any → failed(error)` with retry (R-map-21). The SDK is the
 * source of truth for pack EXISTENCE; the MMKV annotation
 * (`offline-pack-annotation.ts`) carries what the SDK cannot (trip ↔ pack
 * mapping, completed_at, the style/region the pack was built from).
 */
import type { TripStatus } from "@gogo/shared";
import { regionCellAt, regionCellsForDestination } from "@gogo/shared";

// ---------------------------------------------------------------------------
// Config (§2.5 — zoom range, ceiling, thresholds are config, not magic)
// ---------------------------------------------------------------------------

/** §2.5: pack zoom range z6–z15 (config; verified against real tiles at phase QA). */
export const OFFLINE_PACK_MIN_ZOOM = 6;
export const OFFLINE_PACK_MAX_ZOOM = 15;

/**
 * Device tile-region ceiling (R-map-20: 750 cumulative — research). NEVER
 * raised: bypassing `setTileCountLimit` violates the Mapbox ToS (readiness
 * brief headline 4), so the controller never calls it — hygiene keeps us
 * under the ceiling instead.
 */
export const TILE_REGION_CEILING = 750;
/** §2.5 hygiene: purge past-trip packs when a new download would cross this. */
export const TILE_REGION_PURGE_THRESHOLD = 700;

/**
 * Display-only average vector-tile size for the pre-download estimate. The
 * installed SDK (@rnmapbox/maps 10.3.5) exposes NO size-estimate API
 * (offlineManager.d.ts verified — createPack/getPacks/deletePack only), so
 * §2.5's "size estimated before download" is a deterministic tile-count ×
 * average-size approximation, labeled "~" in every surface that shows it.
 */
export const ESTIMATED_TILE_BYTES = 12_000;

// ---------------------------------------------------------------------------
// Pack identity + region envelope
// ---------------------------------------------------------------------------

const PACK_NAME_PREFIX = "trip-";

/** §2.5 naming: TileRegion id `trip-{tripId}`. */
export function packNameFor(tripId: string): string {
  return `${PACK_NAME_PREFIX}${tripId}`;
}

/** Inverse of `packNameFor` — null when the pack is not one of ours. */
export function tripIdFromPackName(name: string): string | null {
  return name.startsWith(PACK_NAME_PREFIX) ? name.slice(PACK_NAME_PREFIX.length) : null;
}

/**
 * The stale-detection region fingerprint: the destination's CENTER cell key.
 * The 8 neighbors are a pure function of the center (region-grid), so the
 * center key alone identifies the whole 3×3 envelope.
 */
export function packRegionKeyFor(lat: number, lng: number): string {
  return regionCellAt(lat, lng).key;
}

/**
 * Can this destination anchor a pack at all? The schema guarantees real
 * coordinates on the wire, but the map screen carries a DEGRADE arm for
 * unusable coords (world view + EmptyState — R-map-1's fallback), and the
 * pill mounts inside it: the region grid THROWS on NaN/out-of-range, so the
 * whole pack machine stands down instead of crashing the degraded screen
 * (caught live by the map-screen degrade CONTROL in the full run).
 */
export function isUsableDestination(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

/** `[lng, lat]` — GeoJSON position order (createPack bounds contract). */
export type PackBoundsPosition = [number, number];

/**
 * TileRegion bounds for a destination: the envelope of its
 * `regionCellsForDestination` cells, as `[[neLng, neLat], [swLng, swLat]]`
 * (the createPack `bounds` shape — NE first, SW second, verified against the
 * installed SDK's docs/types).
 *
 * Antimeridian: neighbor cells wrap (region-grid), so a cell on the far side
 * is shifted ±360° back beside the center before min/max — the envelope stays
 * a contiguous box (lng may exceed ±180, the standard GeoJSON way to express
 * a box across the antimeridian). Poles: dropped neighbors (8 → 5) simply
 * don't extend the envelope.
 */
export function packBoundsFor(
  lat: number,
  lng: number,
): [PackBoundsPosition, PackBoundsPosition] {
  const cells = regionCellsForDestination(lat, lng);
  const center = cells[0];
  const centerMid = (center.minLng + center.maxLng) / 2;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const cell of cells) {
    let lo = cell.minLng;
    let hi = cell.maxLng;
    const mid = (lo + hi) / 2;
    if (mid - centerMid > 180) {
      lo -= 360;
      hi -= 360;
    } else if (centerMid - mid > 180) {
      lo += 360;
      hi += 360;
    }
    minLat = Math.min(minLat, cell.minLat);
    maxLat = Math.max(maxLat, cell.maxLat);
    minLng = Math.min(minLng, lo);
    maxLng = Math.max(maxLng, hi);
  }
  return [
    [maxLng, maxLat],
    [minLng, minLat],
  ];
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** §2.5 client store states, per trip. */
export type OfflinePackState =
  | { phase: "none" }
  | { phase: "downloading"; progress: number }
  | { phase: "ready"; sizeBytes: number; completedAt: string }
  | { phase: "stale"; sizeBytes: number; completedAt: string }
  | { phase: "failed"; message: string };

export type OfflinePackPhase = OfflinePackState["phase"];

/**
 * The MMKV annotation record (§2.5: "the SDK is the source of truth, MMKV is
 * the annotation") — trip ↔ pack mapping plus the completion facts the SDK
 * doesn't keep.
 */
export interface OfflinePackAnnotation {
  tripId: string;
  /** The style URL the pack was downloaded with (stale detection). */
  styleUrl: string;
  /** `packRegionKeyFor` at download time (stale detection on destination move). */
  regionKey: string;
  /** ISO timestamp of download completion (management UI + purge ordering). */
  completedAt: string;
  /** Real completed size from the SDK's final progress status. */
  sizeBytes: number;
}

/**
 * Derive ready/stale from an annotation against the CURRENT style + region
 * (§2.5: `ready → stale` when style or destination/region changed). No
 * annotation ⇒ `none`.
 */
export function annotatedPackState(
  annotation: OfflinePackAnnotation | undefined,
  current: { styleUrl: string; regionKey: string },
): OfflinePackState {
  if (annotation === undefined) return { phase: "none" };
  const stale =
    annotation.styleUrl !== current.styleUrl || annotation.regionKey !== current.regionKey;
  return stale
    ? { phase: "stale", sizeBytes: annotation.sizeBytes, completedAt: annotation.completedAt }
    : { phase: "ready", sizeBytes: annotation.sizeBytes, completedAt: annotation.completedAt };
}

/**
 * R-map-18 auto-download arm: only an ACTIVE trip with NO pack at all.
 * `stale` deliberately does NOT auto-refresh — §2.5 trigger (3) makes refresh
 * a manual management action ("packs never auto-refresh"), and `failed`
 * requires the user's retry (R-map-21) rather than a silent loop.
 */
export function shouldAutoDownloadPack(input: {
  tripStatus: TripStatus;
  phase: OfflinePackPhase;
}): boolean {
  return input.tripStatus === "active" && input.phase === "none";
}

/**
 * R-map-18 wifi gate (the gate is for the user's data plan, not cost).
 * Structural over expo-network's `NetworkState` without importing it — the
 * pure module stays SDK-free; `"WIFI"` is the enum's literal value
 * (Network.types verified).
 */
export function isWifiState(state: { type?: string; isConnected?: boolean }): boolean {
  return state.type === "WIFI" && state.isConnected === true;
}

/** Clamped integer percent from an SDK progress status. */
export function downloadProgressPercent(status: { percentage: number }): number {
  return Math.max(0, Math.min(100, Math.round(status.percentage)));
}

/**
 * Completion rule: the SDK's own example contract (`status.percentage` hits
 * 100 on the final progress event). The numeric `state` field's enum values
 * are native constants the jest-mocked module doesn't carry, so percentage is
 * the one portable signal.
 */
export function isDownloadComplete(status: { percentage: number }): boolean {
  return status.percentage >= 100;
}

// ---------------------------------------------------------------------------
// Size estimate (display-only — no SDK estimate API in 10.3.5, module doc)
// ---------------------------------------------------------------------------

function lngToTileX(lng: number, zoom: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** zoom);
}

/** Web-mercator Y; lat clamped to the projection's valid range. */
function latToTileY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.min(2 ** zoom - 1, Math.max(0, Math.floor(y * 2 ** zoom)));
}

/**
 * Deterministic slippy-map tile count for a bounds box across the pack zoom
 * range. Bounds may extend past ±180 (antimeridian envelope) — the X count is
 * a difference of unwrapped columns, capped at the ring size per zoom.
 */
export function estimatePackTileCount(
  bounds: [PackBoundsPosition, PackBoundsPosition],
  minZoom: number = OFFLINE_PACK_MIN_ZOOM,
  maxZoom: number = OFFLINE_PACK_MAX_ZOOM,
): number {
  const [[neLng, neLat], [swLng, swLat]] = bounds;
  let total = 0;
  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    const xCount = Math.min(2 ** zoom, lngToTileX(neLng, zoom) - lngToTileX(swLng, zoom) + 1);
    const yCount = latToTileY(swLat, zoom) - latToTileY(neLat, zoom) + 1;
    total += xCount * yCount;
  }
  return total;
}

/** Display-only byte estimate (module doc: labeled "~" wherever shown). */
export function estimatePackSizeBytes(
  bounds: [PackBoundsPosition, PackBoundsPosition],
): number {
  return estimatePackTileCount(bounds) * ESTIMATED_TILE_BYTES;
}

/** "12 MB" / "850 KB" — shared by the estimate line and the ready row. */
export function formatPackSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
  return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

// ---------------------------------------------------------------------------
// Hygiene: ceiling purge planning (R-map-20)
// ---------------------------------------------------------------------------

export interface CeilingPurgeCandidate {
  /** SDK pack name (`trip-{id}`). */
  name: string;
  /** Effective status of the owning trip — unknown trips are NEVER purged. */
  tripStatus: TripStatus | undefined;
  /** Annotation completion stamp; null (unannotated) sorts oldest. */
  completedAt: string | null;
}

/**
 * R-map-20: before a new download, purge PAST-trip packs oldest-first when
 * the region count nears the ceiling — the ceiling is never user-visible as
 * a failure. Pure planning: returns the pack names to delete so that
 * `packCount + 1` (the incoming download) stays at or under `threshold`.
 * Only `past` trips are eligible; if purging every eligible pack still can't
 * clear the threshold, the plan returns what it can (the download proceeds —
 * pack state never blocks, R-map-21 spirit).
 */
export function planCeilingPurge(
  packCount: number,
  candidates: CeilingPurgeCandidate[],
  threshold: number = TILE_REGION_PURGE_THRESHOLD,
): string[] {
  const excess = packCount + 1 - threshold;
  if (excess <= 0) return [];
  const eligible = candidates
    .filter((candidate) => candidate.tripStatus === "past")
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
  return eligible.slice(0, excess).map((candidate) => candidate.name);
}

// ---------------------------------------------------------------------------
// Pill presentation model (R-map-18 progress / R-map-21 retry / R-map-22)
// ---------------------------------------------------------------------------

export type OfflinePillModel =
  | { kind: "hidden" }
  | { kind: "progress"; label: string }
  | { kind: "retry"; label: string }
  | { kind: "notice"; label: string };

/**
 * What the map status pill shows (`map-pill-offline`). Precedence:
 * downloading > failed > offline notice > hidden. The pill is informational
 * plus retry ONLY — it never blocks map interaction (R-map-21; the slot
 * contract's rule). Online with a settled pack (`none`/`ready`/`stale`) the
 * pill hides — stale nudges live in the management UI, not on the map.
 * Offline (R-map-22, composed from the derived `useTripOffline` signal) the
 * pill states whether a saved map is in play.
 */
export function offlinePillModel(state: OfflinePackState, offline: boolean): OfflinePillModel {
  if (state.phase === "downloading") {
    return { kind: "progress", label: `Saving map… ${state.progress}%` };
  }
  if (state.phase === "failed") {
    return { kind: "retry", label: "Map save failed — tap to retry" };
  }
  if (offline) {
    const saved = state.phase === "ready" || state.phase === "stale";
    return {
      kind: "notice",
      label: saved ? "Offline — using saved map" : "Offline — map may be limited",
    };
  }
  return { kind: "hidden" };
}
