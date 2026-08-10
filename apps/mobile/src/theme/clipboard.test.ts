/**
 * Clipboard seam pins (T-7.9 / IT-9 — R-itin-24 copy affordance).
 *
 * Small module, but the pins matter: the screen suite drives this through a
 * spy, so THIS file is the only place the real engine wiring is checked — the
 * T-5.7 landmine (a screen test that mocks the module can't see the module
 * being broken) in miniature.
 */
import { Clipboard } from "react-native";

import { copyToClipboard } from "./clipboard";

/**
 * `Clipboard` is a lazily-required SINGLETON behind a getter on the
 * react-native barrel, so a spy installed on it survives `restoreAllMocks`
 * across tests in this file (a re-`spyOn` returns the existing mock, calls
 * and all — which silently poisoned the first draft of the negative pin
 * below). One spy, cleared per test, is the honest shape.
 */
let setString: jest.SpyInstance;

beforeEach(() => {
  setString = jest.spyOn(Clipboard, "setString").mockImplementation(() => undefined);
  setString.mockClear();
});

afterAll(() => {
  setString.mockRestore();
});

it("writes the text to the system clipboard", () => {
  copyToClipboard("ABC123");
  expect(setString).toHaveBeenCalledWith("ABC123");
});

it("no-ops on empty text instead of clearing the user's real clipboard", () => {
  copyToClipboard("");
  expect(setString).not.toHaveBeenCalled();
  // CONTROL: the very same spy DOES fire for non-empty input, so the negative
  // above is the guard, not a dead spy.
  copyToClipboard(" ");
  expect(setString).toHaveBeenCalledWith(" ");
});

it("exposes a real `setString` on the backing engine (not an accidental undefined)", () => {
  expect(typeof Clipboard.setString).toBe("function");
});
