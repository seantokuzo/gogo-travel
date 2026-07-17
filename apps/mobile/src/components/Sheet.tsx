/**
 * Sheet (DS-9, spec §2.9, R-ds-19) — bottom sheet for place details, quick
 * add, settle handoff. Full-screen modals route through expo-router, not
 * this component.
 *
 * R-ds-19: swipe-down dismissal (drag the grab-handle/header region) AND an
 * explicit close button; RN Modal moves screen-reader focus in on present
 * and restores it on dismiss; `accessibilityViewIsModal` fences the sheet.
 *
 * Motion: spring in on `motion.spring.sheet`, timed slide out on
 * `duration.base`; reduce-motion (R-ds-11) swaps the slide for a `fast`
 * cross-fade. Swipe-down keeps working under reduce-motion — it is an
 * essential interaction, not a decorative animation.
 *
 * `snapPoints`: v1 honors the FIRST point only — `'content'` (auto height,
 * capped at 85% of the window) or a fixed pt height. Multi-point dragging is
 * a later, additive upgrade; the prop shape is the spec's (§2.9).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "./Icon";
import { AppText } from "./Text";
import { useReduceMotion } from "./useReduceMotion";

export interface SheetProps {
  visible: boolean;
  onDismiss(): void;
  title?: string;
  /** v1: first point wins — `'content'` (default) or fixed pt height. */
  snapPoints?: ("content" | number)[];
  children?: ReactNode;
  /** Required (R-ds-20). */
  testID: string;
}

export const DISMISS_DRAG_PT = 80;
export const DISMISS_VELOCITY = 0.5;

/**
 * The swipe-down release decision (R-ds-19), extracted pure so the 80pt/0.5vy
 * math is unit-testable — the PanResponder gesture pipeline itself is not
 * simulatable in jest. Exported for tests; not part of the component API.
 */
export function shouldDismissSheet(gesture: { dy: number; vy: number }): boolean {
  return gesture.dy > DISMISS_DRAG_PT || gesture.vy > DISMISS_VELOCITY;
}

/**
 * Module-scope factory (render-scope-free — react-hooks/refs + Compiler
 * clean). Swipe-down keeps working under reduce-motion: it is an essential
 * interaction, not a decorative animation.
 */
function createSheetPanResponder(opts: {
  dragY: Animated.Value;
  onDismiss: () => void;
  spring: { damping: number; stiffness: number };
}) {
  const { dragY, onDismiss, spring } = opts;
  const springBack = () => {
    Animated.spring(dragY, {
      toValue: 0,
      damping: spring.damping,
      stiffness: spring.stiffness,
      useNativeDriver: true,
    }).start();
  };
  return PanResponder.create({
    onMoveShouldSetPanResponder: (_evt, gesture) =>
      gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderMove: (_evt, gesture) => {
      dragY.setValue(Math.max(0, gesture.dy));
    },
    onPanResponderRelease: (_evt, gesture) => {
      if (shouldDismissSheet(gesture)) {
        onDismiss();
      } else {
        springBack();
      }
    },
    onPanResponderTerminate: springBack,
  });
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: t.color.bg.scrim, justifyContent: "flex-end" },
    sheet: {
      backgroundColor: t.color.bg.surfaceRaised,
      borderTopLeftRadius: t.radius.xl,
      borderTopRightRadius: t.radius.xl,
      ...t.elevation[3],
    },
    grabRegion: { alignItems: "center", paddingTop: t.space[2] },
    handle: {
      width: 36,
      height: 4,
      borderRadius: t.radius.full,
      backgroundColor: t.color.border.strong,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: t.space[4],
      paddingTop: t.space[2],
      paddingBottom: t.space[2],
      gap: t.space[3],
    },
    headerTitle: { flex: 1 },
    closeButton: {
      minWidth: 32,
      minHeight: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radius.full,
      backgroundColor: t.color.bg.inset,
    },
    body: { paddingHorizontal: t.space[4] },
  }),
);

export function Sheet({ visible, onDismiss, title, snapPoints, children, testID }: SheetProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const s = useStyles();

  // Animated values via useState initializers — created once, no render-time
  // ref reads (react-hooks/refs + React Compiler safe).
  const [translate] = useState(() => new Animated.Value(windowHeight));
  const [dragY] = useState(() => new Animated.Value(0));
  const [scrimOpacity] = useState(() => new Animated.Value(0));

  // The modal stays mounted through the exit animation: mounted while
  // `visible` OR while `exiting`. `exiting` flips on the visible→hidden edge
  // via the React-docs "adjust state during render" pattern.
  const [exiting, setExiting] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (!visible) setExiting(true);
  }
  const mounted = visible || exiting;

  // Measured sheet height — written in onLayout, read in effects/gestures.
  const sheetHeightRef = useRef(0);

  useEffect(() => {
    const { duration, spring } = theme.motion;
    if (visible) {
      dragY.setValue(0);
      if (reduceMotion) {
        // R-ds-11: entrance slide → cross-fade at `fast`.
        translate.setValue(0);
        Animated.timing(scrimOpacity, {
          toValue: 1,
          duration: duration.fast,
          useNativeDriver: true,
        }).start();
      } else {
        Animated.parallel([
          Animated.spring(translate, {
            toValue: 0,
            damping: spring.sheet.damping,
            stiffness: spring.sheet.stiffness,
            useNativeDriver: true,
          }),
          Animated.timing(scrimOpacity, {
            toValue: 1,
            duration: duration.base,
            useNativeDriver: true,
          }),
        ]).start();
      }
      return;
    }
    if (!exiting) return;
    const offscreen = sheetHeightRef.current || windowHeight;
    const exit = reduceMotion
      ? [
          Animated.timing(scrimOpacity, {
            toValue: 0,
            duration: duration.fast,
            useNativeDriver: true,
          }),
        ]
      : [
          Animated.timing(translate, {
            toValue: offscreen,
            duration: duration.base,
            useNativeDriver: true,
          }),
          Animated.timing(scrimOpacity, {
            toValue: 0,
            duration: duration.base,
            useNativeDriver: true,
          }),
        ];
    Animated.parallel(exit).start(({ finished }) => {
      if (finished) {
        // Park values for the next entrance, then unmount (async callback —
        // not a sync-in-effect set).
        translate.setValue(offscreen);
        scrimOpacity.setValue(0);
        setExiting(false);
      }
    });
  }, [visible, exiting, reduceMotion, windowHeight, translate, dragY, scrimOpacity, theme.motion]);

  // Swipe-down on the grab-handle/header region (R-ds-19). Memoized without
  // any mutable "latest callback" cell (react-hooks/refs + immutability rules
  // reject those under the Compiler): it re-creates only when `onDismiss`
  // identity or the (static) spring tokens change. A mid-gesture handler-
  // identity change would reset gesture state — vanishingly rare, since sheet
  // content doesn't re-render its parent mid-drag.
  const panResponder = useMemo(
    () => createSheetPanResponder({ dragY, onDismiss, spring: theme.motion.spring.sheet }),
    [dragY, onDismiss, theme.motion.spring.sheet],
  );

  const firstSnap = snapPoints?.[0] ?? "content";
  const heightStyle =
    typeof firstSnap === "number"
      ? { height: firstSnap }
      : { maxHeight: Math.round(windowHeight * 0.85) };

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onDismiss}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: scrimOpacity }]}>
          <Pressable
            style={s.scrim}
            onPress={onDismiss}
            testID={`${testID}-scrim`}
            accessibilityLabel="Dismiss sheet"
          />
        </Animated.View>
        <Animated.View
          style={[
            s.sheet,
            heightStyle,
            {
              // Anchor + inset-dependent padding — runtime values, not tokens.
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              paddingBottom: insets.bottom + theme.space[4],
              transform: [{ translateY: Animated.add(translate, dragY) }],
            },
          ]}
          testID={testID}
          accessibilityViewIsModal
          onLayout={(event) => {
            sheetHeightRef.current = event.nativeEvent.layout.height;
          }}
        >
          <View {...panResponder.panHandlers}>
            <View style={s.grabRegion} accessible={false}>
              <View style={s.handle} />
            </View>
            <View style={s.headerRow}>
              {title !== undefined ? (
                <AppText role="heading" accessibilityRole="header" style={s.headerTitle}>
                  {title}
                </AppText>
              ) : (
                <View style={s.headerTitle} />
              )}
              <Pressable
                onPress={onDismiss}
                testID={`${testID}-close`}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={theme.hitSlop.sm}
                style={s.closeButton}
              >
                <Icon name="close" size={18} color={theme.color.text.secondary} />
              </Pressable>
            </View>
          </View>
          <View style={s.body}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}
