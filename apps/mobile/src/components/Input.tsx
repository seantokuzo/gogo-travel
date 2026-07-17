/**
 * Input (DS-8, spec §2.9) — label ALWAYS visible (no placeholder-as-label).
 * Error state: danger border + the helper slot shows the error, announced to
 * AT via accessibilityLiveRegion. `testID` lands on the TextInput itself —
 * that's what E2E types into (R-ds-20).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { KeyboardTypeOptions, ReturnKeyTypeOptions, TextInputProps } from "react-native";

import { AppText } from "./Text";

export interface InputProps {
  label: string;
  value: string;
  onChangeText(value: string): void;
  placeholder?: string;
  helper?: string;
  /** Error state — replaces `helper` in the slot, danger border (R-ds-17 kin). */
  error?: string;
  /** Icons, currency prefix. */
  leading?: ReactNode;
  /** Icons, clear button. */
  trailing?: ReactNode;
  secureTextEntry?: boolean;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoComplete?: TextInputProps["autoComplete"];
  returnKeyType?: ReturnKeyTypeOptions;
  /** Required (R-ds-20). */
  testID: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: { gap: t.space[1] },
    field: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: t.touchTarget,
      backgroundColor: t.color.bg.inset,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
      gap: t.space[2],
    },
    fieldFocused: { borderColor: t.color.border.focus },
    fieldError: { borderColor: t.color.status.danger.border },
    fieldMultiline: { alignItems: "flex-start", paddingVertical: t.space[2], minHeight: 88 },
    input: {
      flex: 1,
      // Style keys only — maxFontSizeMultiplier is a PROP (R-ds-10), set below.
      fontSize: t.type.body.fontSize,
      lineHeight: t.type.body.lineHeight,
      fontWeight: t.type.body.fontWeight,
      color: t.color.text.primary,
      paddingVertical: t.space[2],
    },
    inputMultiline: { textAlignVertical: "top" },
    errorText: { color: t.color.status.danger.fg },
  }),
);

export function Input({
  label,
  value,
  onChangeText,
  placeholder,
  helper,
  error,
  leading,
  trailing,
  secureTextEntry,
  multiline,
  keyboardType,
  autoComplete,
  returnKeyType,
  testID,
}: InputProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const [focused, setFocused] = useState(false);
  const hasError = error !== undefined && error.length > 0;

  return (
    <View style={s.container}>
      <AppText role="caption" color="secondary">
        {label}
      </AppText>
      <View
        style={[
          s.field,
          multiline && s.fieldMultiline,
          focused && s.fieldFocused,
          hasError && s.fieldError,
        ]}
      >
        {leading !== undefined ? <View>{leading}</View> : null}
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.color.text.muted}
          secureTextEntry={secureTextEntry}
          multiline={multiline}
          keyboardType={keyboardType}
          autoComplete={autoComplete}
          returnKeyType={returnKeyType}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label}
          maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier}
          style={[s.input, multiline && s.inputMultiline]}
        />
        {trailing !== undefined ? <View>{trailing}</View> : null}
      </View>
      {hasError ? (
        <AppText
          role="caption"
          style={s.errorText}
          accessibilityLiveRegion="polite"
          testID={`${testID}-error`}
        >
          {error}
        </AppText>
      ) : helper !== undefined ? (
        <AppText role="caption" color="muted">
          {helper}
        </AppText>
      ) : null}
    </View>
  );
}
