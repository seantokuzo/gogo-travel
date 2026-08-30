/**
 * Ideas / unscheduled bucket (T-7.6 / IT-5 — itinerary spec §2.3,
 * R-itin-10..12): the collapsible section the itinerary screen pins at its
 * IDEAS BUCKET SEAM, above the day list.
 *
 * Data: consumes the SAME cache entries the screen already mounts
 * (`useItinerary` + `useItineraryBookings` — zero extra requests; bucket
 * membership = zero-item bookings computed client-side, R-ib-10) plus the
 * cancelled list (`useCancelledBookings`, eager: R-itin-12 makes the bucket
 * the ONLY surface for cancelled bookings, so a cancelled-only trip must
 * still grow the entry).
 *
 * Visibility (R-itin-10/12): hidden while the reads are unsettled and when
 * there is nothing to show (no unscheduled, no cancelled). Count badge =
 * unscheduled only (cancelled are hidden behind the foot toggle).
 *
 * Scheduling (R-itin-11): "Add to day" → ScheduleSheet → optimistic
 * schedule (hook-owned). Write affordances are hidden for viewers
 * (R-ib-24 — no guaranteed-403 buttons); cancelled cards never offer
 * scheduling (transitions out of cancelled are ✖, §3.2).
 */
import type { Booking, TripWithRole } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";

import { AppText, Badge, Button, Card, Icon } from "@/components";
import { useCancelledBookings, useItinerary, useItineraryBookings } from "@/data";

import { CATEGORY_ICONS, statusBadgeTone } from "../model";
import {
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
    foot: { paddingVertical: t.space[2], alignItems: "flex-start" },
  }),
);

export function IdeasBucket({ trip, onOpenBooking }: IdeasBucketProps) {
  const s = useStyles();
  const { height: windowHeight } = useWindowDimensions();

  const itineraryQuery = useItinerary(trip.id);
  const bookingsQuery = useItineraryBookings(trip.id);
  const cancelledQuery = useCancelledBookings(trip.id);

  const [expanded, setExpanded] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [scheduleTarget, setScheduleTarget] = useState<Booking | null>(null);

  const unscheduled = useMemo(
    () =>
      unscheduledBookings(bookingsQuery.data?.items ?? [], itineraryQuery.data?.items ?? []),
    [bookingsQuery.data, itineraryQuery.data],
  );
  const cancelled = useMemo(() => cancelledQuery.data?.items ?? [], [cancelledQuery.data]);
  const rows = useMemo(
    () => buildIdeasRows(buildIdeasGroups(unscheduled), cancelled, showCancelled),
    [unscheduled, cancelled, showCancelled],
  );

  // R-itin-10: hidden when empty — and hidden until the reads that decide
  // "empty" have settled (no flash-in). A failed cancelled read degrades to
  // "no cancelled" (its only cost is the toggle).
  //
  // `scheduleTarget === null` is load-bearing (round-1 blocker): scheduling
  // the LAST idea empties `unscheduled` at OPTIMISTIC-write time, which
  // unmounted the bucket AND the in-flight ScheduleSheet with it — a
  // subsequent failure then rolled the card back while its `setError` landed
  // on an unmounted form, so the sheet vanished as-if-success and the card
  // silently reappeared. Staying mounted for the duration of a presented
  // schedule keeps the sheet's documented rollback-visible posture true.
  const settled = itineraryQuery.data !== undefined && bookingsQuery.data !== undefined;
  const empty = unscheduled.length === 0 && cancelled.length === 0 && scheduleTarget === null;
  if (!settled || empty) return null;

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
        testID={`itinerary-ideas-item-${booking.id}`}
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
    <View style={s.container} testID="itinerary-ideas">
      <Pressable
        style={s.header}
        onPress={() => setExpanded((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel={`Ideas, ${unscheduled.length} unscheduled`}
        accessibilityState={{ expanded }}
        testID="itinerary-ideas-toggle"
      >
        <AppText role="subheading" style={s.headerTitle}>
          Ideas
        </AppText>
        <Badge label={String(unscheduled.length)} tone="accent" size="sm" />
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
          testID="itinerary-ideas-list"
          ListFooterComponent={
            cancelled.length > 0 ? (
              <Pressable
                style={s.foot}
                onPress={() => setShowCancelled((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={showCancelled ? "Hide cancelled" : "Show cancelled"}
                testID="itinerary-ideas-show-cancelled"
              >
                <AppText role="caption" color="secondary">
                  {showCancelled
                    ? "Hide cancelled"
                    : `Show cancelled (${cancelled.length})`}
                </AppText>
              </Pressable>
            ) : null
          }
        />
      ) : null}
      <ScheduleSheet
        tripId={trip.id}
        booking={scheduleTarget}
        contextDay={trip.start_date}
        onClose={() => setScheduleTarget(null)}
      />
    </View>
  );
}
