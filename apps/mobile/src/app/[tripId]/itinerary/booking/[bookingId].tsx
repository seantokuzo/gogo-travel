/**
 * Booking detail (T-7.9 / IT-9 — itinerary spec §2.1 PUSH, R-itin-24..26).
 * The one screen every booking surface routes to: day-list card, grid block,
 * grid all-day chip, Ideas card, and both synthesized check-in/check-out rows
 * of a spanning lodging (R-itin-31 — one booking, one detail).
 *
 * Composition (R-itin-24, top to bottom): title + status Badge with the §3.2
 * status actions · the category's `details` as a labeled grid · confirmation
 * code with a copy affordance (`mono` role) · price · source label · the three
 * seam rows (place → map tab, expenses → money tab, scheduled day/time → the
 * itinerary position) · the R-itin-25 deeplink-out panel · edit / cancel /
 * delete.
 *
 * WRITES (R-ib-24): every action here is editor/owner — viewers get the read
 * surface with no write affordances at all, never a guaranteed-403 button.
 * The deeplink panel stays for every role: a partner SEARCH is not an API
 * write, it is the same read a viewer could do in a browser.
 *
 * MUTATION POSTURE: status changes and cancel are the same `useUpdateBooking`
 * PATCH (§3.2 side effects are server-derived; the hook reconciles the
 * post-state and — via the frozen `reconcileBookingRow` invariant — REMOVES a
 * newly-cancelled row from the cached default list, which is what takes it off
 * the calendar and into the Ideas bucket's "Show cancelled" view). Side
 * effects ride the HOOK-LEVEL seams only (T-6.8/T-6.9 landmine: TanStack v5
 * drops per-call callbacks for superseded calls), and every action is
 * pending-gated so a second tap cannot supersede the first.
 *
 * OFFLINE (R-itin-29): cached data keeps rendering — a failed refetch never
 * blanks a loaded booking — with an offline banner, and the deeplink-out
 * buttons go disabled with the offline hint.
 */
import type { BookingStatus } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { ApiRequestError } from "@/auth";
import {
  AppText,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  ListItem,
  PageHeader,
  Skeleton,
} from "@/components";
import { useBooking, useDeleteBooking, useTripOffline, useUpdateBooking } from "@/data";
import { DeeplinkPanel } from "@/features/deeplinks";
import {
  BOOKING_SOURCE_LABELS,
  BOOKING_STATUS_LABELS,
  deeplinkInputFor,
  detailFieldRows,
  detailStatusTone,
  formatIdeaPrice,
  kebab,
  scheduleSummary,
  stateFromDetails,
  statusActionsFor,
} from "@/features/itinerary";
import { jumpToTripTab } from "@/navigation/tab-jump";
import { useTripContext } from "@/navigation/trip-context";
import { copyToClipboard } from "@/theme/clipboard";
import { triggerHaptic } from "@/theme/haptics";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    content: { paddingBottom: t.space[8], gap: t.space[4] },
    block: { paddingHorizontal: t.space[4], gap: t.space[2] },
    banner: { paddingHorizontal: t.space[4] },
    statusRow: { flexDirection: "row", alignItems: "center", gap: t.space[2], flexWrap: "wrap" },
    actionRow: { flexDirection: "row", gap: t.space[2], flexWrap: "wrap" },
    fieldRow: { gap: 2 },
    code: { flexDirection: "row", alignItems: "center", gap: t.space[3] },
    codeText: { flex: 1 },
    state: { flex: 1, justifyContent: "center" },
  }),
);

/** Section wrapper — a caption label over its rows (used for every block). */
function Section({ label, children }: { label: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <View style={s.block}>
      <AppText role="label" color="secondary">
        {label}
      </AppText>
      {children}
    </View>
  );
}

export default function BookingDetailScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const navigation = useNavigation();
  const s = useStyles();

  // expo-router hands back `string[]` for a REPEATED query key and the
  // generic is an unchecked assertion (the item/new precedent) — a mangled
  // deep link must degrade to "no booking", never index into an array.
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const bookingId = typeof params.bookingId === "string" ? params.bookingId : "";

  const bookingQuery = useBooking(trip.id, bookingId, { enabled: bookingId !== "" });
  const offline = useTripOffline(trip.id);

  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The VALUE that was copied, not a boolean: "Copied" is a claim about the
  // code on screen, and an edit that changes the code must put the affordance
  // back to "Copy" — the clipboard still holds the old value.
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const update = useUpdateBooking(trip.id, {
    // HOOK-level seam — fires for EVERY settled call (superseded-call law).
    onMutationError: () => setActionError("Couldn't update this booking. Try again."),
    onMutationSuccess: () => {
      setActionError(null);
      setCancelOpen(false);
    },
  });
  const remove = useDeleteBooking(trip.id, {
    onMutationError: () => {
      setDeleteOpen(false);
      setActionError("Couldn't delete this booking. Try again.");
    },
    onMutationSuccess: () => {
      setDeleteOpen(false);
      // The row this screen renders is gone — never leave the user looking at
      // a deleted booking (its next refetch would 404).
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: "/[tripId]/itinerary", params: { tripId: trip.id } });
    },
  });

  const busy = update.isPending || remove.isPending;
  const editor = trip.role !== "viewer";
  const booking = bookingQuery.data;
  const copied =
    booking !== undefined &&
    booking.confirmation_code !== null &&
    booking.confirmation_code === copiedCode;

  const is404 = bookingQuery.error instanceof ApiRequestError && bookingQuery.error.status === 404;

  const applyStatus = (status: BookingStatus): void => {
    if (busy) return;
    setActionError(null);
    update.mutate({ bookingId, input: { status } });
  };

  const copyCode = (code: string): void => {
    copyToClipboard(code);
    triggerHaptic("selection");
    setCopiedCode(code);
  };

  let body: ReactNode;
  if (bookingId === "" || is404) {
    body = (
      <View style={s.state}>
        <EmptyState
          icon="alert-circle-outline"
          title="Booking not found"
          body="It may have been deleted, or the link is no longer valid."
          testID="booking-detail-missing"
        />
      </View>
    );
  } else if (booking === undefined) {
    // Error BEFORE data (nothing to retain): retry surface. A failure over
    // RETAINED data falls through to the loaded branch with a banner — the
    // T-6.7 error-precedence posture, and R-itin-29's "render from cache".
    body = bookingQuery.isError ? (
      <View style={s.banner}>
        <ErrorBanner
          message={
            offline
              ? "You're offline and this booking isn't cached yet."
              : "Couldn't load this booking."
          }
          onRetry={() => void bookingQuery.refetch()}
          testID="booking-detail-error"
        />
      </View>
    ) : (
      <View style={s.block} testID="booking-detail-loading">
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="rect" height={120} />
        <Skeleton variant="rect" height={96} />
      </View>
    );
  } else {
    const fields = detailFieldRows(booking.details);
    const schedule = scheduleSummary(booking.items);
    const transitions = statusActionsFor(booking.status);
    return (
      <View style={s.screen} testID="booking-detail-screen">
        <PageHeader title={booking.title} leading="back" testID="booking-detail-header" />
        <ScrollView contentContainerStyle={s.content}>
          {offline ? (
            <View style={s.banner}>
              {/* R-itin-29: informational, NOT an error — the data below is
                  real, just not fresh. `onRetry` would be a lie while the
                  transport is down. */}
              <ErrorBanner
                tone="warning"
                message="You're offline — showing the last synced version."
                testID="booking-detail-banner-offline"
              />
            </View>
          ) : null}
          {bookingQuery.isError && !offline ? (
            <View style={s.banner}>
              <ErrorBanner
                message="Couldn't refresh this booking."
                onRetry={() => void bookingQuery.refetch()}
                testID="booking-detail-banner-refresh"
              />
            </View>
          ) : null}
          {actionError !== null ? (
            <View style={s.banner}>
              <ErrorBanner
                message={actionError}
                onDismiss={() => setActionError(null)}
                testID="booking-detail-banner-action"
              />
            </View>
          ) : null}

          <Section label="Status">
            <View style={s.statusRow}>
              <Badge
                label={BOOKING_STATUS_LABELS[booking.status]}
                tone={detailStatusTone(booking.status)}
                testID="booking-detail-status"
              />
              {booking.price_cents !== null && booking.currency !== null ? (
                <AppText role="caption" color="secondary" testID="booking-detail-price">
                  {formatIdeaPrice(booking.price_cents, booking.currency)}
                </AppText>
              ) : null}
            </View>
            {/* §3.2 transitions as buttons. Viewers get none (R-ib-24), a
                cancelled booking has none (terminal), and every one is
                pending-gated. `→ cancelled` is NOT here — R-itin-26 gives it
                a ConfirmDialog. */}
            {editor && transitions.length > 0 ? (
              <View style={s.actionRow}>
                {transitions.map((status) => (
                  <Button
                    key={status}
                    title={`Mark ${BOOKING_STATUS_LABELS[status].toLowerCase()}`}
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onPress={() => applyStatus(status)}
                    testID={`booking-detail-button-status-${status}`}
                  />
                ))}
              </View>
            ) : null}
            <AppText role="caption" color="secondary" testID="booking-detail-source">
              {BOOKING_SOURCE_LABELS[booking.source]}
            </AppText>
          </Section>

          {fields.length > 0 ? (
            <Section label="Details">
              {fields.map((field) => (
                <View
                  key={field.key}
                  style={s.fieldRow}
                  // §2.9 grammar: qualifiers are kebab-case — the SAME `kebab`
                  // the form's inputs run this key through (one id family).
                  testID={`booking-detail-field-${kebab(field.key)}`}
                >
                  <AppText role="caption" color="secondary">
                    {field.label}
                  </AppText>
                  <AppText>{field.value}</AppText>
                </View>
              ))}
            </Section>
          ) : null}

          {booking.confirmation_code !== null ? (
            <Section label="Confirmation">
              <View style={s.code}>
                {/* R-itin-24: `mono` type role — confirmation codes are
                    transcribed character by character. */}
                <AppText role="mono" style={s.codeText} testID="booking-detail-confirmation">
                  {booking.confirmation_code}
                </AppText>
                <Button
                  title={copied ? "Copied" : "Copy"}
                  variant="secondary"
                  size="sm"
                  icon={copied ? "checkmark" : "copy-outline"}
                  onPress={() => copyCode(booking.confirmation_code ?? "")}
                  testID="booking-detail-button-copy-confirmation"
                />
              </View>
            </Section>
          ) : null}

          <Section label="Linked">
            {/* SEAM ROWS (R-itin-24). Place and expenses cross tabs, so they
                go through `jumpToTripTab` — an imperative push at another
                tab's URL silently no-ops (mobile.md landmine). Their
                DESTINATION screens belong to the maps and money specs
                (§2.10); this spec only links into them. */}
            {booking.place_id !== null ? (
              <ListItem
                title="View place on the map"
                trailing="chevron"
                onPress={() => {
                  jumpToTripTab(navigation, trip.id, "map");
                }}
                testID="booking-detail-row-place"
              />
            ) : null}
            <ListItem
              title="Linked expenses"
              subtitle="Track what this cost in the money tab"
              trailing="chevron"
              onPress={() => {
                jumpToTripTab(navigation, trip.id, "money");
              }}
              testID="booking-detail-row-expenses"
            />
            {schedule !== null ? (
              <ListItem
                title="On the calendar"
                subtitle={schedule.label}
                trailing="chevron"
                onPress={() => {
                  // Same tab, same stack — `navigate` pops back to the list
                  // that is already mounted beneath this push, with the day
                  // to scroll to (R-itin-24 "jumps to the itinerary position").
                  router.navigate({
                    pathname: "/[tripId]/itinerary",
                    params: { tripId: trip.id, day: schedule.day },
                  });
                }}
                testID="booking-detail-row-schedule"
              />
            ) : (
              <ListItem
                title="Not on the calendar"
                subtitle={
                  booking.status === "cancelled"
                    ? "Cancelled bookings are kept out of the plan."
                    : "It's in your Ideas bucket until you give it a day."
                }
                testID="booking-detail-row-schedule"
              />
            )}
          </Section>

          {/* R-itin-25: the SAME construction + recording rules as the form's
              panel (R-itin-21/22) — the panel owns all of it; this screen
              only supplies the booking's own fields. `stateFromDetails`
              round-trips the stored details through the form's state shape,
              so one mapping serves both surfaces. */}
          <View style={s.block}>
            <DeeplinkPanel
              tripId={trip.id}
              surface="detail"
              input={deeplinkInputFor(booking.category, stateFromDetails(booking.details))}
              destinationName={trip.destination_name}
              offline={offline}
              // R-ib-24: a viewer's hop must not arm the return prompt — its
              // "Add it manually" lands on a form that blocks viewers.
              recordDisabled={!editor}
            />
          </View>

          {editor ? (
            <View style={s.block}>
              <View style={s.actionRow}>
                <Button
                  title="Edit"
                  variant="secondary"
                  disabled={busy}
                  onPress={() =>
                    router.push({
                      pathname: "/[tripId]/itinerary/item/new",
                      params: { tripId: trip.id, bookingId: booking.id },
                    })
                  }
                  testID="booking-detail-button-edit"
                />
                {/* Terminal state: §3.2 has no transition OUT of cancelled, so
                    the action would be a guaranteed 400. */}
                {booking.status !== "cancelled" ? (
                  <Button
                    title="Cancel booking"
                    variant="secondary"
                    disabled={busy}
                    onPress={() => setCancelOpen(true)}
                    testID="booking-detail-button-cancel"
                  />
                ) : null}
                <Button
                  title="Delete"
                  variant="destructive"
                  disabled={busy}
                  onPress={() => setDeleteOpen(true)}
                  testID="booking-detail-button-delete"
                />
              </View>
            </View>
          ) : null}
        </ScrollView>

        {/* §2.7 rule 4 (trip-settings precedent): a dialog derives its
            -confirm/-cancel ids from the TRIGGERING button's id. */}
        <ConfirmDialog
          visible={cancelOpen}
          title="Cancel this booking?"
          body="It comes off the calendar and moves under “Show cancelled” in Ideas. Cancelling can't be undone."
          confirmLabel="Cancel booking"
          cancelLabel="Keep it"
          destructive
          onConfirm={() => applyStatus("cancelled")}
          onCancel={() => setCancelOpen(false)}
          testID="booking-detail-button-cancel"
        />
        <ConfirmDialog
          visible={deleteOpen}
          title="Delete this booking?"
          body="This removes the booking and its calendar entries. Linked expenses are KEPT — they detach from the booking and stay in your money tab."
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            if (busy) return;
            setActionError(null);
            remove.mutate(booking.id);
          }}
          onCancel={() => setDeleteOpen(false)}
          testID="booking-detail-button-delete"
        />
      </View>
    );
  }

  return (
    <View style={s.screen} testID="booking-detail-screen">
      <PageHeader title="Booking" leading="back" testID="booking-detail-header" />
      {body}
    </View>
  );
}
