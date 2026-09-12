/**
 * R-nav-21 modal declarations — config capture ONLY (T-4.4 R1).
 *
 * These tests invoke the modal-declaring layout components directly (their
 * only hook, useStackScreenOptions, is mocked) and introspect the element
 * tree they return: each spec §2.6 modal must be declared in its OWNING
 * stack with `options.presentation === "modal"`, and each declaring stack
 * must pin `initialRouteName="index"` so it never boots on its modal.
 *
 * HONEST SCOPE: this proves the layouts DECLARE the config — RNTL cannot
 * observe native sheet presentation, so the actual modal *behavior* is not
 * machine-verifiable and remains simulator-QA evidence at phase close.
 */
import { Stack } from "expo-router";
import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

import TripsLayout from "@/app/(trips)/_layout";
import ItineraryStackLayout from "@/app/[tripId]/itinerary/_layout";
import MoneyStackLayout from "@/app/[tripId]/money/_layout";

jest.mock("@/navigation/stack-options", () => ({
  useStackScreenOptions: () => ({}),
}));

interface ScreenProps {
  name: string;
  options?: { presentation?: string };
}

type StackElement = ReactElement<{ initialRouteName?: string; children?: ReactNode }>;

function declaredConfig(layout: () => ReactElement) {
  const root = layout() as StackElement;
  // T-7.6: a layout may return a Fragment wrapping its Stack plus non-route
  // chrome (the itinerary stack mounts DeeplinkReturnHost beside its Stack).
  // The audited config is the Stack's — exactly one must exist.
  const candidates =
    root.type === Stack
      ? [root]
      : (Children.toArray((root.props as { children?: ReactNode }).children).filter(
          (child) => isValidElement(child) && child.type === Stack,
        ) as StackElement[]);
  expect(candidates).toHaveLength(1);
  const el = candidates[0] as StackElement;
  const screens = Children.toArray(el.props.children).filter(
    isValidElement,
  ) as ReactElement<ScreenProps>[];
  for (const s of screens) expect(s.type).toBe(Stack.Screen);
  return {
    initialRouteName: el.props.initialRouteName,
    screens: screens.map((s) => ({
      name: s.props.name,
      presentation: s.props.options?.presentation,
    })),
  };
}

describe("R-nav-21 — each modal is declared in its owning stack", () => {
  it("(trips) declares `new` + `capture/onboarding` as modals and pins index", () => {
    const { initialRouteName, screens } = declaredConfig(TripsLayout);
    expect(initialRouteName).toBe("index");
    expect(screens).toEqual(
      expect.arrayContaining([
        { name: "new", presentation: "modal" },
        { name: "capture/onboarding", presentation: "modal" },
      ]),
    );
    expect(screens).toHaveLength(2);
  });

  /**
   * B-25 rider: `TripSwitcher`'s "All trips" row navigates to `(trips)/index`
   * straight from the press handler that closes the DS Sheet, with no
   * `onExited` deferral. That is only safe while the destination is NOT a
   * `presentation: "modal"` route (mobile.md 🔴 B-19 — the RNScreens
   * `_updatingModals` wedge). Make the dependency explicit and falsifiable
   * here rather than leaving it implied by the arity check above.
   */
  it("B-25: the trip list itself is NOT a modal — the switcher's undeferred exit depends on it", () => {
    const { screens } = declaredConfig(TripsLayout);
    expect(screens.find((s) => s.name === "index")?.presentation).toBeUndefined();
  });

  it("itinerary tab stack declares `item/new` as a modal and pins index", () => {
    const { initialRouteName, screens } = declaredConfig(ItineraryStackLayout);
    expect(initialRouteName).toBe("index");
    expect(screens).toEqual([{ name: "item/new", presentation: "modal" }]);
  });

  it("money tab stack declares `expense/new` as a modal and pins index", () => {
    const { initialRouteName, screens } = declaredConfig(MoneyStackLayout);
    expect(initialRouteName).toBe("index");
    expect(screens).toEqual([{ name: "expense/new", presentation: "modal" }]);
  });
});
