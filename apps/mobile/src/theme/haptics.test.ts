/**
 * DS-6 — the §2.8 event table must land on the RIGHT expo-haptics calls.
 * Table-driven against hapticEvents (the tokens data is the source of truth).
 */
import * as Haptics from "expo-haptics";

import { triggerHaptic } from "@/theme/haptics";

jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

const selectionAsync = Haptics.selectionAsync as jest.Mock;
const impactAsync = Haptics.impactAsync as jest.Mock;
const notificationAsync = Haptics.notificationAsync as jest.Mock;

describe("triggerHaptic (spec §2.8 convention table)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("selection → selectionAsync", () => {
    triggerHaptic("selection");
    expect(selectionAsync).toHaveBeenCalledTimes(1);
  });

  it("actionLight → impactAsync(Light)", () => {
    triggerHaptic("actionLight");
    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it("dragLift → impactAsync(Medium), dragDrop → impactAsync(Light)", () => {
    triggerHaptic("dragLift");
    expect(impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    triggerHaptic("dragDrop");
    expect(impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it.each([
    ["success", "Success"],
    ["warning", "Warning"],
    ["error", "Error"],
  ] as const)("%s → notificationAsync(%s)", (event, type) => {
    triggerHaptic(event);
    expect(notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType[type]);
  });

  it("swallows native rejection — haptics never fail a user action", async () => {
    selectionAsync.mockRejectedValueOnce(new Error("no haptic hardware"));
    expect(() => triggerHaptic("selection")).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await Promise.resolve();
  });
});
