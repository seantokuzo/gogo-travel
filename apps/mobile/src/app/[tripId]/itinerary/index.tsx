/**
 * Itinerary tab — plan mode (T-7.4 / IT-1+IT-2; itinerary spec §2.2).
 *
 * Composition, top to bottom: PageHeader (trip name; trailing view toggle,
 * R-itin-9) · [IDEAS BUCKET SEAM — T-7.6 renders its collapsible section
 * here, above the day list, per §2.3] · day-jump strip · day list (or the
 * grid shell) · FAB. States per R-itin-28: skeleton day sections while the
 * composite read + booking enrichment settle, EmptyState when the trip has
 * zero items AND zero unscheduled bookings, ErrorBanner with retry on fetch
 * failure (loaded rows are retained under a later refetch error — the T-6.7
 * error-precedence posture).
 *
 * Reorder (IT-2): the list's `onReorder` resolves through `resolveDrop` —
 * commit fires ONE optimistic day-order PUT for the target day (R-itin-2,
 * §2.2 "the PUT reassigns the day"), a day-locked cross-day drop is refused
 * client-side with the R-itin-3 hint (the server 400s it regardless), and a
 * failed PUT rolls the cache back visibly + shows an ErrorBanner via the
 * hook-level seam (never per-call callbacks — the T-6.8/T-6.9 landmine).
 * Drag is pending-gated while a PUT is in flight and disabled for viewers
 * (writes are editor/owner, R-ib-24 — no guaranteed-403 affordance).
 *
 * View toggle (R-itin-9): list ↔ grid, persisted per trip (MMKV). Grid
 * renders through the FROZEN GridSurface seam (features/itinerary) — T-7.7
 * fills its internals; this screen never changes for it (W4 boundary:
 * T-7.6 owns this file, T-7.7 owns GridSurface + grid/*).
 *
 * The whole screen sits in a `GestureHandlerRootView` — drag gestures
 * (react-native-reorderable-list) only work inside one, and the app root
 * doesn't mount it.
 */
import type { Booking } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { EmptyState, ErrorBanner, PageHeader, Skeleton } from "@/components";
import { useDayOrder, useItinerary, useItineraryBookings } from "@/data";
import {
  AddOptionsSheet,
  addOptionSlug,
  BOOKING_DAY_LOCK_HINT,
  buildDayRows,
  DayJumpStrip,
  GridSurface,
  IdeasBucket,
  ItineraryDayList,
  readItineraryViewMode,
  resolveDrop,
  storeItineraryViewMode,
  type DayEntry,
  type ItineraryDayListHandle,
  type ItineraryViewMode,
} from "@/features/itinerary";
import { Fab } from "@/features/trips";
import { useTripContext } from "@/navigation/trip-context";
import { triggerHaptic } from "@/theme/haptics";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    banner: { paddingHorizontal: t.space[4], paddingBottom: t.space[2] },
    body: { flex: 1 },
    skeleton: { paddingHorizontal: t.space[4], gap: t.space[3], paddingTop: t.space[4] },
    skeletonSection: { gap: t.space[2] },
    state: { flex: 1, justifyContent: "center" },
  }),
);

type ReorderNotice = "day-lock" | "reorder-failed" | null;

/** R-itin-28 skeleton — three ghost day sections (R-ds-15). */
function SkeletonDays() {
  const s = useStyles();
  return (
    <View style={s.skeleton} testID="itinerary-loading">
      {[0, 1, 2].map((section) => (
        <View key={section} style={s.skeletonSection}>
          <Skeleton variant="text" width="40%" />
          <Skeleton variant="rect" height={64} />
          <Skeleton variant="rect" height={64} />
        </View>
      ))}
    </View>
  );
}

export default function ItineraryScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const s = useStyles();

  const itineraryQuery = useItinerary(trip.id);
  const bookingsQuery = useItineraryBookings(trip.id);

  const [mode, setMode] = useState<ItineraryViewMode>(() => readItineraryViewMode(trip.id));
  const [notice, setNotice] = useState<ReorderNotice>(null);
  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const listHandle = useRef<ItineraryDayListHandle>(null);

  // R-ib-24 client half: writes are editor/owner — viewers get no add
  // affordances at all (no guaranteed-403 buttons; drag is already gated).
  const editor = trip.role !== "viewer";

  const dayOrder = useDayOrder(trip.id, {
    // HOOK-level seam (T-6.8/T-6.9 landmine): fires for EVERY settled call.
    // The rollback itself is the hook's; this is the visible half (R-itin-2).
    onMutationError: () => setNotice("reorder-failed"),
  });

  const bookingsById = useMemo(() => {
    const bookings = bookingsQuery.data?.items ?? [];
    return new Map<string, Booking>(bookings.map((b) => [b.id, b]));
  }, [bookingsQuery.data]);

  const rows = useMemo(
    () => buildDayRows(trip, itineraryQuery.data?.items ?? [], bookingsById),
    [bookingsById, itineraryQuery.data, trip],
  );

  const toggleMode = () => {
    const next: ItineraryViewMode = mode === "list" ? "grid" : "list";
    setMode(next);
    storeItineraryViewMode(trip.id, next);
  };

  // `time` (HH:mm) is the §2.5 gap-tap prefill leg — the grid passes it via
  // the GridSurface seam; the form's in-modal category step handles the
  // missing `category` for these prefill paths (T-7.6).
  const openAdd = (day?: string, time?: string) => {
    router.push({
      pathname: "/[tripId]/itinerary/item/new",
      params: {
        tripId: trip.id,
        ...(day === undefined ? {} : { day }),
        ...(time === undefined ? {} : { time }),
      },
    });
  };

  // R-itin-18: the FAB opens the 10-option add Sheet; a selection opens the
  // form modal with that type preset.
  const openAddOption = (option: Parameters<typeof addOptionSlug>[0]) => {
    setAddSheetVisible(false);
    router.push({
      pathname: "/[tripId]/itinerary/item/new",
      params: { tripId: trip.id, category: addOptionSlug(option) },
    });
  };

  const openBooking = (bookingId: string) => {
    router.push({
      pathname: "/[tripId]/itinerary/booking/[bookingId]",
      params: { tripId: trip.id, bookingId },
    });
  };

  const openItem = (itemId: string) => {
    router.push({
      pathname: "/[tripId]/itinerary/item/[itemId]",
      params: { tripId: trip.id, itemId },
    });
  };

  const openEntry = (entry: DayEntry) => {
    // Booking-kind rows route to booking-detail (R-itin-27); both synthesized
    // check-in/check-out rows carry the same bookingId (R-itin-31).
    if (entry.bookingId !== null) {
      openBooking(entry.bookingId);
      return;
    }
    openItem(entry.itemId);
  };

  const handleReorder = ({ from, to }: { from: number; to: number }) => {
    const resolution = resolveDrop(rows, from, to);
    if (resolution.kind === "refused-day-lock") {
      // The drop's ONE haptic (R-ds-21): warning instead of dragDrop.
      triggerHaptic("warning");
      setNotice("day-lock");
      return;
    }
    triggerHaptic("dragDrop");
    if (resolution.kind === "noop") return;
    setNotice(null);
    dayOrder.mutate({ day: resolution.day, itemIds: resolution.itemIds });
  };

  const settled = itineraryQuery.data !== undefined && bookingsQuery.data !== undefined;
  const failed = itineraryQuery.isError || bookingsQuery.isError;
  const retryFetch = () => {
    if (itineraryQuery.isError) void itineraryQuery.refetch();
    if (bookingsQuery.isError) void bookingsQuery.refetch();
  };

  const items = itineraryQuery.data?.items ?? [];
  const unscheduledExist = (bookingsQuery.data?.items.length ?? 0) > 0;
  const showEmpty = settled && items.length === 0 && !unscheduledExist;

  const days = useMemo(() => rows.flatMap((row) => (row.type === "day" ? [row.date] : [])), [rows]);

  let body;
  if (!settled) {
    body = failed ? (
      <View style={s.banner}>
        <ErrorBanner
          message="Couldn't load the itinerary."
          onRetry={retryFetch}
          testID="itinerary-error"
        />
      </View>
    ) : (
      <SkeletonDays />
    );
  } else if (showEmpty) {
    body = (
      <View style={s.state}>
        <EmptyState
          icon="calendar-outline"
          title="Nothing planned yet"
          body="Days fill up fast — start with a stay, a flight, or an idea."
          {...(editor
            ? {
                action: {
                  label: "Add your first plan",
                  onPress: () => setAddSheetVisible(true),
                  testID: "itinerary-empty-add",
                },
              }
            : {})}
          testID="itinerary-empty"
        />
      </View>
    );
  } else if (mode === "grid") {
    // T-7.7 fills GridSurface's internals (R-itin-13..17); its props are the
    // frozen W4 seam — this call site does not change for the real grid.
    body = (
      <GridSurface
        trip={trip}
        items={items}
        bookingsById={bookingsById}
        onAddAt={openAdd}
        onOpenBooking={openBooking}
        onOpenItem={openItem}
      />
    );
  } else {
    body = (
      <>
        <DayJumpStrip days={days} onJump={(date) => listHandle.current?.scrollToDay(date)} />
        <ItineraryDayList
          ref={listHandle}
          // Viewers get no empty-day add rows (write affordance, R-ib-24);
          // the day header still sections the range.
          rows={editor ? rows : rows.filter((row) => row.type !== "empty-day")}
          dragEnabled={editor && !dayOrder.isPending}
          onReorder={handleReorder}
          onOpenEntry={openEntry}
          onAddToDay={(date) => openAdd(date)}
        />
      </>
    );
  }

  return (
    <GestureHandlerRootView style={s.screen}>
      <View style={s.screen} testID="itinerary-screen">
        <PageHeader
          title={trip.name}
          testID="itinerary-header"
          trailing={[
            {
              icon: mode === "list" ? "grid-outline" : "list-outline",
              label: mode === "list" ? "Switch to grid view" : "Switch to list view",
              onPress: toggleMode,
              testID: "itinerary-view-toggle",
            },
          ]}
        />
        {/* IDEAS BUCKET (T-7.6 / IT-5): §2.3 section pinned above the day
            list, hidden when empty (R-itin-10). Mounted in BOTH view modes —
            unscheduled bookings have no other surface (grid included). */}
        <IdeasBucket trip={trip} onOpenBooking={openBooking} />
        {notice !== null ? (
          <View style={s.banner}>
            <ErrorBanner
              tone={notice === "day-lock" ? "warning" : "danger"}
              message={
                notice === "day-lock"
                  ? BOOKING_DAY_LOCK_HINT
                  : "Couldn't save the new order — your previous order is back."
              }
              onDismiss={() => setNotice(null)}
              testID={notice === "day-lock" ? "itinerary-reorder-hint" : "itinerary-reorder-error"}
            />
          </View>
        ) : null}
        {settled && failed ? (
          <View style={s.banner}>
            <ErrorBanner
              message="Couldn't refresh the itinerary."
              onRetry={retryFetch}
              testID="itinerary-refresh-error"
            />
          </View>
        ) : null}
        <View style={s.body}>{body}</View>
        {editor ? (
          <>
            <Fab
              icon="add"
              label="Add to itinerary"
              onPress={() => setAddSheetVisible(true)}
              testID="itinerary-fab-add"
            />
            <AddOptionsSheet
              visible={addSheetVisible}
              onDismiss={() => setAddSheetVisible(false)}
              onSelect={openAddOption}
            />
          </>
        ) : null}
      </View>
    </GestureHandlerRootView>
  );
}
