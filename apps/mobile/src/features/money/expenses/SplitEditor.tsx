/**
 * Four-way split editor (T-9.6 / CMON-3 — R-cmoney-9, §2.4): equal ·
 * exact · percent · shares behind a SegmentedControl, participant toggles
 * (toggled-out = share ABSENT, not zero), per-type per-member editors, and
 * the live resolved preview from the shared `computeShares` (the parent
 * evaluates once and passes the result down — one source for preview AND
 * save gating).
 *
 * Ex-member participants (edit mode — T-9.2 keeps departed payers'
 * history) render "Former member" and stay REMOVABLE but not re-addable:
 * the roster drives the toggle list, and the server rejects any CHANGED
 * shares payload naming a non-member (R-money-5 on incoming ids). The
 * parent owns that save gate; this editor just renders the rows.
 *
 * testIDs (§2.8): `expense-new-segment-split` (derives `-equal`/`-exact`/
 * `-percent`/`-shares`), `expense-new-toggle-participant-{userId}`,
 * `expense-new-input-share-{userId}`, `expense-new-input-percent-{userId}`,
 * `expense-new-stepper-weight-{userId}` (derives `-inc`/`-dec` — rule-4
 * compound derivation).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, Icon, Input, SegmentedControl } from "@/components";

import { moneyLabel } from "../money-format";
import {
  SPLIT_TYPE_LABELS,
  SPLIT_TYPES,
  type SplitEvaluation,
  type SplitFormState,
  type SplitType,
} from "./expense-form-model";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    editor: { gap: t.space[3] },
    memberBlock: { gap: t.space[2] },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[3],
      minHeight: t.touchTarget,
    },
    toggleLabel: { flex: 1 },
    stepper: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[3],
      paddingLeft: t.space[6],
    },
    stepperButton: {
      minWidth: 36,
      minHeight: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
    },
    indentedInput: { paddingLeft: t.space[6] },
    preview: {
      gap: t.space[1],
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.inset,
      padding: t.space[3],
    },
    previewRow: { flexDirection: "row", justifyContent: "space-between" },
  }),
);

/** One row per renderable participant (roster ∪ legacy split entries). */
export interface SplitParticipantRow {
  userId: string;
  name: string;
  /** In the toggled-in set. */
  active: boolean;
  /** Not on the current roster (legacy history) — removable only. */
  former: boolean;
}

export interface SplitEditorProps {
  currency: string;
  rows: SplitParticipantRow[];
  split: SplitFormState;
  evaluation: SplitEvaluation;
  /** R-cmoney-12: equal-detectable edit prefills show the hint. */
  equallySplitHint: boolean;
  nameFor(userId: string): string;
  onChange(split: SplitFormState): void;
}

function isSplitType(key: string): key is SplitType {
  return (SPLIT_TYPES as readonly string[]).includes(key);
}

export function SplitEditor({
  currency,
  rows,
  split,
  evaluation,
  equallySplitHint,
  nameFor,
  onChange,
}: SplitEditorProps) {
  const s = useStyles();
  const { theme } = useTheme();

  const toggle = (userId: string): void => {
    const active = split.participants.includes(userId);
    onChange({
      ...split,
      participants: active
        ? split.participants.filter((id) => id !== userId)
        : [...split.participants, userId],
    });
  };

  const setWeight = (userId: string, delta: number): void => {
    const current = split.weights[userId] ?? 1;
    const next = Math.max(1, current + delta);
    if (next === current) return;
    onChange({ ...split, weights: { ...split.weights, [userId]: next } });
  };

  return (
    <View style={s.editor}>
      <SegmentedControl
        segments={SPLIT_TYPES.map((type) => ({ key: type, label: SPLIT_TYPE_LABELS[type] }))}
        selectedKey={split.type}
        onChange={(key) => {
          if (isSplitType(key)) onChange({ ...split, type: key });
        }}
        testID="expense-new-segment-split"
      />

      {equallySplitHint && split.type === "exact" ? (
        <AppText role="caption" color="secondary" testID="expense-new-split-equal-hint">
          Split equally
        </AppText>
      ) : null}

      {rows.map((row) => {
        const label = row.name;
        return (
          <View key={row.userId} style={s.memberBlock}>
            <Pressable
              style={s.toggleRow}
              onPress={() => toggle(row.userId)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: row.active }}
              accessibilityLabel={`Include ${label} in the split`}
              testID={`expense-new-toggle-participant-${row.userId}`}
            >
              <Icon
                name={row.active ? "checkbox" : "square-outline"}
                size={22}
                color={row.active ? theme.color.primary.solid : theme.color.text.muted}
              />
              <AppText
                role="body"
                {...(row.former ? { color: "secondary" as const } : {})}
                style={s.toggleLabel}
              >
                {label}
              </AppText>
            </Pressable>

            {row.active && split.type === "exact" ? (
              <View style={s.indentedInput}>
                <Input
                  label={`${row.name} amount`}
                  value={split.exactText[row.userId] ?? ""}
                  onChangeText={(value) =>
                    onChange({
                      ...split,
                      exactText: { ...split.exactText, [row.userId]: value },
                    })
                  }
                  placeholder="0"
                  keyboardType="decimal-pad"
                  maxLength={13}
                  testID={`expense-new-input-share-${row.userId}`}
                />
              </View>
            ) : null}

            {row.active && split.type === "percent" ? (
              <View style={s.indentedInput}>
                <Input
                  label={`${row.name} percent`}
                  value={split.percentText[row.userId] ?? ""}
                  onChangeText={(value) =>
                    onChange({
                      ...split,
                      percentText: { ...split.percentText, [row.userId]: value },
                    })
                  }
                  placeholder="0"
                  keyboardType="decimal-pad"
                  maxLength={6}
                  testID={`expense-new-input-percent-${row.userId}`}
                />
              </View>
            ) : null}

            {row.active && split.type === "shares" ? (
              <View style={s.stepper} testID={`expense-new-stepper-weight-${row.userId}`}>
                <Pressable
                  style={s.stepperButton}
                  onPress={() => setWeight(row.userId, -1)}
                  accessibilityRole="button"
                  accessibilityLabel={`Decrease shares for ${row.name}`}
                  testID={`expense-new-stepper-weight-${row.userId}-dec`}
                >
                  <Icon name="remove" size={18} color={theme.color.text.primary} />
                </Pressable>
                <AppText role="bodyStrong">{split.weights[row.userId] ?? 1}</AppText>
                <Pressable
                  style={s.stepperButton}
                  onPress={() => setWeight(row.userId, 1)}
                  accessibilityRole="button"
                  accessibilityLabel={`Increase shares for ${row.name}`}
                  testID={`expense-new-stepper-weight-${row.userId}-inc`}
                >
                  <Icon name="add" size={18} color={theme.color.text.primary} />
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      })}

      {evaluation.readout !== null ? (
        <AppText
          role="caption"
          {...(evaluation.ok ? { color: "secondary" as const } : {})}
          accessibilityLiveRegion="polite"
          testID="expense-new-split-readout"
        >
          {evaluation.readout}
        </AppText>
      ) : null}

      {evaluation.ok ? (
        <View style={s.preview} testID="expense-new-split-preview">
          {evaluation.shares.map((share) => (
            <View key={share.user_id} style={s.previewRow}>
              <AppText role="caption" color="secondary">
                {nameFor(share.user_id)}
              </AppText>
              <AppText role="caption">{moneyLabel(share.share_cents, currency)}</AppText>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
