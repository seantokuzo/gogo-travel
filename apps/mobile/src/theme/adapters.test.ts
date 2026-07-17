/**
 * Adapter seam tests (T-4.2) — verify the thin wiring, not the provider
 * (provider behavior is covered in @gogo/tokens/react's own suite).
 */
import { Appearance } from "react-native";

import { systemAppearance, themeStorage } from "@/theme";

describe("themeStorage (MMKV adapter)", () => {
  it("round-trips strings synchronously", () => {
    themeStorage.set("t-4-2.adapter-test", "value");
    expect(themeStorage.getString("t-4-2.adapter-test")).toBe("value");
  });

  it("returns undefined-ish for a missing key", () => {
    expect(themeStorage.getString("t-4-2.never-set")).toBeFalsy();
  });
});

describe("systemAppearance (RN Appearance adapter)", () => {
  it("forwards the current scheme from Appearance", () => {
    expect(systemAppearance.getColorScheme()).toBe(Appearance.getColorScheme());
  });

  it("forwards change events and unsubscribes via subscription.remove", () => {
    const remove = jest.fn();
    const spy = jest.spyOn(Appearance, "addChangeListener").mockReturnValue({ remove });
    const listener = jest.fn();

    const unsubscribe = systemAppearance.subscribe(listener);
    const forward = spy.mock.calls[0][0];
    forward({ colorScheme: "dark" });
    expect(listener).toHaveBeenCalledWith("dark");

    expect(remove).not.toHaveBeenCalled();
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
