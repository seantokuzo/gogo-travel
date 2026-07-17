/**
 * Skeleton (DS-7, spec §2.9, R-ds-15) — loading placeholders composed into
 * per-screen skeleton layouts. Bare spinners are reserved for in-button and
 * full-screen boot states.
 *
 * Shimmer: opacity pulse on `motion.duration.shimmer` (RN core Animated —
 * opacity loops need no worklet driver; the animation-library pin stays a
 * scaffold decision). R-ds-11: OS reduce-motion renders a STATIC placeholder
 * — observable in tests as the absence of the `{testID}-shimmer` node.
 *
 * Hidden from screen readers: a skeleton is a visual affordance, not content.
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useEffect, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import type { DimensionValue } from "react-native";

import { useReduceMotion } from "./useReduceMotion";

export type SkeletonVariant = "text" | "circle" | "rect";

export interface SkeletonProps {
  variant: SkeletonVariant;
  /** Bone width — number (pt) or percentage string. Defaults per variant. */
  width?: DimensionValue;
  /** Bone height (pt). Defaults per variant. */
  height?: number;
  /** `text` only: stacked line count (last line 70% width). Default 1. */
  lines?: number;
  testID?: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    stack: { gap: t.space[2] },
    bone: { backgroundColor: t.color.bg.inset },
    text: { borderRadius: t.radius.sm },
    circle: { borderRadius: t.radius.full },
    rect: { borderRadius: t.radius.md },
  }),
);

function Bones({
  variant,
  width,
  height,
  lines,
  testID,
}: Required<Pick<SkeletonProps, "variant">> &
  Pick<SkeletonProps, "width" | "height" | "lines" | "testID">) {
  const s = useStyles();
  if (variant === "text") {
    const count = Math.max(1, lines ?? 1);
    return (
      <View style={s.stack}>
        {Array.from({ length: count }, (_, i) => (
          <View
            key={i}
            testID={testID !== undefined ? `${testID}-line-${i}` : undefined}
            style={[
              s.bone,
              s.text,
              {
                height: height ?? 14,
                width: i === count - 1 && count > 1 ? "70%" : (width ?? "100%"),
              },
            ]}
          />
        ))}
      </View>
    );
  }
  if (variant === "circle") {
    const size = height ?? 40;
    return <View style={[s.bone, s.circle, { width: width ?? size, height: size }]} />;
  }
  return <View style={[s.bone, s.rect, { width: width ?? "100%", height: height ?? 80 }]} />;
}

export function Skeleton({ variant, width, height, lines, testID }: SkeletonProps) {
  const { theme } = useTheme();
  const reduceMotion = useReduceMotion();
  // useState initializer: created once, no render-time ref read
  // (react-hooks/refs + React Compiler safe).
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return undefined;
    }
    const half = theme.motion.duration.shimmer / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.5, duration: half, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: half, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, opacity, theme.motion.duration.shimmer]);

  const bones = (
    <Bones variant={variant} width={width} height={height} lines={lines} testID={testID} />
  );

  return (
    <View
      testID={testID}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {reduceMotion ? (
        bones
      ) : (
        <Animated.View
          style={{ opacity }}
          testID={testID !== undefined ? `${testID}-shimmer` : undefined}
        >
          {bones}
        </Animated.View>
      )}
    </View>
  );
}
