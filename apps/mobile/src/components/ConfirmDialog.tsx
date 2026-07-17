/**
 * ConfirmDialog (DS-9, spec §2.9, R-ds-18) — destructive actions execute
 * ONLY on explicit confirm. Scrim tap and Android back are CANCEL paths.
 * Children derive `{testID}-confirm` / `{testID}-cancel`.
 *
 * Haptics ride the Button defaults (§2.8): destructive confirm → `warning`,
 * plain confirm → `actionLight`, cancel (ghost) → none.
 *
 * Focus (R-ds-18/19): RN Modal moves iOS screen-reader focus into the modal
 * on present and restores on dismiss; `accessibilityViewIsModal` fences the
 * dialog card.
 */
import { createStyles } from "@gogo/tokens/react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { Button } from "./Button";
import { AppText } from "./Text";

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  /** Default `"Cancel"`. */
  cancelLabel?: string;
  /** Destructive styling + `warning` haptic on confirm. */
  destructive?: boolean;
  onConfirm(): void;
  onCancel(): void;
  /** Required (R-ds-20). */
  testID: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: t.color.bg.scrim,
      alignItems: "center",
      justifyContent: "center",
      padding: t.space[6],
    },
    dialog: {
      backgroundColor: t.color.bg.surfaceRaised,
      borderRadius: t.radius.lg,
      padding: t.space[5],
      gap: t.space[3],
      width: "100%",
      maxWidth: 360,
      ...t.elevation[4],
    },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: t.space[2],
      marginTop: t.space[2],
    },
  }),
);

export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
  testID,
}: ConfirmDialogProps) {
  const s = useStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        style={s.scrim}
        onPress={onCancel}
        testID={`${testID}-scrim`}
        accessibilityLabel="Dismiss dialog"
      >
        {/* Stop scrim-press from swallowing dialog taps. `accessible={false}`:
            RN 0.86 Pressable defaults accessible:true, which would flatten the
            whole card into ONE iOS a11y element — confirm/cancel unreachable
            via VoiceOver (R-ds-12/18). The responder grab needs no a11y-element
            status. */}
        <Pressable style={s.dialog} testID={testID} accessible={false} accessibilityViewIsModal>
          <AppText role="heading" accessibilityRole="header">
            {title}
          </AppText>
          {body !== undefined ? <AppText color="secondary">{body}</AppText> : null}
          <View style={s.actions}>
            <Button
              title={cancelLabel}
              onPress={onCancel}
              variant="ghost"
              testID={`${testID}-cancel`}
            />
            <Button
              title={confirmLabel}
              onPress={onConfirm}
              variant={destructive ? "destructive" : "primary"}
              testID={`${testID}-confirm`}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
