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
 * B-26 R1 (round-1 review B2 — device QA found the zone search input pushed
 * entirely off screen with the keyboard up). Root cause: `modalAvoider` had
 * no `flex`, so it was CONTENT-sized; `behavior="padding"` (read at the
 * pinned RN 0.86.2 `KeyboardAvoidingView.js`) adds the keyboard's full
 * height as its OWN `paddingBottom`, which grew the content-sized avoider
 * past the screen and pushed it up off the top — `modalRoot`'s
 * `justifyContent: "flex-end"` bottom-anchors an over-tall child without
 * clamping it. Fix: `modalAvoider` gets `flex: 1` so its box is FIXED to the
 * modal's full height (the padding then only eats into its CONTENT room,
 * never grows the box itself), and `modalCard` gets a `maxHeight` ceiling
 * (`pickerCardMaxHeight`) that accounts for the keyboard — Yoga clamps a
 * node's own box at `maxHeight` regardless of its children's content, so the
 * header and (for a search picker) the input — the first children in the
 * column — always land inside the visible card, whatever the last child
 * (a long list) does. Keyboard height comes from `useKeyboardHeight`, not a
 * static fraction — a static 85%/0.7 cap doesn't shrink when the keyboard
 * eats real room (the exact B2 scenario).
 *
 * B-26 R2 (round-2 review — regression introduced by the R1 `flex: 1` fix
 * above): giving `modalAvoider` `flex: 1` makes the `KeyboardAvoidingView`
 * cover the ENTIRE modal, not just the card. RN's `KeyboardAvoidingView`
 * (confirmed at the pinned 0.86.2 source: it destructures only `behavior`,
 * `children`, `contentContainerStyle`, `enabled`, `keyboardVerticalOffset`,
 * `style`, `onLayout` and spreads the rest — `...props` — onto its host
 * `View` in every `behavior` branch, including `"padding"`) renders a plain
 * `View` with the platform default `pointerEvents` ("auto") over that whole
 * box. Declared AFTER `modalScrim` in the tree, it paints (and hit-tests)
 * above the scrim — so a tap on the dimmed area above the card landed on
 * this invisible full-screen `View` instead of falling through to the
 * scrim's `onPress`, and only the close X could dismiss. Fix:
 * `pointerEvents="box-none"` on the `KeyboardAvoidingView` — the avoider
 * itself is never the touch target, but `modalCard` (its child) still is,
 * so a tap anywhere outside the card now falls through to `modalScrim`
 * beneath while the card's own Pressables (Done/close) keep working.
 *
 * testIDs derive from the owning FIELD's base id (nav §2.7 rule-4):
 * card `{testID}-sheet`, commit `{testID}-sheet-done`, cancel
 * `{testID}-sheet-close` / `{testID}-sheet-scrim`.
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "./Icon";
import { AppText } from "./Text";
import { useKeyboardHeight } from "./useKeyboardHeight";

/** Card height ceiling with no keyboard — the DS Sheet's own 85% posture (`Sheet.tsx`). */
const CARD_HEIGHT_FRACTION = 0.85;

/** Breathing room kept above the keyboard's top edge when one is up. */
const KEYBOARD_GAP = 16;

/**
 * The card's `maxHeight` ceiling — whichever is SMALLER of the static 85%
 * cap and the room actually left once the keyboard (if any) is accounted
 * for. Pure and exported so the layout math is pinnable without a real
 * layout engine (jest has none) or a real keyboard: `.claude/rules/testing.md`
 * §2's boundary case is a window height with a simulated keyboard height.
 */
export function pickerCardMaxHeight(windowHeight: number, keyboardHeight: number): number {
  const capped = Math.round(windowHeight * CARD_HEIGHT_FRACTION);
  if (keyboardHeight <= 0) return capped;
  const available = Math.round(windowHeight - keyboardHeight - KEYBOARD_GAP);
  return Math.max(0, Math.min(capped, available));
}

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
    // pushes the card up rather than stretching it. B-26 R1: `flex: 1` fixes
    // this box to the modal's full height — without it the box is
    // content-sized, and `behavior="padding"`'s keyboard paddingBottom grows
    // that box past the screen instead of just eating into its content room.
    modalAvoider: { flex: 1, justifyContent: "flex-end" },
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
      // NOT `overflow: "hidden"` — `t.elevation[3]`'s iOS drop shadow renders
      // OUTSIDE this box and clipping would erase it card-wide. `maxHeight`
      // (below, inline) is Yoga's own hard ceiling on this box regardless of
      // children, and the list's own height budget (TimeZoneField) keeps its
      // content within that ceiling — the caller-side `results` wrapper
      // already clips the list rows specifically.
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
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();

  if (Platform.OS !== "ios" && !alwaysModal) {
    // Android's native picker dialogs self-anchor and self-dismiss.
    return <>{children}</>;
  }

  const cardMaxHeight = pickerCardMaxHeight(windowHeight, keyboardHeight);

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
          pointerEvents="box-none"
        >
          <View
            style={[
              s.modalCard,
              { paddingBottom: insets.bottom + theme.space[4], maxHeight: cardMaxHeight },
            ]}
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
