/**
 * Offline pack controller (T-8.5 / MAP-5 — map spec §2.5, R-map-18..21): the
 * ONE module that touches `offlineManager` and `expo-network`. Decisions live
 * in the pure machine (`offline-packs.ts`); this file carries them to the
 * SDK behind a seam jest mocks wholesale (jest.setup.js — the machine's
 * suites never see a native module).
 *
 * TOKENLESS POSTURE (P-8 prep / T-6.4 $0 precedent): real `offlineManager`
 * downloads need the runtime `pk.` token — a phase-QA Sean item. Until then
 * every path here runs against the jest mock or no-ops on device (createPack
 * errors surface as the `failed` state with retry, which is the R-map-21
 * contract anyway). Nothing blocks: pack state never gates map interaction.
 *
 * Exactly-once download semantics (R-map-18 "starts download exactly once"):
 * `startPackDownload`'s guard section is SYNCHRONOUS — in-flight latch and
 * the `downloading` store flip happen with no await between check and set,
 * so two surfaces mounting the controller together (map pill + settings
 * sheet) can never double-start on one trip.
 *
 * ToS: `setTileCountLimit` is NEVER called (readiness brief headline 4 —
 * bypassing the ceiling violates the Mapbox ToS). Hygiene (R-map-20 purge +
 * orphan sweep) keeps the device under the 750-region ceiling instead.
 */
import { offlineManager } from "@rnmapbox/maps";
import * as Network from "expo-network";
import type { Paginated, TripListItem, TripStatus } from "@gogo/shared";
import { useTheme } from "@gogo/tokens/react";
import type { InfiniteData } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { queryClient, queryKeys } from "@/data/query-client";

import {
  annotatedPackState,
  downloadProgressPercent,
  isDownloadComplete,
  isUsableDestination,
  isWifiState,
  OFFLINE_PACK_MAX_ZOOM,
  OFFLINE_PACK_MIN_ZOOM,
  packBoundsFor,
  packNameFor,
  packRegionKeyFor,
  planCeilingPurge,
  shouldAutoDownloadPack,
  tripIdFromPackName,
  type CeilingPurgeCandidate,
  type OfflinePackState,
} from "./offline-packs";
import {
  readPackAnnotation,
  removePackAnnotation,
  writePackAnnotation,
} from "./offline-pack-annotation";
import { mapStyleUrlForScheme } from "./map-style";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface OfflinePackStoreState {
  packs: Record<string, OfflinePackState>;
}

/** Reactive per-trip pack state; actions are module functions (house pattern). */
export const useOfflinePackStore = create<OfflinePackStoreState>(() => ({ packs: {} }));

const NONE: OfflinePackState = { phase: "none" };

/** Imperative read (effects, guards) — store entry or `none`. */
export function offlinePackStateFor(tripId: string): OfflinePackState {
  return useOfflinePackStore.getState().packs[tripId] ?? NONE;
}

function statesEqual(a: OfflinePackState, b: OfflinePackState): boolean {
  if (a.phase !== b.phase) return false;
  switch (a.phase) {
    case "downloading":
      return b.phase === "downloading" && a.progress === b.progress;
    case "ready":
    case "stale":
      return (
        (b.phase === "ready" || b.phase === "stale") &&
        a.sizeBytes === b.sizeBytes &&
        a.completedAt === b.completedAt
      );
    case "failed":
      return b.phase === "failed" && a.message === b.message;
    default:
      return true;
  }
}

/** Equality-guarded set — no store churn (and no act noise) on a no-op. */
function setPackState(tripId: string, state: OfflinePackState): void {
  const current = offlinePackStateFor(tripId);
  if (statesEqual(current, state)) return;
  useOfflinePackStore.setState((prev) => ({ packs: { ...prev.packs, [tripId]: state } }));
}

// ---------------------------------------------------------------------------
// Session latches
// ---------------------------------------------------------------------------

/** Trips with a createPack in flight — the exactly-once latch (module doc). */
const inFlight = new Set<string>();
let orphanSweepDone = false;

/** Test-only: clear store + latches (mirrors resetMapLocationForTests). */
export function resetOfflinePacksForTests(): void {
  useOfflinePackStore.setState({ packs: {} });
  inFlight.clear();
  orphanSweepDone = false;
}

// ---------------------------------------------------------------------------
// Derivation + reconcile
// ---------------------------------------------------------------------------

export interface PackFingerprint {
  styleUrl: string;
  regionKey: string;
}

/**
 * Seed/refresh the store from the MMKV annotation (sync — first frame is
 * right, house no-flash posture). Session states the annotation can't know
 * about (`downloading`, `failed`) are preserved.
 */
export function syncPackStateFromAnnotation(tripId: string, current: PackFingerprint): void {
  const existing = offlinePackStateFor(tripId);
  if (existing.phase === "downloading" || existing.phase === "failed") return;
  setPackState(tripId, annotatedPackState(readPackAnnotation(tripId), current));
}

/**
 * Async truth-check against the SDK (§2.5: the SDK is the source of truth
 * for pack existence): an annotation whose pack vanished is cleared (state
 * falls back to `none`); a `trip-{id}` pack with NO annotation is
 * unaccounted-for on this install and removed (same policy as the orphan
 * sweep). No-drift is a no-op — the equality-guarded store never churns.
 */
export async function reconcilePackState(tripId: string, current: PackFingerprint): Promise<void> {
  if (inFlight.has(tripId)) return;
  try {
    const pack = await offlineManager.getPack(packNameFor(tripId));
    if (inFlight.has(tripId)) return; // download started while we awaited
    const annotation = readPackAnnotation(tripId);
    if (annotation !== undefined && pack === undefined) {
      removePackAnnotation(tripId);
      syncPackStateFromAnnotation(tripId, current);
      return;
    }
    if (annotation === undefined && pack !== undefined) {
      await offlineManager.deletePack(packNameFor(tripId));
      syncPackStateFromAnnotation(tripId, current);
    }
  } catch {
    // Reconcile is hygiene, not a user surface — SDK errors here never
    // disturb the rendered state (R-map-21: pack state never blocks).
  }
}

// ---------------------------------------------------------------------------
// Hygiene (R-map-20)
// ---------------------------------------------------------------------------

/**
 * Effective status of a trip from the query cache (detail row, then either
 * trips list). `undefined` (not cached) trips are NEVER purge candidates —
 * conservative by design: the first-page list cache can't see every trip,
 * and deleting a live pack is worse than briefly exceeding the threshold.
 */
function tripStatusFromCache(tripId: string): TripStatus | undefined {
  const detail = queryClient.getQueryData<{ status: TripStatus }>(queryKeys.trip(tripId));
  if (detail !== undefined) return detail.status;
  const page = queryClient.getQueryData<Paginated<TripListItem>>(queryKeys.trips);
  const fromPage = page?.items.find((trip) => trip.id === tripId);
  if (fromPage !== undefined) return fromPage.status;
  const infinite = queryClient.getQueryData<InfiniteData<Paginated<TripListItem>>>(
    queryKeys.tripsList,
  );
  for (const p of infinite?.pages ?? []) {
    const row = p.items.find((trip) => trip.id === tripId);
    if (row !== undefined) return row.status;
  }
  return undefined;
}

/** The SDK types `OfflinePack.name` as `any` — narrow it once, here. */
function sdkPackName(pack: { name: unknown }): string | null {
  return typeof pack.name === "string" ? pack.name : null;
}

/**
 * R-map-20 ceiling purge, executed before a new download: enumerate regions,
 * delete past-trip packs oldest-first while the count nears the ceiling.
 * The incoming trip's own pack is never a candidate AND never counted —
 * replace deletes it before createPack re-registers the name.
 */
async function purgeForNewDownload(
  tripId: string,
  tripStatusFor: (id: string) => TripStatus | undefined,
): Promise<void> {
  const packs = await offlineManager.getPacks();
  const candidates: CeilingPurgeCandidate[] = [];
  // Replace semantics: the incoming trip's own pack (if present) is deleted
  // before createPack, so a refresh nets ZERO regions — counting it (round 1)
  // purged a past trip's saved map one download earlier than the threshold
  // requires.
  let packCount = packs.length;
  for (const pack of packs) {
    const name = sdkPackName(pack);
    const packTripId = name === null ? null : tripIdFromPackName(name);
    if (name === null || packTripId === null) continue;
    if (packTripId === tripId) {
      packCount -= 1;
      continue;
    }
    candidates.push({
      name,
      tripStatus: tripStatusFor(packTripId),
      completedAt: readPackAnnotation(packTripId)?.completedAt ?? null,
    });
  }
  for (const name of planCeilingPurge(packCount, candidates)) {
    await offlineManager.deletePack(name);
    const purgedTripId = tripIdFromPackName(name);
    if (purgedTripId !== null) {
      removePackAnnotation(purgedTripId);
      setPackState(purgedTripId, NONE);
    }
  }
}

/**
 * §2.5 orphan sweep (once per session): `trip-{id}` packs with no MMKV
 * annotation are unaccounted-for on this install — removed. Trips deleted
 * REMOTELY keep their pack until the local delete/leave hook or this
 * install's annotation loses them; a full local-trip-list reconciliation
 * needs a complete list source the client can't safely assume (the cached
 * first page isn't one) — documented interpretation, PR record.
 */
export async function runOrphanPackSweep(): Promise<void> {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  try {
    const packs = await offlineManager.getPacks();
    for (const pack of packs) {
      const name = sdkPackName(pack);
      const tripId = name === null ? null : tripIdFromPackName(name);
      if (name === null || tripId === null || inFlight.has(tripId)) continue;
      if (readPackAnnotation(tripId) === undefined) {
        await offlineManager.deletePack(name);
      }
    }
  } catch {
    // Sweep is best-effort hygiene; it re-arms next session.
  }
}

// ---------------------------------------------------------------------------
// Lifecycle actions (download / retry / refresh / delete)
// ---------------------------------------------------------------------------

export interface PackDownloadTarget {
  tripId: string;
  destinationLat: number;
  destinationLng: number;
  styleUrl: string;
}

/**
 * Start (or restart) the trip's pack download. Returns whether a download
 * was actually started — `false` means one is already in flight (the
 * exactly-once latch). Retry (R-map-21) and refresh (§2.5 trigger 3,
 * replaces under the same id) are the same operation: any previous pack is
 * deleted first, then `createPack` re-registers `trip-{tripId}`.
 */
export function startPackDownload(
  target: PackDownloadTarget,
  opts?: { tripStatusFor?: (id: string) => TripStatus | undefined },
): boolean {
  const { tripId, styleUrl } = target;
  // SYNC guard section — no await between check and latch (module doc).
  if (inFlight.has(tripId) || offlinePackStateFor(tripId).phase === "downloading") {
    return false;
  }
  inFlight.add(tripId);
  setPackState(tripId, { phase: "downloading", progress: 0 });

  const name = packNameFor(tripId);
  const regionKey = packRegionKeyFor(target.destinationLat, target.destinationLng);
  const tripStatusFor = opts?.tripStatusFor ?? tripStatusFromCache;

  const finishFailed = (message: string): void => {
    if (!inFlight.has(tripId)) return;
    inFlight.delete(tripId);
    offlineManager.unsubscribe(name);
    setPackState(tripId, { phase: "failed", message });
  };

  void (async () => {
    try {
      await purgeForNewDownload(tripId, tripStatusFor);
      // Replace semantics: createPack on an existing name errors, so any
      // previous pack (ready, stale, or half-downloaded) goes first — and its
      // annotation with it (round 1): if createPack then fails, a surviving
      // annotation would seed a lying "ready" for a pack the SDK no longer
      // holds on the next launch AND suppress the R-map-18 re-attempt.
      // Completion rewrites the annotation; failure leaves an honest none.
      await offlineManager.deletePack(name).catch(() => undefined);
      removePackAnnotation(tripId);
      await offlineManager.createPack(
        {
          name,
          styleURL: styleUrl,
          bounds: packBoundsFor(target.destinationLat, target.destinationLng),
          minZoom: OFFLINE_PACK_MIN_ZOOM,
          maxZoom: OFFLINE_PACK_MAX_ZOOM,
          metadata: { tripId },
        },
        (_pack, status) => {
          if (!inFlight.has(tripId)) return; // late event after settle
          if (isDownloadComplete(status)) {
            inFlight.delete(tripId);
            offlineManager.unsubscribe(name);
            const completedAt = new Date().toISOString();
            const sizeBytes = status.completedResourceSize;
            writePackAnnotation({ tripId, styleUrl, regionKey, completedAt, sizeBytes });
            setPackState(tripId, { phase: "ready", sizeBytes, completedAt });
            return;
          }
          setPackState(tripId, {
            phase: "downloading",
            progress: downloadProgressPercent(status),
          });
        },
        (_pack, error) => finishFailed(error.message),
      );
    } catch (error) {
      finishFailed(error instanceof Error ? error.message : "Download failed");
    }
  })();
  return true;
}

/**
 * R-map-20 delete arms: management UI, trip delete/leave hooks, past-trip
 * offer. Removes pack + annotation; state falls to `none`.
 */
export async function deleteTripPack(tripId: string): Promise<void> {
  inFlight.delete(tripId);
  offlineManager.unsubscribe(packNameFor(tripId));
  await offlineManager.deletePack(packNameFor(tripId)).catch(() => undefined);
  removePackAnnotation(tripId);
  setPackState(tripId, NONE);
}

// ---------------------------------------------------------------------------
// Controller hook (pill + settings surfaces)
// ---------------------------------------------------------------------------

/** The trip fields the controller needs (structural — `TripWithRole` fits). */
export interface OfflinePackTrip {
  id: string;
  status: TripStatus;
  destination_lat: number;
  destination_lng: number;
}

/**
 * Mount-point contract (documented interpretation, PR record): R-map-18's
 * activation trigger evaluates wherever this hook mounts — the map pill and
 * the trip-settings management surface. A trip that turns `active` while
 * neither is mounted downloads on the next map/settings visit; a root-layout
 * mount is a one-line follow-up if QA wants literal app-start coverage.
 *
 * Wifi gate (R-map-18): on wifi → download now; connected-but-not-wifi or
 * offline → defer, re-checking on every network-state change while this
 * surface stays mounted ("next wifi + app-active window"). The deferred
 * listener is removed on unmount — no leak, and the latch in
 * `startPackDownload` dedupes the pill + settings surfaces racing the same
 * wifi event.
 *
 * Auto-download reads the phase IMPERATIVELY (not a dep): a manual delete
 * flips state to `none`, and re-running the effect on that change would
 * instantly re-download what the user just deleted.
 */
export function useOfflinePackController(trip: OfflinePackTrip): OfflinePackState {
  const { scheme } = useTheme();
  const styleUrl = mapStyleUrlForScheme(scheme);
  const { id: tripId, status, destination_lat: lat, destination_lng: lng } = trip;
  // The map screen's degrade arm renders with UNUSABLE coords (R-map-1 world
  // fallback) — the region grid throws on them, so the whole machine stands
  // down: no fingerprint, no effects, state pinned to `none`.
  const usable = isUsableDestination(lat, lng);
  const regionKey = usable ? packRegionKeyFor(lat, lng) : "";

  useEffect(() => {
    if (!usable) return;
    const current: PackFingerprint = { styleUrl, regionKey };
    syncPackStateFromAnnotation(tripId, current);
    void runOrphanPackSweep();
    void reconcilePackState(tripId, current);

    if (!shouldAutoDownloadPack({ tripStatus: status, phase: offlinePackStateFor(tripId).phase })) {
      return;
    }
    const target: PackDownloadTarget = {
      tripId,
      destinationLat: lat,
      destinationLng: lng,
      styleUrl,
    };
    let cancelled = false;
    let subscription: { remove: () => void } | undefined;
    void Network.getNetworkStateAsync().then((state) => {
      if (cancelled) return;
      if (isWifiState(state)) {
        startPackDownload(target);
        return;
      }
      subscription = Network.addNetworkStateListener((event) => {
        if (!isWifiState(event)) return;
        if (shouldAutoDownloadPack({ tripStatus: status, phase: offlinePackStateFor(tripId).phase })) {
          startPackDownload(target);
        }
        subscription?.remove();
        subscription = undefined;
      });
    });
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [tripId, status, styleUrl, regionKey, lat, lng, usable]);

  const stored = useOfflinePackStore((state) => state.packs[tripId]);
  // First-frame value before the effect seeds the store: sync MMKV read
  // (house no-flash posture — the settings row never blinks "Not downloaded").
  return useMemo(() => {
    if (!usable) return NONE;
    return stored ?? annotatedPackState(readPackAnnotation(tripId), { styleUrl, regionKey });
  }, [stored, tripId, styleUrl, regionKey, usable]);
}
