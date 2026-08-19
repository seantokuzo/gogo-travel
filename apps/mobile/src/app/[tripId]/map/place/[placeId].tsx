/**
 * Place detail (T-8.4 / MAP-3+MAP-6 — map spec §2.3 detail screen,
 * R-map-9..14, R-map-23/24; pushed from the sheet's "Details", R-map-4).
 *
 * Composition (§2.3, top to bottom): name header · coarse-category icon +
 * category line · save state/toggle (R-map-11) · actions row (Add to day
 * R-map-12 · Navigate R-map-8) · saved-note inline editor (R-map-14) ·
 * fresh premium block (R-map-9/10 — DORMANT in v1, `PLACE_FRESH_ENABLED`) ·
 * linked itinerary items + this-trip photo strip (R-map-14) · spine
 * attribution footer (R-places-17). Distance-from-user is deliberately
 * ABSENT: §2.3 lists it on the SHEET "when puck active" — the puck and the
 * location permission flow are the map screen's (T-8.3 / MAP-4), and this
 * push screen has no location source to compute against.
 *
 * TOUR-GUIDE ENTRY (R-map-13): not rendered — the WHEN clause ("the trip
 * has a `ready` bundle") is unreachable until the P-10 AI phase ships a
 * bundle store; rendering no entry point IS the requirement's absent arm
 * ("never a broken tap"). The affordance lands with that phase.
 *
 * WRITES (R-map-11 + the R-ib-24 client pattern): viewers get the read
 * surface — saved STATE (a badge), the note as text — with no write
 * affordances at all. Save/unsave are optimistic through the data layer;
 * note/unsave stay gated until the REAL saved row exists
 * (`isOptimisticSavedPlaceId` — a write against the placeholder id would be
 * a guaranteed 404). Every action is pending-gated; side effects ride the
 * HOOK-level seams only (superseded-call law).
 *
 * CROSS-TAB (R-map-12/14/23): an imperative push at another tab's URL
 * silently no-ops (mobile.md landmine), so both itinerary-bound affordances
 * jump the TAB first (`jumpToTripTab`, the tab-bar-equivalent move), then
 * push/navigate within the now-active itinerary stack — Add to day opens
 * the item/new modal prefilled `place_visit` + place (R-map-12); a linked
 * item lands on the day list with the T-7.9 `?day=` arrival param (the
 * index consumes it after handling). Pinned end-to-end by the
 * place-detail-cross-tab walkthrough suite.
 *
 * OFFLINE + STATES (the T-7.9 posture): `is404` OUTRANKS retained cache
 * (Law #3 client half — a fresh 404 is a visibility/membership verdict);
 * otherwise cached spine data keeps rendering under the derived offline
 * banner (R-map-22 — the detail is spine-cached and works offline), and a
 * failed refetch never blanks a loaded place.
 */
import { ATTRIBUTION, type ISODate, type Photo } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";

import { ApiRequestError, useSessionStore } from "@/auth";
import {
  AppText,
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Icon,
  Input,
  ListItem,
  PageHeader,
  Skeleton,
} from "@/components";
import {
  findSavedPlace,
  isOptimisticSavedPlaceId,
  PLACE_FRESH_ENABLED,
  useItinerary,
  useItineraryBookings,
  usePlace,
  usePlaceFresh,
  useSavedPlaces,
  useSavePlace,
  useTripOffline,
  useUnsavePlace,
  useUpdateSavedPlaceNote,
} from "@/data";
import { itemWhenLabel } from "@/features/itinerary";
import {
  categoryLabel,
  COARSE_CATEGORY_ICONS,
  linkedItineraryItems,
  PlaceFreshBlock,
  placeNavigateUrl,
  visiblePlacePhotos,
} from "@/features/places";
import { jumpToTripTab } from "@/navigation/tab-jump";
import { useTripContext } from "@/navigation/trip-context";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    content: { paddingBottom: t.space[8], gap: t.space[4] },
    block: { paddingHorizontal: t.space[4], gap: t.space[2] },
    banner: { paddingHorizontal: t.space[4] },
    categoryRow: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
    actionRow: { flexDirection: "row", gap: t.space[2], flexWrap: "wrap" },
    state: { flex: 1, justifyContent: "center" },
  }),
);

/**
 * This-trip photos source — EMPTY-IN-PROD until P-12 (the photo-pins prep
 * ruling analogue): no photos read exists yet; the Law-#3 filter
 * (`visiblePlacePhotos`) is fixture-tested and wired here so the P-12 task
 * swaps the source, not the surface.
 */
const PLACE_PHOTOS: readonly Photo[] = [];

export default function PlaceDetailScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const navigation = useNavigation();
  const s = useStyles();

  // Repeated query keys arrive as `string[]` and the generic is an unchecked
  // assertion (T-7.9 precedent) — degrade to missing, never index an array.
  const params = useLocalSearchParams<{ placeId?: string }>();
  const placeId = typeof params.placeId === "string" ? params.placeId : "";

  const detailQuery = usePlace(placeId, { enabled: placeId !== "" });
  // §2.4 fetch-fresh — dormant in v1 (the flag): no request is issued, the
  // block renders nothing (R-map-10's silent absence covers the dormancy).
  const freshQuery = usePlaceFresh(placeId, {
    enabled: PLACE_FRESH_ENABLED && placeId !== "",
  });
  const savedQuery = useSavedPlaces(trip.id);
  const itineraryQuery = useItinerary(trip.id);
  const bookingsQuery = useItineraryBookings(trip.id);
  const offline = useTripOffline(trip.id);
  const viewerId = useSessionStore((state) => state.user?.id ?? "");

  const [actionError, setActionError] = useState<string | null>(null);
  /** `null` = editor not open; a string = the in-progress draft. */
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const save = useSavePlace(trip.id, {
    // HOOK-level seams only (superseded-call landmine).
    onMutationError: () => setActionError("Couldn't save this place. Try again."),
    onMutationSuccess: () => setActionError(null),
  });
  const unsave = useUnsavePlace(trip.id, {
    onMutationError: () => setActionError("Couldn't remove this place. Try again."),
    onMutationSuccess: () => setActionError(null),
  });
  const noteUpdate = useUpdateSavedPlaceNote(trip.id, {
    onMutationError: () => setActionError("Couldn't save the note. Try again."),
    onMutationSuccess: () => {
      setActionError(null);
      setNoteDraft(null);
    },
  });

  const editor = trip.role !== "viewer";
  const place = detailQuery.data?.place;
  const savedRow = findSavedPlace(savedQuery.data, placeId);
  const saved = savedRow !== undefined;
  // Note edits / unsave need the REAL row id — the optimistic placeholder
  // would 404 (data-layer doc). Save success or the 409-path refetch settles it.
  const savedRowSettled = savedRow !== undefined && !isOptimisticSavedPlaceId(savedRow.id);
  const busy = save.isPending || unsave.isPending || noteUpdate.isPending;

  const is404 =
    detailQuery.error instanceof ApiRequestError && detailQuery.error.status === 404;

  const linkedItems = useMemo(
    () =>
      linkedItineraryItems(
        itineraryQuery.data?.items ?? [],
        bookingsQuery.data?.items ?? [],
        placeId,
      ),
    [itineraryQuery.data, bookingsQuery.data, placeId],
  );
  const bookingTitleById = useMemo(
    () => new Map((bookingsQuery.data?.items ?? []).map((row) => [row.id, row.title])),
    [bookingsQuery.data],
  );
  const photos = useMemo(
    () => visiblePlacePhotos(PLACE_PHOTOS, { viewerId, isTripMember: true }, placeId),
    [viewerId, placeId],
  );

  /**
   * R-map-14/23: land on the itinerary DAY LIST scrolled to this item's day.
   * Tab jump first (the landmine-safe move), then the same-tab `?day=`
   * arrival param the T-7.9 schedule row uses — consumed after handling, so
   * the same day is jumpable again.
   */
  const openItineraryDay = (day: ISODate): void => {
    if (!jumpToTripTab(navigation, trip.id, "itinerary")) return;
    router.navigate({
      pathname: "/[tripId]/itinerary",
      params: { tripId: trip.id, day },
    });
  };

  /** R-map-12: the itinerary add-item modal, prefilled place_visit + place. */
  const openAddToDay = (): void => {
    if (place === undefined) return;
    if (!jumpToTripTab(navigation, trip.id, "itinerary")) return;
    router.push({
      pathname: "/[tripId]/itinerary/item/new",
      params: {
        tripId: trip.id,
        category: "place_visit",
        placeId: place.id,
        placeName: place.name,
      },
    });
  };

  const toggleSave = (): void => {
    if (busy || place === undefined) return;
    setActionError(null);
    if (!saved) {
      save.mutate({ place });
      return;
    }
    if (savedRowSettled) unsave.mutate(savedRow.id);
  };

  const submitNote = (): void => {
    if (busy || noteDraft === null || savedRow === undefined || !savedRowSettled) return;
    setActionError(null);
    const trimmed = noteDraft.trim();
    noteUpdate.mutate({ savedPlaceId: savedRow.id, note: trimmed === "" ? null : trimmed });
  };

  let body;
  if (placeId === "" || is404) {
    // BEFORE the loaded branch (T-7.9 posture, Law #3 client half): a fresh
    // 404 is the server's visibility verdict — an invisible custom place or
    // a dead id must not keep rendering from retained cache.
    body = (
      <View style={s.state}>
        <EmptyState
          icon="alert-circle-outline"
          title="Place not found"
          body="It may have been removed, or the link is no longer valid."
          testID="place-detail-missing"
        />
      </View>
    );
  } else if (place === undefined) {
    // Error BEFORE data (nothing to retain): retry surface. A failure over
    // RETAINED data falls through to the loaded branch with a banner.
    body = detailQuery.isError ? (
      <View style={s.banner}>
        <ErrorBanner
          message={
            offline ? "You're offline and this place isn't cached yet." : "Couldn't load this place."
          }
          onRetry={() => void detailQuery.refetch()}
          testID="place-detail-error"
        />
      </View>
    ) : (
      <View style={s.block} testID="place-detail-loading">
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="rect" height={96} />
      </View>
    );
  } else {
    const attribution = place.source === "custom" ? null : ATTRIBUTION[place.source];
    const noteValue = noteDraft ?? savedRow?.note ?? "";
    const noteDirty = noteDraft !== null && noteDraft !== (savedRow?.note ?? "");
    body = (
      <ScrollView contentContainerStyle={s.content}>
        {offline ? (
          <View style={s.banner}>
            {/* R-itin-29 kin: informational, NOT an error — the spine data
                below is real, just not fresh. */}
            <ErrorBanner
              tone="warning"
              message="You're offline — showing the last synced version."
              testID="place-detail-banner-offline"
            />
          </View>
        ) : null}
        {detailQuery.isError && !offline ? (
          <View style={s.banner}>
            <ErrorBanner
              message="Couldn't refresh this place."
              onRetry={() => void detailQuery.refetch()}
              testID="place-detail-banner-refresh"
            />
          </View>
        ) : null}
        {actionError !== null ? (
          <View style={s.banner}>
            <ErrorBanner
              message={actionError}
              onDismiss={() => setActionError(null)}
              testID="place-detail-banner-action"
            />
          </View>
        ) : null}

        <View style={s.block}>
          <View style={s.categoryRow}>
            <Icon name={COARSE_CATEGORY_ICONS[place.coarse_category]} size={18} />
            <AppText role="caption" color="secondary" testID="place-detail-category">
              {categoryLabel(place)}
            </AppText>
          </View>
          {/* R-map-11: viewers see STATE, not the control. */}
          {editor ? (
            <View style={s.actionRow}>
              <Button
                title={saved ? "Saved" : "Save place"}
                variant={saved ? "secondary" : "primary"}
                size="sm"
                icon={saved ? "bookmark" : "bookmark-outline"}
                disabled={busy || (saved && !savedRowSettled)}
                onPress={toggleSave}
                testID="place-detail-button-save"
              />
            </View>
          ) : saved ? (
            <View style={s.actionRow}>
              <Badge label="Saved" tone="neutral" testID="place-detail-badge-saved" />
            </View>
          ) : null}
        </View>

        <View style={s.block}>
          <View style={s.actionRow}>
            {/* R-ib-24 client half: adding an item is a write — editors only. */}
            {editor ? (
              <Button
                title="Add to day"
                variant="secondary"
                icon="calendar-outline"
                disabled={busy}
                onPress={openAddToDay}
                testID="place-detail-button-add-to-day"
              />
            ) : null}
            <Button
              title="Navigate"
              variant="secondary"
              icon="navigate-outline"
              // R-map-8: URL-scheme handoff, never in-app turn-by-turn. An
              // external maps app is useless offline anyway; keep the button
              // honest rather than launching into a blank map.
              disabled={offline}
              onPress={() => void Linking.openURL(placeNavigateUrl(place))}
              testID="place-detail-button-navigate"
            />
          </View>
        </View>

        {/* R-map-14: the saved-place note — inline editable for owner/editor,
            read-only text for viewers. Only exists once the place is saved. */}
        {savedRow !== undefined && editor ? (
          <View style={s.block}>
            <Input
              label="Note"
              value={noteValue}
              onChangeText={setNoteDraft}
              placeholder="Why this place?"
              multiline
              testID="place-detail-input-note"
            />
            {noteDirty ? (
              <View style={s.actionRow}>
                <Button
                  title="Save note"
                  size="sm"
                  disabled={busy || !savedRowSettled}
                  onPress={submitNote}
                  testID="place-detail-button-save-note"
                />
              </View>
            ) : null}
          </View>
        ) : null}
        {savedRow !== undefined && !editor && savedRow.note !== null && savedRow.note !== "" ? (
          <View style={s.block}>
            <AppText role="label" color="secondary">
              Note
            </AppText>
            <AppText testID="place-detail-note">{savedRow.note}</AppText>
          </View>
        ) : null}

        {/* §2.4 fresh block — renders nothing while the seam is dormant
            (R-map-10 silent absence). */}
        <View style={s.block}>
          <PlaceFreshBlock fresh={freshQuery.data ?? null} />
        </View>

        {linkedItems.length > 0 ? (
          <View style={s.block}>
            <AppText role="label" color="secondary">
              In the itinerary
            </AppText>
            {linkedItems.map((item) => (
              <ListItem
                key={item.id}
                title={
                  item.title ??
                  (item.booking_id !== null
                    ? (bookingTitleById.get(item.booking_id) ?? "Booking")
                    : "Place visit")
                }
                subtitle={itemWhenLabel(item)}
                trailing="chevron"
                onPress={() => openItineraryDay(item.day)}
                testID={`place-detail-list-item-${item.id}`}
              />
            ))}
          </View>
        ) : null}

        {photos.length > 0 ? (
          <View style={s.block}>
            <AppText role="label" color="secondary">
              Photos
            </AppText>
            {photos.map((photo) => (
              // Thumbnail rendering arrives with the P-12 photo pipeline
              // (storage_key → signed URL); the strip's visibility-filtered
              // slot ships wired (module doc on PLACE_PHOTOS).
              <View key={photo.id} testID={`place-detail-photo-${photo.id}`}>
                <Icon name="image-outline" />
              </View>
            ))}
          </View>
        ) : null}

        {attribution !== null ? (
          <View style={s.block}>
            <AppText role="caption" color="secondary" testID="place-detail-attribution">
              {attribution.text}
            </AppText>
          </View>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <View style={s.screen} testID="place-detail-screen">
      <PageHeader title={place?.name ?? "Place"} leading="back" testID="place-detail-header" />
      {body}
    </View>
  );
}
