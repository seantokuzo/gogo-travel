/**
 * Adapter seam tests (T-4.2) — verify the thin wiring, not the provider
 * (provider behavior is covered in @gogo/tokens/react's own suite).
 */
import { Appearance } from "react-native";
import { NitroModules } from "react-native-nitro-modules";

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

  // toSeamScheme normalization — the only NEW logic in the adapters. The seam
  // speaks "light" | "dark" | null; RN 0.86's ColorSchemeName added
  // "unspecified", which must collapse to null ("no OS preference").
  it('passes "light"/"dark" through and maps "unspecified" to null', () => {
    const spy = jest.spyOn(Appearance, "getColorScheme");

    spy.mockReturnValue("light");
    expect(systemAppearance.getColorScheme()).toBe("light");
    spy.mockReturnValue("dark");
    expect(systemAppearance.getColorScheme()).toBe("dark");
    spy.mockReturnValue("unspecified");
    expect(systemAppearance.getColorScheme()).toBeNull();

    spy.mockRestore();
  });

  it("maps an undefined change-event scheme to null", () => {
    const remove = jest.fn();
    const spy = jest.spyOn(Appearance, "addChangeListener").mockReturnValue({ remove });
    const listener = jest.fn();

    const unsubscribe = systemAppearance.subscribe(listener);
    // The public Appearance.d.ts narrows the payload to ColorSchemeName, but
    // the native spec (types_generated NativeAppearance) declares
    // `colorScheme?: ColorSchemeName | undefined` — widen to what the runtime
    // can actually deliver (the reason the adapter normalizes at all).
    const forward = spy.mock.calls[0][0] as (preferences: {
      colorScheme: "light" | "dark" | "unspecified" | undefined;
    }) => void;
    forward({ colorScheme: undefined });
    expect(listener).toHaveBeenCalledWith(null);

    unsubscribe();
    spy.mockRestore();
  });
});

describe("react-native-nitro-modules manual mock", () => {
  it("fails loudly on ANY property access (canary that mmkv took the in-memory path)", () => {
    // The Proxy throw is load-bearing: it's what makes a green run itself
    // evidence that mmkv used its sanctioned jest mock instead of touching
    // Nitro. If someone swaps the Proxy for an inert stub, this test dies.
    expect(() => (NitroModules as unknown as Record<string, unknown>).anything).toThrow(
      /under jest/,
    );
  });
});
