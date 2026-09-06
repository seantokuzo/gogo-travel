/**
 * usePickerFocus (B-15d) — exclusive-open coordination for the picker field
 * family (DateField/TimeField). Device QA 2026-09-06: with the pre-B-15b
 * inline spinner, several pickers could sit open at once (both time
 * spinners, or a spinner still open under the date modal). Exclusivity
 * lives at the STATE level in the components, not in the presentation
 * layer: Android's native dialogs and any future inline display need it
 * even though the iOS modal card now covers the screen and blocks most
 * double-open paths by construction.
 *
 * One claimant at a time: a picker claims on open, and the claim CLOSES the
 * previous claimant. Module-level, not context — the fields render under
 * arbitrary parents (trip forms, item forms, ScheduleSheet) and a provider
 * requirement would leak into every caller for a single-slot invariant.
 * Unmount/close releases only a claim that is still the field's own, so a
 * successor's claim is never clobbered by the loser's teardown.
 */
import { useEffect } from "react";

let current: (() => void) | null = null;

export function usePickerFocus(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    if (current !== null && current !== close) current();
    current = close;
    return () => {
      if (current === close) current = null;
    };
  }, [open, close]);
}
