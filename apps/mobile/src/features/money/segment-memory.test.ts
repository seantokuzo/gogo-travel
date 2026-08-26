/**
 * In-session money-segment memory (T-9.5 / R-cmoney-1) — per-trip isolation,
 * session recall, and the cold-launch re-default (reset = the relaunch
 * stand-in, mirroring tab-memory.test.ts).
 */
import {
  isMoneySegment,
  MONEY_SEGMENTS,
  recallMoneySegment,
  rememberMoneySegment,
  resetMoneySegmentMemory,
} from "./segment-memory";

const TRIP_A = "11111111-1111-4111-8111-111111111111";
const TRIP_B = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  resetMoneySegmentMemory();
});

it("no stored choice → undefined (the screen falls back to the budget default)", () => {
  expect(recallMoneySegment(TRIP_A)).toBeUndefined();
});

it("remembers a manual choice per trip; other trips unaffected", () => {
  rememberMoneySegment(TRIP_A, "balances");
  expect(recallMoneySegment(TRIP_A)).toBe("balances");
  // Control arm: the sibling trip still has no session choice.
  expect(recallMoneySegment(TRIP_B)).toBeUndefined();

  rememberMoneySegment(TRIP_A, "expenses");
  expect(recallMoneySegment(TRIP_A)).toBe("expenses");
});

it("isMoneySegment narrows every tuple member and rejects strangers (R1 no-cast guard)", () => {
  for (const segment of MONEY_SEGMENTS) {
    expect(isMoneySegment(segment)).toBe(true);
  }
  expect(isMoneySegment("settle")).toBe(false);
  expect(isMoneySegment("")).toBe(false);
});

it("reset (cold-launch stand-in) clears every trip's choice — re-defaults follow", () => {
  rememberMoneySegment(TRIP_A, "balances");
  rememberMoneySegment(TRIP_B, "expenses");
  resetMoneySegmentMemory();
  expect(recallMoneySegment(TRIP_A)).toBeUndefined();
  expect(recallMoneySegment(TRIP_B)).toBeUndefined();
});
