/**
 * Airport typeahead (B-9 client half — the field that makes B-8 fixable).
 *
 * Type "NRT" or "Narita" and pick: the pick commits the IATA code to the
 * detail field AND hands the airport's IANA zone up to the paired datetime
 * field, which is the ONLY reason a correct instant is composable at all
 * (the client had no zone datum before the B-9 table).
 *
 * Shape is `PlacePickerField`'s verbatim (R-itin-23 precedent): a query
 * input over a `useDeferredValue`-debounced search, bounded results, and
 * PICK-VOIDS-ON-EDIT so the committed code can never disagree with the
 * visible text. The only client gate is the SHARED query schema
 * (`isSearchableReferenceQuery`) — the ApiClient validates responses, never
 * inputs, so an ungated sub-floor query would be a live 400 that also burns
 * the per-user reference limiter.
 *
 * Free text is committed VERBATIM (not forced to a code): the wire field is
 * still `optionalString` 200 (B-20 Q2 stays Sean's ruling — B-9 does not
 * narrow it), so pre-picker rows like "Narita" survive, and the B-20
 * save-time 3-letter dirty-gate is what rejects junk the user actually
 * typed. A bare 3-letter entry is uppercased on commit so hand-typing
 * "nrt" still works with no network at all.
 *
 * Result rows SHOW the zone ("Tokyo · GMT+9") — the user sees what the pick
 * is about to stamp before it lands.
 */
import type { Airport } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useDeferredValue, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, ErrorBanner, Input, ListItem, Skeleton } from "@/components";
import { isSearchableReferenceQuery, useAirportSearch } from "@/data";

import { describeTimeZone, referenceInstantFor } from "./zoned-time";

/** Bounded result render (the typeahead precedent — few rows, no paging). */
const MAX_RESULTS = 8;

/** A bare 3-letter entry IS a code — uppercase it, no network needed. */
const BARE_CODE_RE = /^[A-Za-z]{3}$/;

export interface AirportPickerFieldProps {
  label: string;
  /** The committed detail value (an IATA code, or legacy free text). */
  value: string;
  /** Commit raw text — the pick-voided / hand-typed path. */
  onChangeText(value: string): void;
  /** A real pick: commit the code AND adopt the airport's IANA zone. */
  onPickAirport(airport: Airport): void;
  /** Wall date the zone labels are described at (offsets are seasonal). */
  referenceDate?: string;
  error?: string;
  /** Required (R-ds-20). */
  testID: string;
}

/** "NRT · Tokyo" — short enough for the field row after a pick. */
export function pickedAirportLabel(airport: Airport): string {
  return airport.city !== null && airport.city !== "" ? `${airport.iata} · ${airport.city}` : airport.iata;
}

/** "Narita International Airport · Tokyo, JP" — the row's second line. */
export function airportSubtitle(airport: Airport, gmt: string | null): string {
  const place = [airport.city, airport.country].filter((part) => part !== null && part !== "");
  const zone = gmt === null ? airport.tz : `${airport.tz} (${gmt})`;
  return [airport.name, place.join(", "), zone].filter((part) => part !== "").join(" · ");
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

export function AirportPickerField({
  label,
  value,
  onChangeText,
  onPickAirport,
  referenceDate,
  error,
  testID,
}: AirportPickerFieldProps) {
  const s = useStyles();
  // Lazy initial state: the committed value seeds the box exactly once, so a
  // later commit (the pick's own) can't fight the user's typing.
  const [query, setQuery] = useState(() => value);
  // A PREFILLED field (edit mode) starts settled: opening a stored booking
  // must not fire a search or drop a result list over the form for a value
  // the user never typed.
  const [picked, setPicked] = useState(() => value !== "");

  // `useDeferredValue` lags one render, so a CLEARED box would otherwise
  // fire a search for the text the user just deleted (and immediately abort
  // it). Gate on the live value as well as the deferred one.
  const deferredQuery = useDeferredValue(query);
  const liveQuery = picked || query.trim() === "" ? "" : deferredQuery;
  const searchActive = isSearchableReferenceQuery(liveQuery);
  const search = useAirportSearch(liveQuery);
  const results = (search.data?.items ?? []).slice(0, MAX_RESULTS);
  const atUtcMs = referenceInstantFor(referenceDate);

  /**
   * As-you-type uppercase — the B-20 transform kept alive. `autoCapitalize:
   * "characters"` already does this on device, so applying it explicitly is
   * what makes the rendered value and the committed value agree everywhere
   * (jest's `changeText` bypasses the native prop entirely).
   */
  const normalize = (text: string): string => text.toUpperCase();

  const commit = (text: string): void => {
    const trimmed = text.trim();
    onChangeText(BARE_CODE_RE.test(trimmed) ? trimmed.toUpperCase() : text);
  };

  return (
    <View style={s.container}>
      <Input
        label={label}
        value={query}
        onChangeText={(raw) => {
          const next = normalize(raw);
          setQuery(next);
          // Editing after a pick voids it — the committed code must always
          // match the visible text (PlacePickerField semantics).
          if (picked) setPicked(false);
          commit(next);
        }}
        placeholder="Code or city — NRT, Narita"
        // Codes read uppercase; the server search is case-insensitive, so
        // "NARITA" still finds Narita. Autocorrect fights airport names.
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={200}
        error={error}
        trailing={
          query !== "" ? (
            <Pressable
              onPress={() => {
                setQuery("");
                setPicked(false);
                onChangeText("");
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
            message="Airport search failed."
            onRetry={() => void search.refetch()}
            testID={`${testID}-error-search`}
          />
        ) : results.length === 0 ? (
          <AppText role="caption" color="muted" testID={`${testID}-empty`}>
            No airports matched — type the 3-letter code instead.
          </AppText>
        ) : (
          <View style={s.results}>
            {results.map((airport) => (
              <ListItem
                key={airport.iata}
                title={`${airport.iata} — ${airport.name}`}
                subtitle={airportSubtitle(airport, describeTimeZone(airport.tz, atUtcMs)?.gmt ?? null)}
                onPress={() => {
                  setPicked(true);
                  setQuery(pickedAirportLabel(airport));
                  onPickAirport(airport);
                }}
                testID={`${testID}-result-${airport.iata}`}
              />
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}
