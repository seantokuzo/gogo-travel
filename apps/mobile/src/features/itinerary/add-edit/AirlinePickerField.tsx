/**
 * Airline typeahead (B-9 client half) — `/airlines/search` behind the same
 * `PlacePickerField` shape as the airport picker.
 *
 * The wire field (`flight.airline`) stores a NAME, not a designator, so a
 * pick commits `airline.name` and free text commits verbatim: there is no
 * save-time gate to satisfy here, and a carrier the seeded table doesn't
 * know must stay typeable.
 */
import type { Airline } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useDeferredValue, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, ErrorBanner, Input, ListItem, Skeleton } from "@/components";
import { isSearchableReferenceQuery, useAirlineSearch } from "@/data";

const MAX_RESULTS = 8;

export interface AirlinePickerFieldProps {
  label: string;
  /** The committed detail value (the airline name). */
  value: string;
  onChangeText(value: string): void;
  /**
   * B-9 R1 (correctness advisory): a value the HOST committed — the flight
   * number's "Use All Nippon Airways" suggestion — is settled exactly as a
   * pick is. Without it `picked` stays false (it is lazily initialized from
   * the first value and only this component's own interactions move it), so
   * a programmatic fill drops a result list open and burns a shared
   * reference-limiter unit for text the user never typed: the very defect
   * class this PR fixed for prefills, through the other door.
   */
  settledValue?: string;
  /** Wire cap for `flight.airline` (booking.ts `optionalString`). */
  maxLength: number;
  error?: string;
  /** B-26: schema-derived required marker (passthrough to `Input`). */
  required?: boolean;
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

export function AirlinePickerField({
  label,
  value,
  onChangeText,
  settledValue,
  maxLength,
  error,
  required,
  testID,
}: AirlinePickerFieldProps) {
  const s = useStyles();
  // A PREFILLED field (edit mode) starts settled — opening a stored booking
  // must not fire a search or drop a result list for text the user never
  // typed. Lazy init: only the FIRST value decides.
  const [picked, setPicked] = useState(() => value !== "");
  // `useDeferredValue` lags one render, so a CLEARED field would otherwise
  // fire a search for the text the user just deleted (and immediately abort
  // it). Gate on the live value as well as the deferred one.
  const deferredQuery = useDeferredValue(value);
  // A host-committed value counts as settled while it is still on screen
  // untouched; typing changes `value` and the search resumes.
  const settled = picked || (settledValue !== undefined && settledValue === value);
  const liveQuery = settled || value.trim() === "" ? "" : deferredQuery;
  const searchActive = isSearchableReferenceQuery(liveQuery);
  const search = useAirlineSearch(liveQuery);
  const results = (search.data?.items ?? []).slice(0, MAX_RESULTS);

  const select = (airline: Airline): void => {
    setPicked(true);
    onChangeText(airline.name);
  };

  return (
    <View style={s.container}>
      <Input
        label={label}
        value={value}
        onChangeText={(next) => {
          if (picked) setPicked(false);
          onChangeText(next);
        }}
        placeholder="Airline or code — NH, All Nippon"
        autoCorrect={false}
        maxLength={maxLength}
        error={error}
        required={required}
        trailing={
          value !== "" ? (
            <Pressable
              onPress={() => {
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
            message="Airline search failed."
            onRetry={() => void search.refetch()}
            testID={`${testID}-error-search`}
          />
        ) : results.length === 0 ? null : (
          <View style={s.results}>
            {results.map((airline) => (
              <ListItem
                key={airline.iata}
                title={airline.name}
                subtitle={airline.iata}
                onPress={() => select(airline)}
                testID={`${testID}-result-${airline.iata}`}
              />
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}
