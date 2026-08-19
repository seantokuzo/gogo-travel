/**
 * MMKV pack annotation (T-8.5 / MAP-5 — map spec §2.5): the small device-local
 * record beside each offline pack. The SDK owns pack EXISTENCE; this record
 * owns what the SDK doesn't keep — trip ↔ pack mapping, completion stamp,
 * and the style/region fingerprint stale-detection compares against.
 *
 * House MMKV pattern (view-mode.ts / last-viewed-trip.ts): default instance,
 * namespaced keys, sync reads (the pill renders pack state on first frame,
 * no async hydration), jest gets the package's in-memory mock automatically.
 *
 * Values are JSON; a corrupt or shape-drifted record reads as ABSENT (the
 * controller's reconcile then treats the pack as unannotated and re-derives
 * or sweeps — never a crash on a bad byte).
 */
import { createMMKV } from "react-native-mmkv";

import type { OfflinePackAnnotation } from "./offline-packs";

const storage = createMMKV();

const KEY_PREFIX = "gogo.offlinePack.";

const keyFor = (tripId: string): string => `${KEY_PREFIX}${tripId}`;

function isAnnotation(value: unknown): value is OfflinePackAnnotation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tripId === "string" &&
    typeof record.styleUrl === "string" &&
    typeof record.regionKey === "string" &&
    typeof record.completedAt === "string" &&
    typeof record.sizeBytes === "number"
  );
}

/** The annotation for a trip's pack, or undefined (absent or corrupt). */
export function readPackAnnotation(tripId: string): OfflinePackAnnotation | undefined {
  const raw = storage.getString(keyFor(tripId));
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAnnotation(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Written exactly once per completed download (controller's complete arm). */
export function writePackAnnotation(annotation: OfflinePackAnnotation): void {
  storage.set(keyFor(annotation.tripId), JSON.stringify(annotation));
}

/** Removed with the pack (delete / purge / sweep — hygiene, R-map-20). */
export function removePackAnnotation(tripId: string): void {
  storage.remove(keyFor(tripId));
}

/** Every annotated trip's record — the purge planner's candidate source. */
export function listPackAnnotations(): OfflinePackAnnotation[] {
  return storage
    .getAllKeys()
    .filter((key) => key.startsWith(KEY_PREFIX))
    .map((key) => readPackAnnotation(key.slice(KEY_PREFIX.length)))
    .filter((annotation): annotation is OfflinePackAnnotation => annotation !== undefined);
}

/** Test-only: wipe every annotation (jest's in-memory MMKV persists per file). */
export function clearPackAnnotationsForTests(): void {
  for (const key of storage.getAllKeys()) {
    if (key.startsWith(KEY_PREFIX)) storage.remove(key);
  }
}
