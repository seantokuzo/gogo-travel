/**
 * Foreground location (T-8.3 / MAP-4 — R-map-15..17, map spec §2.6; the
 * P-8 foreground-only LOCK).
 *
 * State machine (module store + module actions, pending-focus pattern):
 *
 *   unknown ──tap──▶ granted ──▶ position acquired ──▶ camera intent armed
 *      │                ▲
 *      ├──tap──▶ undetermined ⇒ RATIONALE dialog ──allow──▶ system prompt
 *      │                                            └─deny/dismiss─▶ (no-op)
 *      └──tap──▶ denied ⇒ SETTINGS dialog (one-tap `Linking.openSettings`)
 *
 * The LOCK, mechanically:
 *  - NOTHING here runs at import or mount — permission is requested only
 *    inside `confirmLocateRationale`, which only a user tap chain reaches
 *    (R-map-16 "no request on mount"; test-pinned).
 *  - Only the FOREGROUND permission APIs are referenced. No background
 *    modes, no `watchPositionAsync` (a single-shot read per locate tap
 *    powers the sheet's distance labels and the camera intent; continuous
 *    updates are the SDK LocationPuck's own concern once the integration
 *    rider mounts it — it manages its native location stream itself).
 *  - The rationale dialog fronts the system prompt (§2.6 "rationale copy
 *    first"); a system denial just records `denied` — the Settings dialog
 *    waits for the NEXT tap, so no prompt chains into another prompt
 *    (R-map-16 "never a repeated prompt loop"; every dialog here is
 *    tap-initiated and dismissible, i.e. non-blocking).
 *  - Position never leaves the device from this module (§2.6: distance
 *    labels are computed on-device; nothing here touches the ApiClient).
 *
 * PUCK + FLY-TO application are screen-side (frozen — PR escalation list):
 * `<LocationPuck>` must be a MapView child and the camera ref is
 * screen-owned. This module owns the full decision surface — the rider
 * renders the puck off `permission === "granted"` and drains the camera
 * intent (`camera-intent.ts`).
 */
import * as Location from "expo-location";
import { create } from "zustand";

import { SINGLE_PIN_ZOOM } from "./camera";
import { setPendingCameraIntent } from "./camera-intent";

/** Locate fly-to zoom (R-map-17) — street-block scale, `camera.ts` kin. */
export const LOCATE_CAMERA_ZOOM = SINGLE_PIN_ZOOM;

export type MapLocationPermission = "unknown" | "undetermined" | "granted" | "denied";
export type MapLocationDialog = "rationale" | "settings" | null;

export interface MapLocationCoordinate {
  lat: number;
  lng: number;
}

interface MapLocationState {
  permission: MapLocationPermission;
  /** Last acquired position — the sheet's distance-label source (§2.3). */
  position: MapLocationCoordinate | null;
  /** A permission/position read is in flight — re-taps are no-ops. */
  busy: boolean;
  dialog: MapLocationDialog;
}

const initialState: MapLocationState = {
  permission: "unknown",
  position: null,
  busy: false,
  dialog: null,
};

/** Reactive handle (button/sheet subscriptions); actions live below. */
export const useMapLocationStore = create<MapLocationState>(() => initialState);

/** Single-shot read + camera intent (module doc — no watch, no background). */
async function acquirePosition(): Promise<void> {
  try {
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const position = { lat: location.coords.latitude, lng: location.coords.longitude };
    useMapLocationStore.setState({ position });
    // R-map-17: fly the camera to the user (screen applies via the rider).
    setPendingCameraIntent({
      center: [position.lng, position.lat],
      zoom: LOCATE_CAMERA_ZOOM,
    });
  } catch {
    // Permission granted but the read failed ⇒ location services are off
    // (or a transient fault) — Settings is the actionable path either way,
    // and the map stays fully functional without the puck (R-map-16).
    useMapLocationStore.setState({ dialog: "settings" });
  }
}

/**
 * Locate-me tap (R-map-16: the FIRST permission touch happens here, never
 * on mount). Granted ⇒ acquire; undetermined ⇒ rationale dialog (the system
 * prompt waits for explicit consent); denied ⇒ Settings dialog.
 */
export async function handleLocatePress(): Promise<void> {
  if (useMapLocationStore.getState().busy) return;
  useMapLocationStore.setState({ busy: true });
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.granted) {
      useMapLocationStore.setState({ permission: "granted" });
      await acquirePosition();
      return;
    }
    if (current.status === Location.PermissionStatus.UNDETERMINED && current.canAskAgain) {
      useMapLocationStore.setState({ permission: "undetermined", dialog: "rationale" });
      return;
    }
    useMapLocationStore.setState({ permission: "denied", dialog: "settings" });
  } finally {
    useMapLocationStore.setState({ busy: false });
  }
}

/**
 * Rationale accepted → the ONE system prompt (R-map-16). A denial records
 * state and stops — the Settings path waits for the next tap (module doc).
 */
export async function confirmLocateRationale(): Promise<void> {
  if (useMapLocationStore.getState().busy) return;
  useMapLocationStore.setState({ dialog: null, busy: true });
  try {
    const response = await Location.requestForegroundPermissionsAsync();
    if (response.granted) {
      useMapLocationStore.setState({ permission: "granted" });
      await acquirePosition();
    } else {
      useMapLocationStore.setState({ permission: "denied" });
    }
  } finally {
    useMapLocationStore.setState({ busy: false });
  }
}

/** Any dialog dismissed without action — nothing changes, nothing re-fires. */
export function dismissLocateDialog(): void {
  useMapLocationStore.setState({ dialog: null });
}

/** Test hygiene (module-scope store — the map-style latch precedent). */
export function resetMapLocationForTests(): void {
  useMapLocationStore.setState(initialState);
}
