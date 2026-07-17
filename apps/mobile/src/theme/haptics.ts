/**
 * DS-6 — haptics convention wrapper (spec §2.8, R-ds-13 / R-ds-21).
 *
 * The event → abstract-call table ships as PURE DATA in @gogo/tokens
 * (`hapticEvents`); this is the ONLY place the abstract calls meet
 * expo-haptics. Components reference semantic events (`triggerHaptic("selection")`),
 * never raw expo calls — swapping the haptics engine is a one-file change.
 *
 * Rules (R-ds-21, enforced by convention + review, not runtime): never on
 * scroll, never on push/pop navigation, at most ONE haptic per user action.
 */
import { hapticEvents } from "@gogo/tokens";
import type { HapticCall, HapticEvent } from "@gogo/tokens";
import * as Haptics from "expo-haptics";

/** Abstract call name → concrete expo-haptics invocation (verified v57 API). */
const calls: Record<HapticCall, () => Promise<void>> = {
  selection: () => Haptics.selectionAsync(),
  impactLight: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  impactMedium: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  notificationSuccess: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  notificationWarning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  notificationError: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};

/**
 * Fire the haptic for a semantic event. Fire-and-forget: haptics must never
 * block, delay, or fail a user action (missing hardware / simulator / OS
 * toggle off are all normal conditions, not errors).
 */
export function triggerHaptic(event: HapticEvent): void {
  void calls[hapticEvents[event]]().catch(() => {
    // Intentionally swallowed — see doc comment.
  });
}
