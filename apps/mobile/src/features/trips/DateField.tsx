/**
 * Date field for the create-trip range picker (T-6.7 R1; trips spec §2.3
 * point 3 — "required range picker"). Two of these compose the range under
 * the `trip-new-input-dates` container: a pressable field row that toggles
 * the platform date PICKER (`@react-native-community/datetimepicker` —
 * native calendar; iOS `inline`, Android dialog). Typed text entry is gone:
 * the picker is the only input, so the wire format (`YYYY-MM-DD`) is
 * correct by construction and the shared schema's date-order rule is the
 * only reachable validation error.
 *
 * ISO ↔ Date conversion is LOCAL-calendar at noon: wire dates are calendar
 * days in the user's tz (trips spec §3.4 semantics); noon keeps DST edges
 * from shifting the day. `onValueChange`/`onDismiss` are the picker's
 * non-deprecated callbacks (its `onChange` warns in dev).
 *
 * testIDs (nav §2.7 rule-4 derivation from the field's base): the row is
 * `{testID}`, the revealed picker `{testID}-picker`, the error text
 * `{testID}-error` (mirrors the DS Input's derived error id so the form's
 * assertions stay uniform).
 */
import DateTimePicker from "@react-native-community/datetimepicker";
import type { ISODate } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/components";

import { formatFieldDate } from "./sections";

export interface DateFieldProps {
  label: string;
  /** ISO `YYYY-MM-DD`, or `""` when unset. */
  value: ISODate | "";
  onSelect(value: ISODate): void;
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

export function DateField({ label, value, onSelect, error, testID }: DateFieldProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const hasError = error !== undefined && error.length > 0;

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
      {open ? (
        <DateTimePicker
          testID={`${testID}-picker`}
          value={isoToPickerDate(value)}
          mode="date"
          display={Platform.OS === "ios" ? "inline" : "default"}
          onValueChange={(_event, date) => {
            onSelect(pickerDateToISO(date));
            setOpen(false);
          }}
          onDismiss={() => setOpen(false)}
        />
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
