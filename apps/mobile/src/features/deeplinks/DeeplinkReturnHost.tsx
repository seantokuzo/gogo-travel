/**
 * Return-prompt HOST (T-7.8 / IT-8; §2.8) — the single component a layout
 * mounts to run the whole deeplink-return loop: foreground detection
 * (useDeeplinkReturnPrompt) → "Did you book it?" sheet → the manual-add
 * landing. Mount it ONCE inside trip-aware chrome; the record itself
 * carries the tripId, so a root-level mount works too.
 *
 * NOT WIRED to any screen in T-7.8 (deliberate — this wave is
 * self-contained so W4/W6 surfaces consume it rather than collide with
 * it). CONSUMER SEAMS:
 *  - `onAddManually` (T-7.6): route to the real form modal —
 *    `/[tripId]/itinerary/item/new?category={category}` with the
 *    deeplink-return source — and the built-in ManualAddBookingSheet stops
 *    mounting. Absent, the built-in minimal sheet handles the landing.
 *  - `onForwardEmail` / `onShareScreenshot` (capture bundle, NAV-6): the
 *    prompt's other two actions; disabled until provided.
 *  - `onBookingCreated`: post-create hook (navigate to the booking, toast…).
 *
 * Sheet-transition guard: the DS Sheet is hit-testable through its ~200ms
 * exit animation (P-6 landmine — every sheet consumer needs a pending-gate
 * posture), so each presented record gets ONE action; late taps on the
 * exiting sheet no-op.
 */
import type { Booking } from "@gogo/shared";
import { useEffect, useRef, useState } from "react";

import { ManualAddBookingSheet } from "./ManualAddBookingSheet";
import type { DeeplinkOutRecord } from "./return-prompt-store";
import { ReturnPromptSheet } from "./ReturnPromptSheet";
import { useDeeplinkReturnPrompt } from "./useDeeplinkReturnPrompt";

export interface DeeplinkReturnHostProps {
  /** T-7.6 seam — overrides the built-in minimal landing (module doc). */
  onAddManually?(record: DeeplinkOutRecord): void;
  /** Capture-spec seam (module doc). */
  onForwardEmail?(record: DeeplinkOutRecord): void;
  /** Capture-spec seam (module doc). */
  onShareScreenshot?(record: DeeplinkOutRecord): void;
  onBookingCreated?(booking: Booking): void;
}

export function DeeplinkReturnHost({
  onAddManually,
  onForwardEmail,
  onShareScreenshot,
  onBookingCreated,
}: DeeplinkReturnHostProps) {
  const { record, dismiss } = useDeeplinkReturnPrompt();
  const [manualRecord, setManualRecord] = useState<DeeplinkOutRecord | null>(null);
  const actedRef = useRef(false);

  // A newly presented record re-arms the one-action gate.
  useEffect(() => {
    if (record !== null) actedRef.current = false;
  }, [record]);

  const act = (handler: (record: DeeplinkOutRecord) => void) => {
    return (target: DeeplinkOutRecord): void => {
      if (actedRef.current) return;
      actedRef.current = true;
      handler(target);
    };
  };

  return (
    <>
      <ReturnPromptSheet
        record={record}
        onAddManually={act((target) => {
          dismiss();
          if (onAddManually !== undefined) onAddManually(target);
          else setManualRecord(target);
        })}
        onDismiss={() => {
          actedRef.current = true;
          dismiss();
        }}
        {...(onForwardEmail !== undefined
          ? {
              onForwardEmail: act((target) => {
                dismiss();
                onForwardEmail(target);
              }),
            }
          : null)}
        {...(onShareScreenshot !== undefined
          ? {
              onShareScreenshot: act((target) => {
                dismiss();
                onShareScreenshot(target);
              }),
            }
          : null)}
      />
      {manualRecord !== null ? (
        <ManualAddBookingSheet
          // Remount per record so the title field starts clean.
          key={`${manualRecord.tripId}-${manualRecord.timestamp}`}
          record={manualRecord}
          visible
          onClose={() => setManualRecord(null)}
          {...(onBookingCreated !== undefined ? { onCreated: onBookingCreated } : null)}
        />
      ) : null}
    </>
  );
}
