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

function declaredConfig(layout: () => ReactElement) {
  const el = layout() as ReactElement<{ initialRouteName?: string; children?: ReactNode }>;
  expect(el.type).toBe(Stack);
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
