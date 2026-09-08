/**
 * Date field for the create-trip range picker (T-6.7 R1; trips spec §2.3
 * point 3 — "required range picker"). Two of these compose the range under
 * the `trip-new-input-dates` container: a pressable field row that reveals
 * the platform date PICKER (`@react-native-community/datetimepicker` —
 * native calendar). Typed text entry is gone: the picker is the only input,
 * so the wire format (`YYYY-MM-DD`) is correct by construction and the
 * shared schema's date-order rule is the only reachable validation error.
 *
 * PRESENTATION (B-10a): on iOS the `inline` calendar has a fixed intrinsic
 * width (~320pt), so rendering it in the pressed field's own column
 * overflowed the screen edge whenever the field was half-width (trip-new's
 * `datesRow`) — half the day cells were untappable. The picker now presents
 * in the shared `PickerCard` — a bottom MODAL CARD anchored to the SCREEN,
 * never to the field's column (extracted for TimeField, B-15b; the card
 * carries the plain-Modal-not-DS-Sheet rationale). Android keeps its
 * self-anchoring native dialog — it never had the overflow.
 *
 * EMPTY-VALUE SEED (B-10b): an unset field used to open on TODAY, which for
 * a far-future trip meant paging month-by-month by hand (recurred across
 * screens — device QA 2026-08-29). `contextDate` lets every caller seed the
 * picker with the date the user is *near* — the sibling of a range, the
 * trip's start, a flight's departure for its arrival — falling back to
 * today only when no context exists. The picked VALUE is untouched: the
 * seed is where the calendar opens, nothing more.
 *
 * ISO ↔ Date conversion is LOCAL-calendar at noon: wire dates are calendar
 * days in the user's tz (trips spec §3.4 semantics); noon keeps DST edges
 * from shifting the day. `onValueChange`/`onDismiss` are the picker's
 * non-deprecated callbacks (its `onChange` warns in dev).
 *
 * ONE-TAP COMMIT (B-15a): the iOS inline calendar fires `onValueChange` only
 * on a value CHANGE, so tapping the already-highlighted seeded day is a
 * native no-op — device QA 2026-09-06 confirmed the seeded-open path was
 * uncommittable. The modal header's Done button is the committed one-action
 * path: it selects the DISPLAYED day (the seed — a change commits & closes
 * immediately, so the display can never drift from it) and closes. Close/
 * scrim stay cancel-without-selecting.
 *
 * testIDs (nav §2.7 rule-4 derivation from the field's base): the row is
 * `{testID}`, the revealed picker `{testID}-picker`, the error text
 * `{testID}-error` (mirrors the DS Input's derived error id so the form's
 * assertions stay uniform); the iOS modal card ids ({testID}-sheet,
 * -sheet-done, -sheet-close, -sheet-scrim) derive inside PickerCard.
 */
import DateTimePicker from "@react-native-community/datetimepicker";
import type { ISODate } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useCallback, useState } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View } from "react-native";

import { AppText, PickerCard, usePickerFocus } from "@/components";

import { formatFieldDate } from "./sections";

export interface DateFieldProps {
  label: string;
  /** ISO `YYYY-MM-DD`, or `""` when unset. */
  value: ISODate | "";
  onSelect(value: ISODate): void;
  /**
   * B-10b: where the calendar OPENS when `value` is empty — the sibling date
   * of a range, the trip start, a flight's departure. Today when absent/"".
   * Never affects a set value and never becomes the value itself.
   */
  contextDate?: ISODate | "";
  /** Error state — replaces the helper slot, danger border (Input parity). */
  error?: string;
  /** Required (R-ds-20). */
  testID: string;
}

/** ISO calendar day → local Date at noon (DST-safe day identity). */
export function isoToPickerDate(iso: ISODate | ""): Date {
  if (iso === "") return new Date();
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
}

/**
 * B-10b seed resolution: value wins; an empty value seeds from the context
 * date; no context ⇒ today (the picker needs a valid anchor).
 */
export function pickerSeedDate(value: ISODate | "", contextDate?: ISODate | ""): Date {
  if (value !== "") return isoToPickerDate(value);
  if (contextDate !== undefined && contextDate !== "") return isoToPickerDate(contextDate);
  return new Date();
}

/** Local Date → ISO calendar day in the DEVICE tz (what §2.5 evaluates). */
export function pickerDateToISO(date: Date): ISODate {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
  }),
);

export function DateField({ label, value, onSelect, contextDate, error, testID }: DateFieldProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  // PR #49 R1 capture invariant: the seed is computed ONCE, in the press
  // that opens, and BOTH the picker's `value` and Done read the capture.
  // `pickerSeedDate`'s no-context fallback is `new Date()` — recomputing at
  // Done-press would let the clock cross midnight between open and commit
  // (23:59:50 open shows today; 00:00:05 Done would commit tomorrow).
  const [seed, setSeed] = useState<Date>(() => pickerSeedDate(value, contextDate));
  const hasError = error !== undefined && error.length > 0;
  // Stable identity: usePickerFocus keys its claim slot on this function.
  const close = useCallback(() => setOpen(false), []);
  // B-15d: opening this picker closes any other open picker in the family.
  usePickerFocus(open, close);
  // B-15a: commit the DISPLAYED day. A changed day commits & closes through
  // `onValueChange` before Done is ever reachable, so the displayed day is
  // always the captured seed (value > context > today at OPEN time) —
  // tapping the pre-highlighted day itself never fires natively (iOS
  // change-only semantics).
  const confirmDisplayed = () => {
    onSelect(pickerDateToISO(seed));
    setOpen(false);
  };

  const picker = open ? (
    <DateTimePicker
      testID={`${testID}-picker`}
      value={seed}
      mode="date"
      display={Platform.OS === "ios" ? "inline" : "default"}
      onValueChange={(_event, date) => {
        onSelect(pickerDateToISO(date));
        setOpen(false);
      }}
      onDismiss={close}
    />
  ) : null;

  return (
    <View style={s.container}>
      <AppText role="caption" color="secondary">
        {label}
      </AppText>
      <Pressable
        testID={testID}
        onPress={() => {
          // B-15c: opening a picker over an armed keyboard left typing
          // routed into the previously-focused input (device QA 2026-09-06).
          // Keyboard.dismiss() BLURS the focused TextInput (its RN
          // implementation is TextInputState.blurTextInput(currentlyFocused)),
          // so one call covers both halves: keyboard down + focus cleared.
          if (!open) {
            Keyboard.dismiss();
            // PR #49 R1: every open RE-captures the seed (see the invariant
            // note above) — a stale capture would drift across reopens.
            setSeed(pickerSeedDate(value, contextDate));
          }
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityLabel={value === "" ? `${label}, select date` : `${label}, ${value}`}
        style={[s.field, open && s.fieldOpen, hasError && s.fieldError]}
      >
        <AppText color={value === "" ? "muted" : "primary"}>
          {value === "" ? "Select date" : formatFieldDate(value)}
        </AppText>
      </Pressable>
      <PickerCard
        label={label}
        visible={open}
        onDone={confirmDisplayed}
        onClose={close}
        testID={testID}
      >
        {picker}
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
