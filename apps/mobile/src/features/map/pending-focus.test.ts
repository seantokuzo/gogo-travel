/**
 * Pending-focus seam pins (T-8.2 / MAP-1 — frozen seam (c); the R-map-24
 * `focusPlaceId` transport ruling). T-8.4 wires senders against exactly
 * these semantics: last-set-wins, consumed once.
 */
import {
  consumePendingMapFocus,
  setPendingMapFocus,
  usePendingMapFocusStore,
} from "./pending-focus";

const PLACE_A = "44444444-4444-4444-8444-444444444441";
const PLACE_B = "44444444-4444-4444-8444-444444444442";

beforeEach(() => {
  usePendingMapFocusStore.setState({ pendingPlaceId: null });
});

describe("pending map focus (set once, consumed once)", () => {
  it("consume returns the pending id AND clears it", () => {
    setPendingMapFocus(PLACE_A);
    expect(usePendingMapFocusStore.getState().pendingPlaceId).toBe(PLACE_A);
    expect(consumePendingMapFocus()).toBe(PLACE_A);
    // Consumed once — a tab revisit must not re-trigger (§2.7).
    expect(usePendingMapFocusStore.getState().pendingPlaceId).toBeNull();
    expect(consumePendingMapFocus()).toBeNull();
  });

  it("consume with nothing pending is a null no-op", () => {
    expect(consumePendingMapFocus()).toBeNull();
  });

  it("last set wins before a consume (rapid double-send)", () => {
    setPendingMapFocus(PLACE_A);
    setPendingMapFocus(PLACE_B);
    expect(consumePendingMapFocus()).toBe(PLACE_B);
    expect(consumePendingMapFocus()).toBeNull();
  });
});
