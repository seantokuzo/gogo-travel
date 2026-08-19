/**
 * FROZEN SEAM (b) — offline status-pill slot (T-8.2 / MAP-1; filled by
 * **T-8.5**, MAP-5 / R-map-18/21, map spec §2.5).
 *
 * The map screen reserves the pill's position (top overlay, under the day
 * filter); T-8.5 replaces the null render with the pack-status pill
 * (`map-pill-offline`: download progress / failed-with-retry states) WITHOUT
 * touching the screen. Pack state derives from `offlineManager` + the MMKV
 * annotation (§2.5) — all of it T-8.5's; this slot deliberately takes only
 * the trip id so the state machine stays out of the shell.
 *
 * R-map-21 rule for the filler: pack state NEVER blocks map interaction —
 * the pill is informational + retry only.
 */

export interface MapOfflinePillSlotProps {
  tripId: string;
}

export function MapOfflinePillSlot(_props: MapOfflinePillSlotProps): null {
  return null;
}
