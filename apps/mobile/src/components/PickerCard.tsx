/**
 * PickerCard (B-15b) — per-platform presentation shell for the native
 * date/time pickers, extracted from DateField for its second consumer
 * (TimeField's iOS spinner overflowed the right screen edge exactly the way
 * the B-10a inline calendar did; the PR #40 conventions lane predicted this
 * consumer and recorded "extract, don't copy-paste"). On iOS the children
 * present in a bottom MODAL CARD anchored to the SCREEN — never to the
 * field's column, whose width the pickers' fixed intrinsic sizes overflow.
 * On Android the children render as-is: the native pickers there are
 * self-anchoring dialogs that never had the overflow.
 *
 * Deliberately a plain RN `Modal` (native `fade`, no JS animation timers),
 * NOT the DS Sheet: the Sheet's ~duration.base Animated exit would tax every
 * picker suite with an act-drain (the "SHEET TAX" landmine), and the fields
 * render INSIDE a Sheet (ScheduleSheet) where nesting the DS component would
 * stack two scrim/gesture systems.
 *
 * Header (B-15a): Done COMMITS the displayed value — iOS pickers fire
 * `onValueChange` only on a value CHANGE, so a seeded value is otherwise
 * uncommittable one-tap. Close X and the scrim cancel without selecting.
 *
 * B-26 generalization (device QA 2026-09-11): a picker whose content is OUR
 * OWN list, not a native dialog, needs the same card on EVERY platform and
 * has no "displayed value" to commit — hence `alwaysModal` and an OPTIONAL
 * `onDone`. Both are additive; the date/time consumers' behavior is
 * unchanged. The card is keyboard-avoiding so a searchable list picker's
 * input is not buried under the keyboard (a no-op for the native pickers,
 * which focus nothing).
 *
 * testIDs derive from the owning FIELD's base id (nav §2.7 rule-4):
 * card `{testID}-sheet`, commit `{testID}-sheet-done`, cancel
 * `{testID}-sheet-close` / `{testID}-sheet-scrim`.
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "./Icon";
import { AppText } from "./Text";

export interface PickerCardProps {
  /** Field label — the card's header title + a11y naming for its actions. */
  label: string;
  /** Whether the picker is open (iOS: modal visibility). */
  visible: boolean;
  /**
   * Commit the DISPLAYED value and close (the B-15a Done affordance).
   * OMIT when the content commits on selection and has no displayed value to
   * confirm — no Done button renders (B-26).
   */
  onDone?(): void;
  /** Dismiss WITHOUT selecting (close X, scrim, hardware back). */
  onClose(): void;
  /**
   * Present the card on EVERY platform (B-26). Default `false` = the
   * original posture: iOS card, Android bare children, because Android's
   * NATIVE date/time dialogs self-anchor. Content that is not a native
   * dialog must set this — bare children on Android would render an
   * unbounded list inline.
   */
  alwaysModal?: boolean;
  /** Owning field's base testID — card ids derive from it (R-ds-20). */
  testID: string;
  /** The platform picker (callers pass `null` while closed). */
  children: ReactNode;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    // B-10a modal card — screen-anchored bottom card, full usable width, so
    // the pickers' intrinsic sizes (calendar ~320pt, spinner) always fit.
    modalRoot: { flex: 1, justifyContent: "flex-end" },
    // B-26: the avoider owns the bottom anchor so its keyboard padding
    // pushes the card up rather than stretching it.
    modalAvoider: { justifyContent: "flex-end" },
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
    // B-15a: Done + close cluster on the header's trailing edge.
    modalActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[3],
    },
    modalDone: {
      minHeight: 32,
      justifyContent: "center",
      paddingHorizontal: t.space[2],
    },
    modalDoneText: { color: t.color.text.accent },
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

export function PickerCard({
  label,
  visible,
  onDone,
  onClose,
  alwaysModal = false,
  testID,
  children,
}: PickerCardProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();

  if (Platform.OS !== "ios" && !alwaysModal) {
    // Android's native picker dialogs self-anchor and self-dismiss.
    return <>{children}</>;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable
          style={s.modalScrim}
          onPress={onClose}
          accessibilityLabel={`Dismiss ${label} picker`}
          testID={`${testID}-sheet-scrim`}
        />
        {/* B-26: the card is bottom-anchored, so a focused input inside it
            sits exactly where the keyboard lands. Nothing to avoid when the
            content is a native picker — this is inert for those. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={s.modalAvoider}
        >
          <View
            style={[s.modalCard, { paddingBottom: insets.bottom + theme.space[4] }]}
            accessibilityViewIsModal
            testID={`${testID}-sheet`}
          >
            <View style={s.modalHeader}>
              <AppText role="subheading" accessibilityRole="header">
                {label}
              </AppText>
              <View style={s.modalActions}>
                {onDone !== undefined ? (
                  <Pressable
                    onPress={onDone}
                    accessibilityRole="button"
                    accessibilityLabel={`Done, use displayed ${label}`}
                    hitSlop={theme.hitSlop.sm}
                    style={s.modalDone}
                    testID={`${testID}-sheet-done`}
                  >
                    <AppText role="subheading" style={s.modalDoneText}>
                      Done
                    </AppText>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={theme.hitSlop.sm}
                  style={s.modalClose}
                  testID={`${testID}-sheet-close`}
                >
                  <Icon name="close" size={18} color={theme.color.text.secondary} />
                </Pressable>
              </View>
            </View>
            {children}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
