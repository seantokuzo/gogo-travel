/**
 * Pending-focus seam pins (T-8.2 / MAP-1 — frozen seam (c); the R-map-24
 * `focusPlaceId` transport ruling). T-8.4 wires senders against exactly
 * these semantics: last-set-wins, consumed once, TRIP-SCOPED (R1 review:
 * a focus armed for another trip is discarded-and-cleared, never presented).
 */
import {
  consumePendingMapFocus,
  setPendingMapFocus,
  usePendingMapFocusStore,
} from "./pending-focus";

const TRIP_A = "11111111-1111-4111-8111-111111111111";
const TRIP_B = "22222222-2222-4222-8222-222222222222";
const PLACE_A = "44444444-4444-4444-8444-444444444441";
const PLACE_B = "44444444-4444-4444-8444-444444444442";

beforeEach(() => {
  usePendingMapFocusStore.setState({ pending: null });
});

describe("pending map focus (set once, consumed once)", () => {
  it("consume for the ARMED trip returns the pending id AND clears it", () => {
    setPendingMapFocus(TRIP_A, PLACE_A);
    expect(usePendingMapFocusStore.getState().pending).toEqual({
      tripId: TRIP_A,
      placeId: PLACE_A,
    });
    expect(consumePendingMapFocus(TRIP_A)).toBe(PLACE_A);
    // Consumed once — a tab revisit must not re-trigger (§2.7).
    expect(usePendingMapFocusStore.getState().pending).toBeNull();
    expect(consumePendingMapFocus(TRIP_A)).toBeNull();
  });

  it("consume with nothing pending is a null no-op", () => {
    expect(consumePendingMapFocus(TRIP_A)).toBeNull();
  });

  it("last set wins before a consume (rapid double-send)", () => {
    setPendingMapFocus(TRIP_A, PLACE_A);
    setPendingMapFocus(TRIP_A, PLACE_B);
    expect(consumePendingMapFocus(TRIP_A)).toBe(PLACE_B);
    expect(consumePendingMapFocus(TRIP_A)).toBeNull();
  });
});

describe("trip scoping (R1 review — stale cross-trip focus)", () => {
  it("consume for a DIFFERENT trip discards AND clears — never presents", () => {
    // Scenario: trip-A sender arms, the tab jump is interrupted, the user
    // later opens trip B's map — the stale id must not surface there.
    setPendingMapFocus(TRIP_A, PLACE_A);
    expect(consumePendingMapFocus(TRIP_B)).toBeNull();
    // Discard-and-CLEAR: the stale focus is gone for trip A too.
    expect(usePendingMapFocusStore.getState().pending).toBeNull();
    expect(consumePendingMapFocus(TRIP_A)).toBeNull();
  });
});
