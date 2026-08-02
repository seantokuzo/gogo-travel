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
import { ScheduleBookingInputSchema, type Booking, type ScheduleBookingInput } from "@gogo/shared";
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
  tripId: string;
  booking: Booking;
  onClose(): void;
}

/**
 * Inner form, remounted per presented booking (`key` on the call site) so
 * day/time state never leaks across cards.
 */
function ScheduleForm({ tripId, booking, onClose }: ScheduleFormProps) {
  const s = useStyles();
  const [day, setDay] = useState<string>("");
  const [startTime, setStartTime] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const schedule = useScheduleBooking(tripId, {
    // Hook-level seam (superseded-call landmine): fires for EVERY settled
    // call. Rollback is the hook's; this is the visible half.
    onMutationSuccess: () => onClose(),
    onMutationError: () => setError("Couldn't add it to the day — the bucket is unchanged."),
  });

  const timesInverted = startTime !== "" && endTime !== "" && endTime < startTime;

  const confirm = (): void => {
    if (schedule.isPending || day === "") return;
    const candidate: ScheduleBookingInput = {
      day,
      ...(startTime === "" ? {} : { start_time: startTime }),
      ...(endTime === "" ? {} : { end_time: endTime }),
    };
    // Client mirror of the wire schema (trip-new precedent) — the schema
    // stays the single source of truth for the end ≥ start rule.
    const parsed = ScheduleBookingInputSchema.safeParse(candidate);
    if (!parsed.success) return;
    setError(null);
    schedule.mutate({ bookingId: booking.id, input: parsed.data });
  };

  return (
    <View style={s.body}>
      {error !== null ? (
        <ErrorBanner
          message={error}
          onDismiss={() => setError(null)}
          testID="itinerary-ideas-schedule-error"
        />
      ) : null}
      <DateField
        label="Day"
        value={day}
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
        loading={schedule.isPending}
        disabled={day === "" || timesInverted}
        testID="itinerary-ideas-schedule-button-confirm"
      />
    </View>
  );
}

export function ScheduleSheet({ tripId, booking, onClose }: ScheduleSheetProps) {
  return (
    <Sheet
      visible={booking !== null}
      onDismiss={onClose}
      {...(booking !== null ? { title: `Add "${booking.title}" to a day` } : null)}
      testID="itinerary-ideas-schedule-sheet"
    >
      {booking !== null ? (
        <ScheduleForm
          // Remount per booking so field state starts clean (host pattern).
          key={booking.id}
          tripId={tripId}
          booking={booking}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  );
}
