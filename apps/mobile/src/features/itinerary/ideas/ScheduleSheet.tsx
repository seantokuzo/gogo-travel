/**
 * "Add to day" day/time picker Sheet (T-7.6 / IT-5 — R-itin-11): schedules a
 * timeless booking via `POST …/schedule` (API R-ib-8) through the OPTIMISTIC
 * `useScheduleBooking` hook — the card moves into its day section with the
 * badge advancing `idea → planned` before the server answers; failure rolls
 * back visibly (hook-owned) and surfaces the sheet's ErrorBanner.
 *
 * Sheet-tax posture (STATE "T-7.8 landmine" — DS Sheet is hit-testable
 * through its ~200ms exit): every affordance is pending-gated — confirm is
 * `loading`-blocked + re-entrance-guarded, and a success closes exactly
 * once via the hook-level seam (never per-call callbacks).
 *
 * testIDs extend the §2.9 ideas family (the sheet's internals are not in
 * the inventory — flagged for the §2.7/§2.9 spec-sync batch):
 * `itinerary-ideas-schedule-sheet`, `…-input-day`, `…-input-start-time`,
 * `…-input-end-time`, `…-button-confirm`, `…-error`.
 */
import {
  ScheduleBookingInputSchema,
  type Booking,
  type ISODate,
  type ScheduleBookingInput,
} from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button, ErrorBanner, Sheet } from "@/components";
import { useScheduleBooking } from "@/data";
import { DateField } from "@/features/trips";

import { TimeField } from "../add-edit/TimeField";

export interface ScheduleSheetProps {
  tripId: string;
  /** Non-null ⇒ presented for this booking. */
  booking: Booking | null;
  /** B-10b: seeds the Day picker (trip start) so it never opens on today. */
  contextDay?: ISODate;
  onClose(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
    times: { flexDirection: "row", gap: t.space[3] },
    timeField: { flex: 1 },
  }),
);

interface ScheduleFormProps {
  pending: boolean;
  error: string | null;
  /** B-10b: passed through to the Day DateField's picker seed. */
  contextDay: ISODate | undefined;
  onDismissError(): void;
  onConfirm(input: ScheduleBookingInput): void;
}

/**
 * Inner FIELDS, remounted per presented booking (`key` on the call site) so
 * day/time state never leaks across cards. The mutation itself lives on the
 * sheet (see `ScheduleSheet`) — the form must not own state the sheet needs
 * in order to gate its own dismissal.
 */
function ScheduleForm({ pending, error, contextDay, onDismissError, onConfirm }: ScheduleFormProps) {
  const s = useStyles();
  const [day, setDay] = useState<string>("");
  const [startTime, setStartTime] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");

  const timesInverted = startTime !== "" && endTime !== "" && endTime < startTime;

  const confirm = (): void => {
    if (pending || day === "") return;
    const candidate: ScheduleBookingInput = {
      day,
      ...(startTime === "" ? {} : { start_time: startTime }),
      ...(endTime === "" ? {} : { end_time: endTime }),
    };
    // Client mirror of the wire schema (trip-new precedent) — the schema
    // stays the single source of truth for the end ≥ start rule.
    const parsed = ScheduleBookingInputSchema.safeParse(candidate);
    if (!parsed.success) return;
    onConfirm(parsed.data);
  };

  return (
    <View style={s.body}>
      {error !== null ? (
        <ErrorBanner
          message={error}
          onDismiss={onDismissError}
          testID="itinerary-ideas-schedule-error"
        />
      ) : null}
      <DateField
        label="Day"
        value={day}
        contextDate={contextDay ?? ""}
        onSelect={setDay}
        testID="itinerary-ideas-schedule-input-day"
      />
      <View style={s.times}>
        <View style={s.timeField}>
          <TimeField
            label="Start time (optional)"
            value={startTime}
            onSelect={setStartTime}
            onClear={() => setStartTime("")}
            testID="itinerary-ideas-schedule-input-start-time"
          />
        </View>
        <View style={s.timeField}>
          <TimeField
            label="End time (optional)"
            value={endTime}
            onSelect={setEndTime}
            onClear={() => setEndTime("")}
            error={timesInverted ? "End time must be after the start time." : undefined}
            testID="itinerary-ideas-schedule-input-end-time"
          />
        </View>
      </View>
      <Button
        title="Add to day"
        onPress={confirm}
        loading={pending}
        disabled={day === "" || timesInverted}
        testID="itinerary-ideas-schedule-button-confirm"
      />
    </View>
  );
}

export function ScheduleSheet({ tripId, booking, contextDay, onClose }: ScheduleSheetProps) {
  const [error, setError] = useState<string | null>(null);

  const schedule = useScheduleBooking(tripId, {
    // Hook-level seam (superseded-call landmine): fires for EVERY settled
    // call. Rollback is the hook's; this is the visible half.
    onMutationSuccess: () => {
      setError(null);
      onClose();
    },
    onMutationError: () => setError("Couldn't add it to the day — the bucket is unchanged."),
  });

  /**
   * Pending-gated chrome (round-2): the DS Sheet's scrim tap, swipe-release,
   * close button and Android back all land here. Un-gated, a dismissal
   * DURING the mutation released the bucket's visibility hold at exactly the
   * moment the optimistic write had emptied `unscheduled` — on a one-idea
   * trip the bucket and this sheet unmounted mid-flight, so the failure's
   * `setError` landed on an unmounted tree: the sheet read as success and
   * the rolled-back card silently reappeared. That is the round-1 blocker
   * through the user-dismissal door; the confirm button was already gated.
   *
   * The gate is LEGIBLE, not silent (`dismissDisabled` renders the close
   * affordance visibly disabled): a swallowed tap with no feedback reads as
   * a frozen app, and every other gated affordance in the DS shows its
   * state.
   *
   * The gate always self-releases (`retry: false` + the ApiClient's abort
   * cap), but the worst case is NOT one `REQUEST_TIMEOUT_MS`: a 401 sends
   * the request through the refresh-and-retry path, and each leg gets a
   * FRESH cap — original + refresh + retry ≈ 3× before `onError` fires. If
   * that window ever needs to shrink, cap it here rather than in the
   * ApiClient (whose per-request bound is deliberate).
   */
  const dismiss = (): void => {
    if (schedule.isPending) return;
    setError(null);
    onClose();
  };

  return (
    <Sheet
      visible={booking !== null}
      onDismiss={dismiss}
      dismissDisabled={schedule.isPending}
      {...(booking !== null ? { title: `Add "${booking.title}" to a day` } : null)}
      testID="itinerary-ideas-schedule-sheet"
    >
      {booking !== null ? (
        <ScheduleForm
          // Remount per booking so field state starts clean (host pattern).
          key={booking.id}
          pending={schedule.isPending}
          error={error}
          contextDay={contextDay}
          onDismissError={() => setError(null)}
          onConfirm={(input) => {
            setError(null);
            schedule.mutate({ bookingId: booking.id, input });
          }}
        />
      ) : null}
    </Sheet>
  );
}
