/**
 * Top-safe-area OWNERSHIP (B-27).
 *
 * THE DEFECT THIS EXISTS FOR: exactly one element on a screen may pad for
 * `insets.top` — whichever one is actually flush with the top of the window.
 * `PageHeader` (spec §2.9) claims it because on most screens it IS that
 * element. Inside the trip shell it is NOT: `[tripId]/_layout` renders
 * `TripSwitcherBar` above the tab navigator, so the bar is flush with the
 * window and the header sits below it. Both padded, so a 59 pt device inset
 * bought ~59 pt of dead space on every trip screen. (Pre-existing; PR #66
 * made it universal by dropping the switcher's 2-active-trips gate, so the
 * bar now renders on every trip screen instead of a rare few.)
 *
 * THE MECHANISM: an explicit boolean context — "an ancestor has already
 * claimed the top safe area". `useTopInset()` returns `0` under a claiming
 * ancestor and `insets.top` otherwise; callers keep their own token spacing
 * either way, so the gap under the bar stays a deliberate `space[2]` rather
 * than collapsing to zero. Chosen over zeroing `SafeAreaInsetsContext.top`
 * for the subtree because that would silently retune EVERY inset consumer
 * below it (`KeyboardAvoidingView`, sheets, future code) — this flag reaches
 * only the components that opt in by calling `useTopInset()`, which is a
 * greppable, finite set.
 *
 * 🔴 NATIVE MODALS ARE NOT DESCENDANTS ON SCREEN, ONLY IN THE REACT TREE.
 * A `presentation: "modal"` route declared inside a tab stack is presented by
 * `RNSScreenStackView` in its own view controller, over the whole shell — the
 * switcher bar is not above it, and a pageSheet's top edge is not the
 * window's. React context can't see that distinction, so every trip-shell
 * modal must RE-OPEN the boundary with `claimed={false}` (they do:
 * `itinerary/item/new`, `money/expense/new`). `__tests__/modal-presentation.test.ts`
 * asserts the declared screen config of ALL FIVE trip-shell tab stacks
 * (today, map, itinerary, money, more) — the three with no modal today
 * (today, map, more) are pinned to an empty screen set — so a modal added to
 * ANY of them fails that stack's assertion and forces an author back through
 * this note before it can ship un-reopened.
 */
import { createContext, use } from "react";
import type { ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** False at the root: nothing has claimed the top inset until something says so. */
const TopInsetClaimedContext = createContext(false);

export interface TopInsetBoundaryProps {
  /**
   * `true` — an ancestor of these children is flush with the top of the
   * window and already pads for `insets.top`.
   * `false` — these children start a fresh top edge (a natively presented
   * modal), so they claim it themselves again.
   */
  claimed: boolean;
  children: ReactNode;
}

/**
 * Declares who owns the top safe area for a subtree. Renders NO view — it is
 * a context provider only, so dropping it into a layout cannot move a pixel
 * on its own.
 */
export function TopInsetBoundary({ claimed, children }: TopInsetBoundaryProps) {
  return (
    <TopInsetClaimedContext.Provider value={claimed}>{children}</TopInsetClaimedContext.Provider>
  );
}

/**
 * The top padding THIS component should add for the safe area: `insets.top`
 * when it is the topmost chrome, `0` when an ancestor already claimed it.
 * Add your own token spacing on top of the return value.
 */
export function useTopInset(): number {
  const claimed = use(TopInsetClaimedContext);
  // Both hooks run unconditionally — the choice is in the return, not the call.
  const insets = useSafeAreaInsets();
  return claimed ? 0 : insets.top;
}
