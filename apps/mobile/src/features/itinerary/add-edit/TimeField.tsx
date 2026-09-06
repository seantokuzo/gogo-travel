/**
 * Time field (T-7.6 / IT-5+IT-7) — the DateField pattern (features/trips)
 * applied to a wall-clock `HH:MM` value: a pressable field row toggles the
 * platform time picker (`@react-native-community/datetimepicker`,
 * mode="time"). The picker is the only input, so the wire `ISOTime` shape
 * is correct by construction. Optional times get a Clear affordance
 * (`{testID}-clear`) — schedule/add flows treat "" as all-day/absent.
 *
 * B-10c: an unset field used to open the spinner at 12:00 regardless of
 * context. `contextTime` mirrors DateField's `contextDate` — a flight's
 * arrival seeds from its entered departure time — falling back to noon.
 * Seed only: the picked value is untouched.
 *
 * PRESENTATION (B-15b): the iOS spinner's fixed intrinsic width overflowed
 * the right screen edge in half-width form rows (itinerary item forms —
 * device QA 2026-09-06), the same failure the inline calendar had in B-10a.
 * The picker now presents in the shared `PickerCard` bottom modal (screen-
 * anchored; extracted from DateField — the PR #40 conventions lane predicted
 * this second consumer). Commit semantics are UNCHANGED: a spinner change
 * still commits & closes through `onValueChange`; the card's Done commits
 * the DISPLAYED (seeded) time — B-15a parity, since iOS fires only on
 * change and a context-seeded time was otherwise uncommittable.
 *
 * testIDs mirror DateField's derivation: row `{testID}`, revealed picker
 * `{testID}-picker`, error `{testID}-error`, clear `{testID}-clear`; the
 * iOS card ids ({testID}-sheet, -sheet-done, -sheet-close, -sheet-scrim)
 * derive inside PickerCard.
 */
import DateTimePicker from "@react-native-community/datetimepicker";
import type { ISOTime } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View } from "react-native";

import { AppText, PickerCard } from "@/components";

export interface TimeFieldProps {
  label: string;
  /** Wall `HH:MM`, or `""` when unset. */
  value: ISOTime | "";
  onSelect(value: ISOTime): void;
  /** B-10c: where the spinner OPENS when `value` is empty. Noon when absent/"". */
  contextTime?: ISOTime | "";
  /** Present ⇒ the field is clearable (optional time semantics). */
  onClear?(): void;
  /** Error state — replaces the helper slot, danger border (Input parity). */
  error?: string;
  /** Required (R-ds-20). */
  testID: string;
}

/** Wall `HH:MM` (or "") → a local Date carrying that time-of-day. */
export function timeToPickerDate(value: ISOTime | ""): Date {
  const [h, m] = value === "" ? [12, 0] : value.split(":").map(Number);
  return new Date(2000, 0, 1, h ?? 12, m ?? 0);
}

/** B-10c seed resolution: value wins; else the context time; else noon. */
export function timePickerSeed(value: ISOTime | "", contextTime?: ISOTime | ""): Date {
  if (value !== "") return timeToPickerDate(value);
  if (contextTime !== undefined && contextTime !== "") return timeToPickerDate(contextTime);
  return timeToPickerDate("");
}

/** Local Date → wall `HH:MM` (device-clock components — no tz math). */
export function pickerDateToTime(date: Date): ISOTime {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: { gap: t.space[1] },
    labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
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

export function TimeField({
  label,
  value,
  onSelect,
  contextTime,
  onClear,
  error,
  testID,
}: TimeFieldProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const hasError = error !== undefined && error.length > 0;
  const close = () => setOpen(false);
  // B-15a parity: commit the DISPLAYED time. A spun change commits & closes
  // through `onValueChange` before Done is reachable, so the displayed time
  // is always the seed (value > context > noon).
  const confirmDisplayed = () => {
    onSelect(pickerDateToTime(timePickerSeed(value, contextTime)));
    setOpen(false);
  };

  const picker = open ? (
    <DateTimePicker
      testID={`${testID}-picker`}
      value={timePickerSeed(value, contextTime)}
      mode="time"
      display={Platform.OS === "ios" ? "spinner" : "default"}
      onValueChange={(_event, date) => {
        onSelect(pickerDateToTime(date));
        setOpen(false);
      }}
      onDismiss={close}
    />
  ) : null;

  return (
    <View style={s.container}>
      <View style={s.labelRow}>
        <AppText role="caption" color="secondary">
          {label}
        </AppText>
        {onClear !== undefined && value !== "" ? (
          <Pressable
            onPress={() => {
              setOpen(false);
              onClear();
            }}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            testID={`${testID}-clear`}
          >
            <AppText role="caption" color="secondary">
              Clear
            </AppText>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        testID={testID}
        onPress={() => {
          // B-15c: opening a picker over an armed keyboard left typing
          // routed into the previously-focused input (device QA 2026-09-06).
          // Keyboard.dismiss() BLURS the focused TextInput (its RN
          // implementation is TextInputState.blurTextInput(currentlyFocused)),
          // so one call covers both halves: keyboard down + focus cleared.
          if (!open) Keyboard.dismiss();
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityLabel={value === "" ? `${label}, select time` : `${label}, ${value}`}
        style={[s.field, open && s.fieldOpen, hasError && s.fieldError]}
      >
        <AppText color={value === "" ? "muted" : "primary"}>
          {value === "" ? "Select time" : value}
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
