/**
 * Itinerary item detail (T-7.9 / IT-10 — itinerary spec §2.1 PUSH,
 * R-itin-27): the `place_visit` / `custom` counterpart to booking detail.
 * Title + place link, day and times, notes, edit (reopens the form modal
 * prefilled) and delete (ConfirmDialog).
 *
 * BOOKING-KIND ROUTING (R-itin-27, §2.1 verbatim): "`item/[itemId]` receiving
 * a `booking`-kind item REPLACES itself with `booking/[bookingId]` — booking
 * content is never duplicated across two screens." `replace`, not `push`: a
 * push would leave this screen in the back stack, so Back from the booking
 * detail would land here and bounce forward again, trapping the user.
 *
 * The day list and grid already route booking-kind rows straight to booking
 * detail, so this path is the one nothing else covers — a deep link, a stale
 * link, or a row whose parent booking was created between the two reads. It
 * exists precisely because those are the cases that get forgotten.
 *
 * DATA: the composite read (`useItinerary`), not a per-item GET — the API has
 * none (§3.4), and the cache is warm from the tab the user came from. The
 * `item/new` edit path resolves the same way.
 *
 * DELETE is the R-ib-9 endpoint. For the kinds this screen renders it is a
 * plain delete; the unschedule semantics only apply to booking-kind items,
 * which never render here.
 *
 * OFFLINE (R-itin-29): cached items keep rendering with a banner; a failed
 * refetch never blanks a loaded item.
 */
import type { ItineraryItem } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  AppText,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  ListItem,
  PageHeader,
  Skeleton,
} from "@/components";
import { useDeleteItineraryItem, useItinerary, useTripOffline } from "@/data";
import { formatDayHeader } from "@/features/itinerary";
import { jumpToTripTab } from "@/navigation/tab-jump";
import { useTripContext } from "@/navigation/trip-context";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    content: { paddingBottom: t.space[8], gap: t.space[4] },
    block: { paddingHorizontal: t.space[4], gap: t.space[2] },
    banner: { paddingHorizontal: t.space[4] },
    actionRow: { flexDirection: "row", gap: t.space[2], flexWrap: "wrap" },
    state: { flex: 1, justifyContent: "center" },
  }),
);

/**
 * "Mon, Mar 1 · 09:00 – 11:30" — wall values straight off the row (schema
 * §3.3: item day/times are trip-local wall values, no tz math). A spanning
 * item names its end day rather than implying a single date.
 */
export function itemWhenLabel(item: ItineraryItem): string {
  const parts = [formatDayHeader(item.day)];
  if (item.end_day !== null && item.end_day > item.day) {
    parts.push(`through ${formatDayHeader(item.end_day)}`);
  }
  if (item.start_time !== null && item.end_time !== null) {
    parts.push(`${item.start_time} – ${item.end_time}`);
  } else if (item.start_time !== null) {
    parts.push(item.start_time);
  } else if (item.end_time !== null) {
    parts.push(`until ${item.end_time}`);
  } else {
    parts.push("No time set");
  }
  return parts.join(" · ");
}

export default function ItineraryItemScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const navigation = useNavigation();
  const s = useStyles();

  // Repeated query keys arrive as `string[]` and the generic is an unchecked
  // assertion (item/new precedent) — degrade, never index into an array.
  const params = useLocalSearchParams<{ itemId?: string }>();
  const itemId = typeof params.itemId === "string" ? params.itemId : "";

  const itineraryQuery = useItinerary(trip.id);
  const offline = useTripOffline(trip.id);

  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const remove = useDeleteItineraryItem(trip.id, {
    // HOOK-level seam only (superseded-call landmine).
    onMutationError: () => {
      setDeleteOpen(false);
      setActionError("Couldn't delete this item. Try again.");
    },
    onMutationSuccess: () => {
      setDeleteOpen(false);
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: "/[tripId]/itinerary", params: { tripId: trip.id } });
    },
  });

  const item = itineraryQuery.data?.items.find((row) => row.id === itemId);
  const bookingId = item?.kind === "booking" ? item.booking_id : null;

  // R-itin-27 hand-off. In an effect, not in render: navigation is a side
  // effect, and doing it during render double-fires under StrictMode. Keyed on
  // the ids so a resolved hand-off never re-runs.
  useEffect(() => {
    if (bookingId === null) return;
    router.replace({
      pathname: "/[tripId]/itinerary/booking/[bookingId]",
      params: { tripId: trip.id, bookingId },
    });
  }, [bookingId, router, trip.id]);

  const editor = trip.role !== "viewer";
  const settled = itineraryQuery.data !== undefined;

  let body;
  if (bookingId !== null) {
    // The replace is queued; render the neutral hold rather than this item's
    // half-built detail for the frame before it lands.
    body = <Skeleton variant="rect" height={120} testID="itinerary-item-loading" />;
  } else if (!settled) {
    body = itineraryQuery.isError ? (
      <View style={s.banner}>
        <ErrorBanner
          message={
            offline ? "You're offline and this item isn't cached yet." : "Couldn't load this item."
          }
          onRetry={() => void itineraryQuery.refetch()}
          testID="itinerary-item-error"
        />
      </View>
    ) : (
      <View style={s.block} testID="itinerary-item-loading">
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="rect" height={96} />
      </View>
    );
  } else if (item === undefined) {
    body = (
      <View style={s.state}>
        <EmptyState
          icon="alert-circle-outline"
          title="Item not found"
          body="It may have been deleted from the itinerary."
          testID="itinerary-item-missing"
        />
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={s.content}>
        {offline ? (
          <View style={s.banner}>
            <ErrorBanner
              tone="warning"
              message="You're offline — showing the last synced version."
              testID="itinerary-item-banner-offline"
            />
          </View>
        ) : null}
        {itineraryQuery.isError && !offline ? (
          <View style={s.banner}>
            <ErrorBanner
              message="Couldn't refresh the itinerary."
              onRetry={() => void itineraryQuery.refetch()}
              testID="itinerary-item-banner-refresh"
            />
          </View>
        ) : null}
        {actionError !== null ? (
          <View style={s.banner}>
            <ErrorBanner
              message={actionError}
              onDismiss={() => setActionError(null)}
              testID="itinerary-item-banner-action"
            />
          </View>
        ) : null}

        <View style={s.block}>
          <AppText role="label" color="secondary">
            When
          </AppText>
          <AppText testID="itinerary-item-when">{itemWhenLabel(item)}</AppText>
        </View>

        {item.notes !== null && item.notes.trim() !== "" ? (
          <View style={s.block}>
            <AppText role="label" color="secondary">
              Notes
            </AppText>
            <AppText testID="itinerary-item-notes">{item.notes}</AppText>
          </View>
        ) : null}

        {/* Cross-tab: an imperative push at the map tab's URL silently no-ops
            (mobile.md landmine), so this goes through the tab navigator. The
            place SCREEN belongs to the maps spec (§2.10) — and the composite
            read carries no place NAME (T-7.4's documented gap), which is why
            the row is labelled by its destination rather than by the place. */}
        {item.place_id !== null ? (
          <View style={s.block}>
            <ListItem
              title="View place on the map"
              trailing="chevron"
              onPress={() => {
                jumpToTripTab(navigation, trip.id, "map");
              }}
              testID="itinerary-item-row-place"
            />
          </View>
        ) : null}

        {/* R-ib-24: edit and delete are editor/owner writes. */}
        {editor ? (
          <View style={s.block}>
            <View style={s.actionRow}>
              <Button
                title="Edit"
                variant="secondary"
                disabled={remove.isPending}
                onPress={() =>
                  router.push({
                    pathname: "/[tripId]/itinerary/item/new",
                    params: { tripId: trip.id, itemId: item.id },
                  })
                }
                testID="itinerary-item-button-edit"
              />
              <Button
                title="Delete"
                variant="destructive"
                disabled={remove.isPending}
                onPress={() => setDeleteOpen(true)}
                testID="itinerary-item-button-delete"
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <View style={s.screen} testID="itinerary-item-screen">
      <PageHeader
        title={item?.title ?? (item?.kind === "place_visit" ? "Place visit" : "Itinerary item")}
        leading="back"
        testID="itinerary-item-header"
      />
      {body}
      {/* §2.7 rule 4: derives -confirm/-cancel from the TRIGGERING button. */}
      <ConfirmDialog
        visible={deleteOpen}
        title="Delete this item?"
        body="It comes off the day it's planned on. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (remove.isPending || item === undefined) return;
          setActionError(null);
          remove.mutate(item.id);
        }}
        onCancel={() => setDeleteOpen(false)}
        testID="itinerary-item-button-delete"
      />
    </View>
  );
}
