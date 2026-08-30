/**
 * Ideas / Cancelled bins (T-7.6 / IT-5 — itinerary spec §2.3, R-itin-10..12;
 * reshaped by B-13): the collapsible sections the itinerary screen pins at
 * its IDEAS BUCKET SEAM, above the day list.
 *
 * B-13 (Sean's ruling, device QA 2026-08-29): Ideas and Cancelled are TWO
 * PEER BINS of the same shape, and each renders ONLY when it has contents —
 * an empty bin hides entirely rather than showing an empty box (the old
 * single-container shape put cancelled behind a foot toggle INSIDE the Ideas
 * box, so showing cancelled surfaced an Ideas container with zero ideas).
 * "Hide when empty" is never "hide cancelled": the Cancelled bin exists
 * whenever cancelled bookings exist, and expanding it is the show-cancelled
 * surface (F-043 criterion 3 — a cancelled booking stays reachable, keeping
 * its row and expense links).
 *
 * Data: consumes the SAME cache entries the screen already mounts
 * (`useItinerary` + `useItineraryBookings` — zero extra requests; bucket
 * membership = zero-item bookings computed client-side, R-ib-10) plus the
 * cancelled list (`useCancelledBookings`, eager: R-itin-12 makes these bins
 * the ONLY surface for cancelled bookings, so a cancelled-only trip must
 * still grow the Cancelled bin).
 *
 * Visibility (R-itin-10/12 + B-13): both bins hidden while the reads are
 * unsettled (no flash-in); each bin then renders iff it has contents. A
 * failed cancelled read degrades to "no Cancelled bin".
 *
 * Scheduling (R-itin-11): "Add to day" → ScheduleSheet → optimistic
 * schedule (hook-owned). Write affordances are hidden for viewers
 * (R-ib-24 — no guaranteed-403 buttons); cancelled cards never offer
 * scheduling (transitions out of cancelled are ✖, §3.2).
 */
import type { Booking, TripWithRole } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useMemo, useState, type ReactElement } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";

import { AppText, Badge, Button, Card, Icon } from "@/components";
import { useCancelledBookings, useItinerary, useItineraryBookings } from "@/data";

import { CATEGORY_ICONS, statusBadgeTone } from "../model";
import {
  buildCancelledRows,
  buildIdeasGroups,
  buildIdeasRows,
  formatIdeaPrice,
  unscheduledBookings,
  type IdeasRow,
} from "./ideas-model";
import { ScheduleSheet } from "./ScheduleSheet";

export interface IdeasBucketProps {
  trip: TripWithRole;
  /** Card press → `booking-detail` (§2.3). */
  onOpenBooking(bookingId: string): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: {
      marginHorizontal: t.space[4],
      marginBottom: t.space[2],
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.lg,
      backgroundColor: t.color.bg.surface,
    },
    header: {
      minHeight: t.touchTarget,
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[2],
      paddingHorizontal: t.space[3],
    },
    headerTitle: { flexShrink: 1 },
    headerSpacer: { flex: 1 },
    list: { paddingHorizontal: t.space[3], paddingBottom: t.space[3] },
    groupLabel: { paddingTop: t.space[2], paddingBottom: t.space[1] },
    card: { marginBottom: t.space[2] },
    cardRow: { flexDirection: "row", alignItems: "center", gap: t.space[3] },
    cardBody: { flex: 1, gap: t.space[1] },
    badgeRow: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
  }),
);

interface BinProps {
  /** Header title — the bin's identity ("Ideas" / "Cancelled"). */
  title: string;
  /** Count badge value + tone (Ideas: accent unscheduled; Cancelled: neutral). */
  count: number;
  countTone: "accent" | "neutral";
  accessibilityLabel: string;
  /** testID base: `{testID}` root, `{testID}-toggle`, `{testID}-list`. */
  testID: string;
  rows: IdeasRow[];
  renderRow: (info: { item: IdeasRow }) => ReactElement;
  /** Extra always-mounted children (the Ideas bin hosts the ScheduleSheet). */
  children?: ReactElement | null;
}

/** One collapsible bin — B-13's shared shape, rendered per peer. */
function Bin({
  title,
  count,
  countTone,
  accessibilityLabel,
  testID,
  rows,
  renderRow,
  children,
}: BinProps) {
  const s = useStyles();
  const { height: windowHeight } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={s.container} testID={testID}>
      <Pressable
        style={s.header}
        onPress={() => setExpanded((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded }}
        testID={`${testID}-toggle`}
      >
        <AppText role="subheading" style={s.headerTitle}>
          {title}
        </AppText>
        <Badge label={String(count)} tone={countTone} size="sm" />
        <View style={s.headerSpacer} />
        <Icon name={expanded ? "chevron-up" : "chevron-down"} size={18} />
      </Pressable>
      {expanded ? (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={renderRow}
          style={{ maxHeight: Math.round(windowHeight * 0.45) }}
          contentContainerStyle={s.list}
          testID={`${testID}-list`}
        />
      ) : null}
      {children}
    </View>
  );
}

export function IdeasBucket({ trip, onOpenBooking }: IdeasBucketProps) {
  const s = useStyles();

  const itineraryQuery = useItinerary(trip.id);
  const bookingsQuery = useItineraryBookings(trip.id);
  const cancelledQuery = useCancelledBookings(trip.id);

  const [scheduleTarget, setScheduleTarget] = useState<Booking | null>(null);

  const unscheduled = useMemo(
    () =>
      unscheduledBookings(bookingsQuery.data?.items ?? [], itineraryQuery.data?.items ?? []),
    [bookingsQuery.data, itineraryQuery.data],
  );
  const cancelled = useMemo(() => cancelledQuery.data?.items ?? [], [cancelledQuery.data]);
  const ideasRows = useMemo(() => buildIdeasRows(buildIdeasGroups(unscheduled)), [unscheduled]);
  const cancelledRows = useMemo(() => buildCancelledRows(cancelled), [cancelled]);

  // Hidden until the reads that decide "empty" have settled (no flash-in).
  // A failed cancelled read degrades to "no Cancelled bin" (its only cost).
  //
  // `scheduleTarget === null` is load-bearing (round-1 blocker): scheduling
  // the LAST idea empties `unscheduled` at OPTIMISTIC-write time, which
  // unmounted the bucket AND the in-flight ScheduleSheet with it — a
  // subsequent failure then rolled the card back while its `setError` landed
  // on an unmounted form, so the sheet vanished as-if-success and the card
  // silently reappeared. Staying mounted for the duration of a presented
  // schedule keeps the sheet's documented rollback-visible posture true.
  const settled = itineraryQuery.data !== undefined && bookingsQuery.data !== undefined;
  const showIdeas = unscheduled.length > 0 || scheduleTarget !== null;
  const showCancelledBin = cancelled.length > 0;
  if (!settled || (!showIdeas && !showCancelledBin)) return null;

  const editor = trip.role !== "viewer";

  const renderRow = ({ item }: { item: IdeasRow }) => {
    if (item.type === "group") {
      return (
        <View style={s.groupLabel}>
          <AppText role="caption" color="secondary">
            {item.label}
          </AppText>
        </View>
      );
    }
    const { booking } = item.card;
    return (
      <Card
        variant="inset"
        onPress={() => onOpenBooking(booking.id)}
        style={s.card}
        accessibilityLabel={booking.title}
        testID={
          item.cancelled
            ? `itinerary-cancelled-item-${booking.id}`
            : `itinerary-ideas-item-${booking.id}`
        }
      >
        <View style={s.cardRow}>
          <Icon name={CATEGORY_ICONS[booking.category]} size={20} />
          <View style={s.cardBody}>
            <AppText numberOfLines={1}>{booking.title}</AppText>
            <View style={s.badgeRow}>
              {item.cancelled ? (
                <Badge label="Cancelled" tone="neutral" size="sm" />
              ) : item.card.needsDay ? (
                // R-itin-12: timeless planned/booked — visually distinct.
                <Badge label="Needs a day" tone="warning" size="sm" />
              ) : (
                <Badge label="Idea" tone={statusBadgeTone(booking.status)} size="sm" />
              )}
              {booking.price_cents !== null && booking.currency !== null ? (
                <AppText role="caption" color="secondary">
                  {formatIdeaPrice(booking.price_cents, booking.currency)}
                </AppText>
              ) : null}
            </View>
          </View>
          {editor && !item.cancelled ? (
            <Button
              title="Add to day"
              variant="secondary"
              size="sm"
              onPress={() => setScheduleTarget(booking)}
              testID={`itinerary-ideas-schedule-${booking.id}`}
            />
          ) : null}
        </View>
      </Card>
    );
  };

  return (
    <>
      {showIdeas ? (
        <Bin
          title="Ideas"
          count={unscheduled.length}
          countTone="accent"
          accessibilityLabel={`Ideas, ${unscheduled.length} unscheduled`}
          testID="itinerary-ideas"
          rows={ideasRows}
          renderRow={renderRow}
        >
          <ScheduleSheet
            tripId={trip.id}
            booking={scheduleTarget}
            contextDay={trip.start_date}
            onClose={() => setScheduleTarget(null)}
          />
        </Bin>
      ) : null}
      {showCancelledBin ? (
        <Bin
          title="Cancelled"
          count={cancelled.length}
          countTone="neutral"
          accessibilityLabel={`Cancelled, ${cancelled.length} ${
            cancelled.length === 1 ? "booking" : "bookings"
          }`}
          testID="itinerary-cancelled"
          rows={cancelledRows}
          renderRow={renderRow}
        />
      ) : null}
    </>
  );
}
