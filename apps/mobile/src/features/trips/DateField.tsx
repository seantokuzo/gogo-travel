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
 * in a bottom MODAL CARD anchored to the SCREEN, never to the field's
 * column. Deliberately a plain RN `Modal` (native `fade`, no JS animation
 * timers), NOT the DS Sheet: the Sheet's ~duration.base Animated exit would
 * tax every date-picking suite with an act-drain (the "SHEET TAX" landmine),
 * and DateField already renders INSIDE a Sheet (ScheduleSheet) where nesting
 * the DS component would stack two scrim/gesture systems. Android keeps its
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
 * testIDs (nav §2.7 rule-4 derivation from the field's base): the row is
 * `{testID}`, the revealed picker `{testID}-picker`, the error text
 * `{testID}-error` (mirrors the DS Input's derived error id so the form's
 * assertions stay uniform); the iOS modal card is `{testID}-sheet` with
 * `{testID}-sheet-close` / `{testID}-sheet-scrim` dismissal affordances.
 */
import DateTimePicker from "@react-native-community/datetimepicker";
import type { ISODate } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, Icon } from "@/components";

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
    // B-10a modal card — screen-anchored bottom card, full usable width, so
    // the inline calendar's intrinsic ~320pt always fits on-screen.
    modalRoot: { flex: 1, justifyContent: "flex-end" },
    modalScrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.color.bg.scrim,
    },
    modalCard: {
      backgroundColor: t.color.bg.surfaceRaised,
      borderTopLeftRadius: t.radius.xl,
      borderTopRightRadius: t.radius.xl,
      paddingHorizontal: t.space[4],
      paddingTop: t.space[3],
      ...t.elevation[3],
    },
    modalHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingBottom: t.space[2],
    },
    modalClose: {
      minWidth: 32,
      minHeight: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radius.full,
      backgroundColor: t.color.bg.inset,
    },
  }),
);

export function DateField({
  label,
  value,
  onSelect,
  contextDate,
  error,
  testID,
}: DateFieldProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const hasError = error !== undefined && error.length > 0;
  const close = () => setOpen(false);

  const picker = open ? (
    <DateTimePicker
      testID={`${testID}-picker`}
      value={pickerSeedDate(value, contextDate)}
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
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel={value === "" ? `${label}, select date` : `${label}, ${value}`}
        style={[s.field, open && s.fieldOpen, hasError && s.fieldError]}
      >
        <AppText color={value === "" ? "muted" : "primary"}>
          {value === "" ? "Select date" : formatFieldDate(value)}
        </AppText>
      </Pressable>
      {Platform.OS === "ios" ? (
        <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
          <View style={s.modalRoot}>
            <Pressable
              style={s.modalScrim}
              onPress={close}
              accessibilityLabel={`Dismiss ${label} picker`}
              testID={`${testID}-sheet-scrim`}
            />
            <View
              style={[s.modalCard, { paddingBottom: insets.bottom + theme.space[4] }]}
              accessibilityViewIsModal
              testID={`${testID}-sheet`}
            >
              <View style={s.modalHeader}>
                <AppText role="subheading" accessibilityRole="header">
                  {label}
                </AppText>
                <Pressable
                  onPress={close}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={theme.hitSlop.sm}
                  style={s.modalClose}
                  testID={`${testID}-sheet-close`}
                >
                  <Icon name="close" size={18} color={theme.color.text.secondary} />
                </Pressable>
              </View>
              {picker}
            </View>
          </View>
        </Modal>
      ) : (
        picker
      )}
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
