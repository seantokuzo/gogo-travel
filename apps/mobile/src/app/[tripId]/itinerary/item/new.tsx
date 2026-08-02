/**
 * Add/edit itinerary item (T-7.6 / IT-7 — itinerary spec §2.4; MODAL per
 * R-nav-21). The unified form modal behind every add/edit path:
 *
 *  - `?category=` preset (FAB add-sheet / return-prompt landing) — without
 *    it, the in-form category step renders the same 10-option inventory
 *    (`itinerary-add-option-*`), which is how the category-less prefill
 *    paths (empty-day add row, grid gap-tap) pick a type;
 *  - `?day=` + `?time=` (HH:mm) prefills — grid gap-tap sends both
 *    (R-itin-14: primary start preset to the slot); the day-add row sends
 *    day only (the §2.4 create→schedule fallback target);
 *  - `?itemId=` edit (place_visit/custom — booking-kind items never edit
 *    here, R-itin-27) / `?bookingId=` booking edit, prefilled from the
 *    detail read;
 *  - `?source=deeplink_return` — the return prompt's "add manually"
 *    landing; the create carries `source: 'deeplink_return'` (R-ib-11).
 *
 * Dirty dismissal (nav §2.6 form-modal rule, trip-new precedent): ANY
 * removal of a dirty form funnels through `beforeRemove` → discard
 * ConfirmDialog; a save bypasses the guard. Viewers get a read-only notice
 * (R-ib-24 — no write affordance renders a guaranteed 403).
 */
import {
  BookingCategorySchema,
  ISODateSchema,
  ISOTimeSchema,
  type BookingCategory,
} from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useNavigation, useRouter, type Href } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";

import { ConfirmDialog, EmptyState, ErrorBanner, PageHeader, Skeleton } from "@/components";
import { useBooking, useItinerary } from "@/data";
import {
  ADD_OPTION_LABELS,
  AddOptionList,
  BookingForm,
  ItemForm,
  type AddOptionId,
} from "@/features/itinerary";
import { useTripContext } from "@/navigation/trip-context";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    flex: { flex: 1 },
    content: { padding: t.space[4], gap: t.space[4], paddingBottom: t.space[8] },
    state: { flex: 1, justifyContent: "center" },
  }),
);

/** Route param → option id (kebab slug or raw enum); unknown → picker step. */
function parseOption(raw: string | undefined): AddOptionId | null {
  // expo-router hands back a string[] when a query key is REPEATED, and the
  // `useLocalSearchParams<…>()` generic is an unchecked assertion — a
  // crafted/mangled `?category=x&category=x` deep link would otherwise throw
  // out of the useState initializer (red-screen on link open). Non-string
  // degrades to the in-form picker step, like any unknown value.
  if (typeof raw !== "string") return null;
  const value = raw.replaceAll("-", "_");
  if (value === "place_visit" || value === "custom") return value;
  const parsed = BookingCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export default function ItineraryItemNewScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const navigation = useNavigation();
  const s = useStyles();
  const params = useLocalSearchParams<{
    category?: string;
    day?: string;
    time?: string;
    itemId?: string;
    bookingId?: string;
    source?: string;
  }>();

  const [option, setOption] = useState<AddOptionId | null>(() => parseOption(params.category));
  const [dirty, setDirty] = useState(false);
  /** A write already landed this session (partial-success) — drives the discard copy. */
  const [writeLanded, setWriteLanded] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const bypassGuardRef = useRef(false);
  const pendingDismissRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Prefill params validated against the shared scalars — a malformed deep
  // link degrades to "no prefill", never a malformed wire write.
  const prefillDay = ISODateSchema.safeParse(params.day).success ? params.day : undefined;
  const prefillTime = ISOTimeSchema.safeParse(params.time).success ? params.time : undefined;
  const deeplinkReturn = params.source === "deeplink_return";

  const editingBookingId = params.bookingId;
  const editingItemId = params.itemId;
  const bookingQuery = useBooking(trip.id, editingBookingId ?? "", {
    enabled: editingBookingId !== undefined,
  });
  // Item edit resolves from the composite read (no single-item GET exists);
  // the cache is usually warm from the itinerary screen.
  const itineraryQuery = useItinerary(trip.id);

  useEffect(() => {
    // nav §2.6: clean forms dismiss freely; dirty forms intercept with the
    // discard Confirm — `beforeRemove` is the single chokepoint.
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (!dirty || bypassGuardRef.current) return;
      e.preventDefault();
      const action = e.data.action;
      pendingDismissRef.current = () => navigation.dispatch(action);
      setConfirmVisible(true);
    });
    return unsubscribe;
  }, [navigation, dirty]);

  const close = (): void => {
    // Cold modal-only stack fallback (trip-new R1 precedent): an external
    // URL entry mounts no list beneath — back() would be unhandled.
    if (router.canGoBack()) router.back();
    else router.replace(`/${trip.id}/itinerary` as Href);
  };

  const onSaved = (): void => {
    // Mounted guard: hook-level mutation seams live on the Mutation, not the
    // component, so a slow save that settles AFTER the user discard-dismissed
    // this modal would still run — and `close()` would then pop whatever
    // screen the user had moved on to (or `replace` would yank them back to
    // the itinerary). A settled write on an unmounted form is a no-op here;
    // its cache reconciliation already happened in the hook.
    if (!mountedRef.current) return;
    bypassGuardRef.current = true;
    close();
  };

  const onDirty = (): void => setDirty(true);
  /** A write landed while the form stays up (partial-success) — see BookingForm. */
  const onWriteLanded = (): void => {
    setDirty(false);
    setWriteLanded(true);
  };

  const viewer = trip.role === "viewer";

  let title = "Add to itinerary";
  let body;
  if (viewer) {
    // R-ib-24: writes are editor/owner — never render a guaranteed-403 form.
    body = (
      <View style={s.state}>
        <EmptyState
          icon="lock-closed-outline"
          title="View only"
          body="You're a viewer on this trip — ask an editor to add or change plans."
          testID="itinerary-item-new-viewer"
        />
      </View>
    );
  } else if (editingBookingId !== undefined) {
    title = "Edit booking";
    if (bookingQuery.data !== undefined) {
      body = (
        <BookingForm
          trip={trip}
          category={bookingQuery.data.category}
          booking={bookingQuery.data}
          onDirty={onDirty}
          onWriteLanded={onWriteLanded}
          onSaved={onSaved}
        />
      );
    } else if (bookingQuery.isError) {
      body = (
        <ErrorBanner
          message="Couldn't load the booking."
          onRetry={() => void bookingQuery.refetch()}
          testID="itinerary-item-new-error-load"
        />
      );
    } else {
      body = <Skeleton variant="rect" height={240} testID="itinerary-item-new-loading" />;
    }
  } else if (editingItemId !== undefined) {
    title = "Edit item";
    const item = itineraryQuery.data?.items.find((row) => row.id === editingItemId);
    if (item !== undefined && (item.kind === "place_visit" || item.kind === "custom")) {
      body = (
        <ItemForm
          tripId={trip.id}
          kind={item.kind}
          item={item}
          onDirty={onDirty}
          onSaved={onSaved}
        />
      );
    } else if (itineraryQuery.data !== undefined) {
      // Gone (deleted under us), or a booking-kind item — booking content is
      // never duplicated across two screens (R-itin-27).
      body = (
        <View style={s.state}>
          <EmptyState
            icon="alert-circle-outline"
            title="Can't edit this here"
            body={
              item === undefined
                ? "This item no longer exists."
                : "Booking details are edited from the booking screen."
            }
            testID="itinerary-item-new-uneditable"
          />
        </View>
      );
    } else if (itineraryQuery.isError) {
      body = (
        <ErrorBanner
          message="Couldn't load the item."
          onRetry={() => void itineraryQuery.refetch()}
          testID="itinerary-item-new-error-load"
        />
      );
    } else {
      body = <Skeleton variant="rect" height={240} testID="itinerary-item-new-loading" />;
    }
  } else if (option === null) {
    body = <AddOptionList onSelect={setOption} />;
  } else if (option === "place_visit" || option === "custom") {
    title = `Add ${ADD_OPTION_LABELS[option].toLowerCase()}`;
    body = (
      <ItemForm
        tripId={trip.id}
        kind={option}
        prefillDay={prefillDay}
        prefillTime={prefillTime}
        onDirty={onDirty}
        onSaved={onSaved}
      />
    );
  } else {
    title = `Add ${ADD_OPTION_LABELS[option].toLowerCase()}`;
    body = (
      <BookingForm
        trip={trip}
        category={option as BookingCategory}
        prefillDay={prefillDay}
        prefillTime={prefillTime}
        deeplinkReturn={deeplinkReturn}
        onDirty={onDirty}
        onWriteLanded={onWriteLanded}
        onSaved={onSaved}
      />
    );
  }

  return (
    <View style={s.screen} testID="itinerary-item-new-screen">
      <PageHeader
        title={title}
        testID="itinerary-item-new-header"
        trailing={[
          {
            icon: "close",
            label: "Cancel",
            onPress: close,
            testID: "itinerary-item-new-button-cancel",
          },
        ]}
      />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirmVisible}
        title={writeLanded ? "Discard these changes?" : "Discard this entry?"}
        // After a partial success the booking EXISTS (create landed, only the
        // day assignment failed) — claiming "nothing will be saved" there
        // reads as "your entry is gone" and invites a duplicate re-create.
        // `dirty` correctly re-arms on any later edit, so this dialog is
        // reachable in that state and its copy has to stay true.
        body={
          writeLanded
            ? "Your booking is already saved in Ideas — only the edits you've made since then will be lost."
            : "Nothing you've entered will be saved."
        }
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          setConfirmVisible(false);
          bypassGuardRef.current = true;
          const dismiss = pendingDismissRef.current;
          pendingDismissRef.current = null;
          if (dismiss) dismiss();
          else close();
        }}
        onCancel={() => {
          pendingDismissRef.current = null;
          setConfirmVisible(false);
        }}
        testID="itinerary-item-new-button-cancel"
      />
    </View>
  );
}
