/**
 * Place picker (T-7.6 / IT-7 — R-itin-23): REUSES the CT-2
 * destination-typeahead machinery verbatim — `usePlaceSearch` +
 * `isSearchableDestinationQuery` (the 4-char text-only floor is the ONLY
 * client gate; the ApiClient never validates inputs) with
 * `useDeferredValue` debouncing and pick-voids-on-edit semantics
 * (structured input: the id always matches the visible text).
 *
 * R-itin-23's "trip's saved places first" leg has NO endpoint yet (the
 * saved-places descriptors land with PL-3/PL-4 — place.ts module doc);
 * v1 offers spine search only. Flagged in the PR as a seam.
 *
 * testIDs: query input `{testID}`, result rows `{testID}-result-{placeId}`,
 * clear `{testID}-clear` (not in the §2.9 inventory — spec-sync batch).
 */
import type { Place } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useDeferredValue, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, ErrorBanner, Input, ListItem, Skeleton } from "@/components";
import { isSearchableDestinationQuery, usePlaceSearch } from "@/data";

/** Bounded result render (trip-new precedent — typeahead wants few). */
const MAX_RESULTS = 8;

export interface PlacePickerFieldProps {
  label: string;
  selected: { id: string; name: string } | null;
  onSelect(place: Place | null): void;
  error?: string;
  /** Required (R-ds-20). */
  testID: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: { gap: t.space[1] },
    results: {
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.surface,
    },
  }),
);

export function PlacePickerField({
  label,
  selected,
  onSelect,
  error,
  testID,
}: PlacePickerFieldProps) {
  const s = useStyles();
  const [query, setQuery] = useState(selected?.name ?? "");

  const deferredQuery = useDeferredValue(query);
  const searchActive = selected === null && isSearchableDestinationQuery(deferredQuery);
  const search = usePlaceSearch(selected === null ? deferredQuery : "");

  const results = (search.data?.items ?? []).slice(0, MAX_RESULTS);

  return (
    <View style={s.container}>
      <Input
        label={label}
        value={query}
        onChangeText={(value) => {
          setQuery(value);
          // Editing after a pick voids it — id must match the visible text.
          if (selected !== null) onSelect(null);
        }}
        placeholder="Search places"
        helper={
          selected === null && query !== "" && !searchActive
            ? "Keep typing — search starts at 4 characters."
            : undefined
        }
        error={error}
        trailing={
          selected !== null ? (
            <Pressable
              onPress={() => {
                onSelect(null);
                setQuery("");
              }}
              accessibilityRole="button"
              accessibilityLabel={`Clear ${label}`}
              testID={`${testID}-clear`}
            >
              <AppText role="caption" color="secondary">
                Clear
              </AppText>
            </Pressable>
          ) : undefined
        }
        testID={testID}
      />
      {searchActive ? (
        search.isPending ? (
          <Skeleton variant="text" lines={2} />
        ) : search.isError ? (
          <ErrorBanner
            message="Place search failed."
            onRetry={() => void search.refetch()}
            testID={`${testID}-error-search`}
          />
        ) : results.length === 0 ? (
          <AppText role="caption" color="muted">
            No places matched — try a different spelling.
          </AppText>
        ) : (
          <View style={s.results}>
            {results.map((place) => (
              <ListItem
                key={place.id}
                title={place.name}
                subtitle={place.category ?? undefined}
                onPress={() => {
                  onSelect(place);
                  setQuery(place.name);
                }}
                testID={`${testID}-result-${place.id}`}
              />
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}
