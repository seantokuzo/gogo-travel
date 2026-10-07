/**
 * Status-action Sheet (T-7.15 / R-itin-11, R-itin-40/41 — reworked from the
 * T-7.6 "Add to day" picker): the Ideas bucket's "Planned" / "Booked" taps
 * land here. ONE sheet, TWO routes (`statusActionRoute` — the server's own
 * known-times discriminator), both through OPTIMISTIC hooks so the card moves
 * into its day with the badge advancing before the server answers; failure
 * rolls back visibly (hook-owned) and surfaces here.
 *
 *  - TIMELESS booking → day/time pickers (day required, times optional),
 *    confirm calls `POST …/schedule` with the day/times and the status
 *    `scheduleStatusToSend` allows (`useScheduleBooking`; API R-ib-8 as
 *    extended by T-7.10): only an ADVANCING "Booked" rides the wire —
 *    "Planned" and same-status taps omit it, so a stale cache can never
 *    cause a server-side demotion.
 *  - KNOWN-TIMES booking (the pre-existing B-16 dead end: the schedule
 *    endpoint always rejected these) → the booking's own start/end render
 *    READ-ONLY with a "change it on the booking itself" hint (R-ib-16
 *    parity) and confirm applies ONLY a status PATCH (`useSetBookingStatus`);
 *    the booking service's I-2 auto-item supplies the calendar row.
 *
 * Validation is inline (R-itin-41): an empty day and an end before its start
 * each show their own error under the field and block confirm. END == START
 * is valid (the wire rule is strict `end < start`). A server refusal maps
 * onto the field that owns it (`statusActionFailure`): `status` has no input
 * of its own, so the sheet renders a read-only Status row that gives the
 * reason a home — a refused status is never an anonymous banner.
 *
 * Sheet-tax posture (STATE "T-7.8 landmine" — DS Sheet is hit-testable
 * through its ~200ms exit): every affordance is pending-gated — confirm is
 * `loading`-blocked + re-entrance-guarded, the chrome's dismissal is gated,
 * and a success closes exactly once via the hook-level seam (never per-call
 * callbacks).
 *
 * B-16 prefill (kept): a TIMELESS booking whose details carry only a partial
 * date/time (an end with no start) opens with them as the pickers' VALUES
 * (`schedulePrefill`). The known-times case no longer needs it — those take
 * the read-only route.
 *
 * testIDs extend the §2.9 ideas family — `itinerary-ideas-schedule-sheet`,
 * `…-input-day`, `…-input-start-time`, `…-input-end-time`, `…-button-confirm`,
 * `…-error` (existing) plus, flagged for the §2.7/§2.9 spec-sync batch:
 * `…-status`, `…-status-error`, `…-readonly-start`, `…-readonly-end`,
 * `…-hint` (the known-times route's read-only rows).
 */
import type { ISODate } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, ErrorBanner, Sheet } from "@/components";
import { useScheduleBooking, useSetBookingStatus } from "@/data/bookings";
import { DateField, formatFieldDate } from "@/features/trips";

import { TimeField } from "../add-edit/TimeField";
import {
  buildStatusActionRequest,
  knownTimesSummary,
  schedulePrefill,
  STATUS_ACTION_LABELS,
  statusActionCopy,
  statusActionFailure,
  statusActionRoute,
  validateScheduleForm,
  type StatusAction,
  type StatusActionFailure,
  type StatusActionRequest,
} from "./ideas-model";

export interface ScheduleSheetProps {
  tripId: string;
  /** Non-null ⇒ presented for this card + tapped status. */
  action: StatusAction | null;
  /** B-10b: seeds the Day picker (trip start) so it never opens on today. */
  contextDay?: ISODate;
  onClose(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
    times: { flexDirection: "row", gap: t.space[3] },
    timeField: { flex: 1 },
    readonlyRow: { gap: t.space[1] },
    statusRow: { gap: t.space[1] },
    errorText: { color: t.color.status.danger.fg },
  }),
);

interface StatusActionFormProps {
  action: StatusAction;
  pending: boolean;
  failure: StatusActionFailure | null;
  /** B-10b: passed through to the Day DateField's picker seed. */
  contextDay: ISODate | undefined;
  /** Any field edit retires the previous attempt's server reasons. */
  onEdit(): void;
  onDismissBanner(): void;
  onConfirm(request: StatusActionRequest): void;
}

/**
 * Inner FIELDS, remounted per presented action (`key` on the call site) so
 * day/time state never leaks across cards or targets. The mutations live on
 * the sheet (see `ScheduleSheet`) — the form must not own state the sheet
 * needs in order to gate its own dismissal.
 */
function StatusActionForm({
  action,
  pending,
  failure,
  contextDay,
  onEdit,
  onDismissBanner,
  onConfirm,
}: StatusActionFormProps) {
  const s = useStyles();
  const { booking, target } = action;
  const route = statusActionRoute(booking);
  // B-16: initial-only by design — the form remounts per action (`key`), so
  // these seed `useState` and the user keeps full control afterwards.
  const prefill = schedulePrefill(booking);
  const [day, setDay] = useState<string>(prefill.day);
  const [startTime, setStartTime] = useState<string>(prefill.startTime);
  const [endTime, setEndTime] = useState<string>(prefill.endTime);

  const form = { day, startTime, endTime };
  // R-itin-41 inline validation — schedule route only (the status route's
  // day/times are the booking's own and read-only).
  const errors = route === "schedule" ? validateScheduleForm(form) : {};
  const blocked = Object.keys(errors).length > 0;
  const copy = statusActionCopy(booking, target);

  const confirm = (): void => {
    if (pending) return;
    const request = buildStatusActionRequest(booking, target, form);
    if (request === null) return;
    onConfirm(request);
  };

  const fieldErrors = failure?.fieldErrors ?? {};
  const known = route === "status" ? knownTimesSummary(booking) : [];

  return (
    <View style={s.body}>
      {failure?.banner != null ? (
        <ErrorBanner
          message={failure.banner}
          onDismiss={onDismissBanner}
          testID="itinerary-ideas-schedule-error"
        />
      ) : null}
      {route === "schedule" ? (
        <>
          <DateField
            label="Day"
            value={day}
            contextDate={contextDay ?? ""}
            onSelect={(next) => {
              onEdit();
              setDay(next);
            }}
            {...(fieldErrors.day !== undefined || errors.day !== undefined
              ? { error: fieldErrors.day ?? errors.day ?? "" }
              : null)}
            testID="itinerary-ideas-schedule-input-day"
          />
          <View style={s.times}>
            <View style={s.timeField}>
              <TimeField
                label="Start time (optional)"
                value={startTime}
                onSelect={(next) => {
                  onEdit();
                  setStartTime(next);
                }}
                onClear={() => {
                  onEdit();
                  setStartTime("");
                }}
                {...(fieldErrors.startTime !== undefined ? { error: fieldErrors.startTime } : null)}
                testID="itinerary-ideas-schedule-input-start-time"
              />
            </View>
            <View style={s.timeField}>
              <TimeField
                label="End time (optional)"
                value={endTime}
                onSelect={(next) => {
                  onEdit();
                  setEndTime(next);
                }}
                onClear={() => {
                  onEdit();
                  setEndTime("");
                }}
                {...(fieldErrors.endTime !== undefined || errors.endTime !== undefined
                  ? { error: fieldErrors.endTime ?? errors.endTime ?? "" }
                  : null)}
                testID="itinerary-ideas-schedule-input-end-time"
              />
            </View>
          </View>
        </>
      ) : (
        <>
          {known.map((line) => (
            <View
              key={line.label}
              style={s.readonlyRow}
              accessible
              accessibilityLabel={`${line.label}, ${formatFieldDate(line.day)} at ${line.time}`}
              testID={`itinerary-ideas-schedule-readonly-${line.label === "Starts" ? "start" : "end"}`}
            >
              <AppText role="caption" color="secondary">
                {line.label}
              </AppText>
              <AppText>{`${formatFieldDate(line.day)} · ${line.time}`}</AppText>
            </View>
          ))}
          <AppText role="caption" color="secondary" testID="itinerary-ideas-schedule-hint">
            Its date and times come from the booking. To change them, edit the booking itself.
          </AppText>
        </>
      )}
      <View style={s.statusRow} testID="itinerary-ideas-schedule-status">
        <AppText role="caption" color="secondary">
          Status
        </AppText>
        <AppText>{STATUS_ACTION_LABELS[target]}</AppText>
        {fieldErrors.status !== undefined ? (
          <AppText
            role="caption"
            style={s.errorText}
            accessibilityLiveRegion="polite"
            testID="itinerary-ideas-schedule-status-error"
          >
            {fieldErrors.status}
          </AppText>
        ) : null}
      </View>
      <Button
        title={copy.confirmLabel}
        onPress={confirm}
        loading={pending}
        disabled={blocked}
        testID="itinerary-ideas-schedule-button-confirm"
      />
    </View>
  );
}

export function ScheduleSheet({ tripId, action, contextDay, onClose }: ScheduleSheetProps) {
  const [failure, setFailure] = useState<StatusActionFailure | null>(null);

  // Hook-level seam (superseded-call landmine): fires for EVERY settled call
  // of EITHER route. Rollback is the hook's; this is the visible half.
  const seam = {
    onMutationSuccess: () => {
      setFailure(null);
      onClose();
    },
    onMutationError: (error: unknown) => setFailure(statusActionFailure(error)),
  };
  const schedule = useScheduleBooking(tripId, seam);
  const setStatus = useSetBookingStatus(tripId, seam);
  const pending = schedule.isPending || setStatus.isPending;

  /**
   * Pending-gated chrome (round-2): the DS Sheet's scrim tap, swipe-release,
   * close button and Android back all land here. Un-gated, a dismissal
   * DURING the mutation released the bucket's visibility hold at exactly the
   * moment the optimistic write had emptied `unscheduled` — on a one-idea
   * trip the bucket and this sheet unmounted mid-flight, so the failure's
   * state landed on an unmounted tree: the sheet read as success and the
   * rolled-back card silently reappeared. That is the round-1 blocker
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
   *
   * Dismissing an untouched sheet sends NOTHING (R-itin-40: "ideas without a
   * day stay legal and untouched") — no request exists until confirm.
   */
  const dismiss = (): void => {
    if (pending) return;
    setFailure(null);
    onClose();
  };

  const send = (request: StatusActionRequest): void => {
    if (action === null) return;
    setFailure(null);
    if (request.route === "status") {
      setStatus.mutate({ bookingId: action.booking.id, status: request.input.status });
    } else {
      schedule.mutate({ bookingId: action.booking.id, input: request.input });
    }
  };

  return (
    <Sheet
      visible={action !== null}
      onDismiss={dismiss}
      dismissDisabled={pending}
      {...(action !== null
        ? { title: statusActionCopy(action.booking, action.target).title }
        : null)}
      testID="itinerary-ideas-schedule-sheet"
    >
      {action !== null ? (
        <StatusActionForm
          // Remount per card AND target so field state starts clean (host
          // pattern); the remount is also what applies each booking's prefill.
          key={`${action.booking.id}:${action.target}`}
          action={action}
          pending={pending}
          failure={failure}
          contextDay={contextDay}
          onEdit={() => setFailure(null)}
          onDismissBanner={() =>
            setFailure((prev) => (prev === null ? prev : { ...prev, banner: null }))
          }
          onConfirm={send}
        />
      ) : null}
    </Sheet>
  );
}
