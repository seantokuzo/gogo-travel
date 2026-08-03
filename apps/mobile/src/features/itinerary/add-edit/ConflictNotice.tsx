/**
 * Inline form conflict notice (T-7.5 / IT-4 — R-itin-20, navigation spec
 * §2.4 "conflicts surfaced inline"): the chosen day/times land on top of
 * existing items. NON-BLOCKING — overlaps are legal (API R-ib-17) and save
 * stays enabled; this is information, not validation.
 *
 * Purely DERIVED from the live form state — no dismiss affordance and no
 * latch. The P-6 "conflict latch must be consumed on every terminal path"
 * landmine is about dismissible, armed notices; a notice that is a pure
 * function of the current fields cannot desynchronise from them (edit the
 * time away and it is gone on the next render).
 *
 * testID: `itinerary-item-new-conflict` (§2.9 grammar `<screen>-<element>`;
 * new id — flagged for the §2.9 sync batch).
 */
import { ErrorBanner } from "@/components";

import type { ConflictHit } from "../conflicts";

/** How many conflicting items are named before the notice summarises. */
const NAMED_LIMIT = 3;

export interface ConflictNoticeProps {
  conflicts: readonly ConflictHit[];
  testID?: string;
}

/** "Walk Shibuya (09:00 – 11:30)" — the list card's own time caption. */
function describe(hit: ConflictHit): string {
  return hit.timeLabel === "" ? hit.title : `${hit.title} (${hit.timeLabel})`;
}

export function conflictMessage(conflicts: readonly ConflictHit[]): string {
  const named = conflicts.slice(0, NAMED_LIMIT).map(describe).join(", ");
  const rest = conflicts.length - Math.min(conflicts.length, NAMED_LIMIT);
  const tail = rest > 0 ? ` and ${rest} more` : "";
  return conflicts.length === 1
    ? `Overlaps ${named} — that's allowed, just so you know.`
    : `Overlaps ${named}${tail} — that's allowed, just so you know.`;
}

export function ConflictNotice({ conflicts, testID }: ConflictNoticeProps) {
  if (conflicts.length === 0) return null;
  return (
    <ErrorBanner
      tone="warning"
      message={conflictMessage(conflicts)}
      testID={testID ?? "itinerary-item-new-conflict"}
    />
  );
}
