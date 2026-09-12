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
 *
 * PRESENTATION (B-26, device QA 2026-09-11 — Sean: "when it opens I can't
 * manually scroll the options"). It used to drop an inline `View` of at
 * most 12 `.map()`ed rows into the form. Two defects in one construction:
 *
 *  1. **Nothing scrolled.** The options had no scroll container of their
 *     own, so 406 of the 418 zones were unreachable by scrolling — the only
 *     way to a zone outside the first 12 catalog rows was to guess a query
 *     that matched it. Scrolling the PAGE just moved the whole form.
 *  2. **`.map()` over a long list** — the `.claude/rules/mobile.md` rule
 *     (long lists virtualize) exists for exactly this list.
 *
 * The fix cannot be "wrap the inline rows in a FlatList": this field renders
 * inside the item/new screen's `ScrollView`, and a same-orientation
 * `VirtualizedList` nested in a plain `ScrollView` is the
 * "VirtualizedLists should never be nested" error
 * (`@react-native/virtualized-lists` `VirtualizedList.js:1165`) — the same
 * trap `features/profile/SessionsSection.tsx` documents avoiding. So the
 * list moves OUT of the scroll tree into the shared `PickerCard` modal (the
 * DS shell the date/time fields already use here, generalized in B-26 with
 * `alwaysModal` + an optional Done), where a `FlatList` gets real bounds and
 * scrolls. The keyboard-search flow is unchanged — the same
 * `{testID}-search` input, now inside the card and above the list, with
 * `keyboardShouldPersistTaps="handled"` so the first tap on a row picks it
 * instead of only dismissing the keyboard.
 */
import { createStyles } from "@gogo/tokens/react";
import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";

import { AppText, Input, ListItem, PickerCard, usePickerFocus } from "@/components";

import { searchTimeZones, timeZoneSlug, type TimeZoneEntry } from "./time-zone-catalog";
import { describeTimeZone, referenceInstantFor } from "./zoned-time";

/**
 * Rows rendered before the virtualizer takes over. The list is bounded by
 * the card, not by a result cap — B-26 retired the 12-row cap that made the
 * other ~406 zones unreachable.
 */
const INITIAL_ROWS = 14;

/** Card height ceiling, as a fraction of the window (DS Sheet's 85% posture). */
const CARD_HEIGHT_FRACTION = 0.7;

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
    cardBody: { gap: t.space[2] },
    results: {
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.surface,
      overflow: "hidden",
    },
    empty: { padding: t.space[3] },
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
  const { height: windowHeight } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const hasError = error !== undefined && error.length > 0;
  const atUtcMs = referenceInstantFor(referenceDate);
  // Stable identity: usePickerFocus keys its claim slot on this function.
  const close = useCallback(() => setOpen(false), []);
  // B-15d: opening this picker closes any other open picker in the family —
  // a date spinner left open under this card is the exact double-open state
  // that hook exists for.
  usePickerFocus(open, close);

  // Bounded by the CARD, not by a result cap: the whole filtered catalog is
  // handed to the virtualizer, which renders a window of it.
  const results: TimeZoneEntry[] = open ? searchTimeZones(query) : [];
  const listMaxHeight = Math.round(windowHeight * CARD_HEIGHT_FRACTION);

  const dismiss = (): void => {
    setQuery("");
    close();
  };

  return (
    <View style={s.container}>
      <AppText role="caption" color="secondary">
        {label}
      </AppText>
      <Pressable
        testID={testID}
        onPress={() => (open ? dismiss() : setOpen(true))}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${zoneFieldLabel(value, atUtcMs)}`}
        style={[s.field, open && s.fieldOpen, hasError && s.fieldError]}
      >
        <AppText color={value === "" ? "muted" : "primary"}>
          {zoneFieldLabel(value, atUtcMs)}
        </AppText>
      </Pressable>
      {/* No `onDone`: a zone commits on the row tap, so there is no
          "displayed value" to confirm (B-26 — PickerCard's Done is the
          B-15a native-spinner affordance and would be a dead button here). */}
      <PickerCard label={label} visible={open} onClose={dismiss} alwaysModal testID={testID}>
        {open ? (
          <View style={s.cardBody}>
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
            {results.length === 0 ? (
              <View style={[s.results, s.empty]}>
                <AppText role="caption" color="muted" testID={`${testID}-empty`}>
                  No time zones matched — try the city, the region (&quot;Europe&quot;) or the
                  country code.
                </AppText>
              </View>
            ) : (
              <View style={s.results}>
                <FlatList
                  style={{ maxHeight: listMaxHeight }}
                  data={results}
                  keyExtractor={(entry) => entry.id}
                  initialNumToRender={INITIAL_ROWS}
                  // Without this the first tap on a row only dismisses the
                  // keyboard (MapSearch precedent).
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  testID={`${testID}-list`}
                  renderItem={({ item: entry }) => (
                    <ListItem
                      title={zoneRowTitle(entry.id, entry.city, atUtcMs)}
                      subtitle={entry.id}
                      onPress={() => {
                        onSelect(entry.id);
                        setQuery("");
                        close();
                      }}
                      testID={`${testID}-result-${timeZoneSlug(entry.id)}`}
                    />
                  )}
                />
              </View>
            )}
          </View>
        ) : null}
      </PickerCard>
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
