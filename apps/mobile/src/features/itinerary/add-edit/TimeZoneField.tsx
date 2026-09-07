/**
 * Per-endpoint time-zone picker (B-9 client half — B-8's "the minimum is a
 * tz picker" made literal).
 *
 * ALWAYS VISIBLE next to the time it stamps: the whole B-8 failure was a
 * zone the user never saw being applied silently. Labels are CITY-first
 * ("Athens — GMT+2"), never a bare offset — an offset alone can't tell
 * Athens from Cairo in July, and picking one would re-introduce the
 * uniform-offset class this field exists to kill.
 *
 * Search is LOCAL over the static tzdb catalog (`time-zone-catalog.ts`) —
 * Hermes has no `Intl.supportedValuesOf`, and a ~420-row list has no
 * business being a network round-trip.
 *
 * A flight endpoint whose airport was PICKED gets its zone from the pick
 * (`AirportPickerField` → `onPickAirport`); this field is the ladder's next
 * rung — trains (no station table exists), and any endpoint typed as free
 * text without a pick. `value === ""` renders as an explicit unset state,
 * because a stored row that predates zone capture has no zone and inventing
 * one would silently re-stamp it.
 */
import { createStyles } from "@gogo/tokens/react";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, Input, ListItem } from "@/components";

import { searchTimeZones, timeZoneSlug } from "./time-zone-catalog";
import { describeTimeZone, referenceInstantFor } from "./zoned-time";

/** Bounded render — the catalog is ~420 rows; a picker shows a handful. */
const MAX_RESULTS = 12;

export interface TimeZoneFieldProps {
  label: string;
  /** IANA zone id, or `""` when the stamped zone is not known yet. */
  value: string;
  onSelect(tz: string): void;
  /**
   * Wall date the zone's offset is DESCRIBED at — "GMT-7" in April,
   * "GMT-8" in January for the same zone. Display only; the composed
   * instant resolves its own offset at its own wall time.
   */
  referenceDate?: string;
  error?: string;
  /** Required (R-ds-20). */
  testID: string;
}

/** "Tokyo — GMT+9", or the raw id when the device's ICU can't resolve it. */
export function zoneFieldLabel(tz: string, atUtcMs: number): string {
  if (tz === "") return "Not set — choose a time zone";
  const described = describeTimeZone(tz, atUtcMs);
  return described === null ? tz : `${described.city} — ${described.gmt}`;
}

/**
 * One picker row's title. B-9 R1: goes through `describeTimeZone`, NOT a
 * bare `zoneOffsetMinutesAt` — the raw read throws `RangeError` on an engine
 * that omits a part, and this runs inside `render` for every visible row
 * (a white screen, not a degraded label).
 */
function zoneRowTitle(id: string, city: string, atUtcMs: number): string {
  const described = describeTimeZone(id, atUtcMs);
  return described === null ? city : `${city} — ${described.gmt}`;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: { gap: t.space[1] },
    field: {
      minHeight: t.touchTarget,
      justifyContent: "center",
      backgroundColor: t.color.bg.inset,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
    },
    fieldOpen: { borderColor: t.color.border.focus },
    fieldError: { borderColor: t.color.status.danger.border },
    errorText: { color: t.color.status.danger.fg },
    results: {
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.surface,
    },
  }),
);

export function TimeZoneField({
  label,
  value,
  onSelect,
  referenceDate,
  error,
  testID,
}: TimeZoneFieldProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const hasError = error !== undefined && error.length > 0;
  const atUtcMs = referenceInstantFor(referenceDate);
  const close = useCallback(() => setOpen(false), []);

  const results = open ? searchTimeZones(query, MAX_RESULTS) : [];

  return (
    <View style={s.container}>
      <AppText role="caption" color="secondary">
        {label}
      </AppText>
      <Pressable
        testID={testID}
        onPress={() => (open ? close() : setOpen(true))}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${zoneFieldLabel(value, atUtcMs)}`}
        style={[s.field, open && s.fieldOpen, hasError && s.fieldError]}
      >
        <AppText color={value === "" ? "muted" : "primary"}>
          {zoneFieldLabel(value, atUtcMs)}
        </AppText>
      </Pressable>
      {open ? (
        <>
          <Input
            label="Search time zones"
            value={query}
            onChangeText={setQuery}
            placeholder="City, region or country code"
            autoCorrect={false}
            autoCapitalize="none"
            maxLength={64}
            testID={`${testID}-search`}
          />
          <View style={s.results}>
            {results.map((entry) => (
              <ListItem
                key={entry.id}
                title={zoneRowTitle(entry.id, entry.city, atUtcMs)}
                subtitle={entry.id}
                onPress={() => {
                  onSelect(entry.id);
                  setQuery("");
                  close();
                }}
                testID={`${testID}-result-${timeZoneSlug(entry.id)}`}
              />
            ))}
          </View>
        </>
      ) : null}
      {hasError ? (
        <AppText
          role="caption"
          style={s.errorText}
          accessibilityLiveRegion="polite"
          testID={`${testID}-error`}
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
