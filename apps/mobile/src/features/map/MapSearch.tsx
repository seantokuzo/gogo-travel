/**
 * Map search bar + result list (T-8.3 / MAP-2 — R-map-25, §2.8 search
 * inventory). CT-2/PlacePicker typeahead composition (`useDeferredValue`
 * debouncing, bounded list, pending/error/empty arms) over the map-surface
 * hook (`map-search.ts`: 2-char floor + destination-region bbox +
 * trip_id).
 *
 * Result taps hand the FULL place row up (`onSelectResult`) — the slot
 * presents the standard sheet from it (R-map-25 "tapping a result opens the
 * standard place sheet"); rows never route through the saved-places lookup
 * (search results need not be saved). Temporary pins: `searchPinFeatures`
 * consumes this component's same result rows — source wiring is
 * rider-blocked (escalation list), the list is the live tap surface.
 *
 * OFFLINE (R-map-25 ⇒ R-map-22 "degrade with an offline notice, no
 * spinners that never resolve"): two arms, both covered —
 *  - proactive: `useTripOffline` already true ⇒ the query never fires
 *    (enabled gate) and the notice renders instead of a pending skeleton;
 *  - reactive: the trip cache looks healthy but THIS request dies at the
 *    transport layer (`isOfflineError` — status-0 marker) ⇒ same notice,
 *    not the generic error banner. Recovery is TanStack's own refetch
 *    lifecycle once typing resumes/network returns.
 *
 * Keyboard: `keyboardShouldPersistTaps="handled"` — without it the first
 * tap on a result row only dismisses the keyboard (screens rule: keyboard
 * handling where it matters).
 */
import type { Place } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useDeferredValue, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { AppText, ErrorBanner, Input, ListItem, Skeleton } from "@/components";
import { isOfflineError, useTripOffline } from "@/data";

import { isSearchableMapQuery, useMapPlaceSearch } from "./map-search";

export interface MapSearchProps {
  tripId: string;
  destination: { lat: number; lng: number };
  onSelectResult(place: Place): void;
}

/** ~5 rows before the list scrolls — the map must stay visible behind it. */
const RESULTS_MAX_HEIGHT = 280;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: { gap: t.space[2] },
    panel: {
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.surface,
    },
    panelPadded: { padding: t.space[3] },
    results: { maxHeight: RESULTS_MAX_HEIGHT },
  }),
);

export function MapSearch({ tripId, destination, onSelectResult }: MapSearchProps) {
  const s = useStyles();
  const [query, setQuery] = useState("");

  const deferredQuery = useDeferredValue(query);
  const offline = useTripOffline(tripId);
  // Offline ⇒ the empty query disables the hook (enabled gate) — the notice
  // below replaces any pending arm, so no spinner can hang (R-map-22).
  const search = useMapPlaceSearch({ tripId, destination }, offline ? "" : deferredQuery);

  const trimmed = query.trim();
  const searchable = isSearchableMapQuery(deferredQuery);
  const active = searchable && !offline;
  const results = search.data?.items ?? [];
  const searchOffline = offline || isOfflineError(search.error);

  return (
    <View style={s.container}>
      <Input
        label="Search places"
        value={query}
        onChangeText={setQuery}
        placeholder="Search this trip's area"
        helper={
          trimmed !== "" && !searchable
            ? "Keep typing — search starts at 2 characters."
            : undefined
        }
        trailing={
          query !== "" ? (
            <Pressable
              onPress={() => setQuery("")}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              testID="map-search-clear"
            >
              <AppText role="caption" color="secondary">
                Clear
              </AppText>
            </Pressable>
          ) : undefined
        }
        testID="map-search-input"
      />
      {trimmed !== "" && searchable && searchOffline ? (
        <View style={[s.panel, s.panelPadded]}>
          <AppText role="caption" color="secondary" testID="map-search-offline">
            Search needs a connection — the map and saved pins still work offline.
          </AppText>
        </View>
      ) : active ? (
        search.isPending ? (
          <View style={[s.panel, s.panelPadded]}>
            <Skeleton variant="text" lines={2} />
          </View>
        ) : search.isError ? (
          <ErrorBanner
            message="Place search failed."
            onRetry={() => void search.refetch()}
            testID="map-search-error"
          />
        ) : results.length === 0 ? (
          <View style={[s.panel, s.panelPadded]}>
            <AppText role="caption" color="muted">
              No places matched — try a different spelling.
            </AppText>
          </View>
        ) : (
          <View style={s.panel}>
            <FlatList
              style={s.results}
              data={results}
              keyExtractor={(place) => place.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: place }) => (
                <ListItem
                  title={place.name}
                  subtitle={place.category ?? undefined}
                  onPress={() => onSelectResult(place)}
                  testID={`map-search-list-item-${place.id}`}
                />
              )}
            />
          </View>
        )
      ) : null}
    </View>
  );
}
