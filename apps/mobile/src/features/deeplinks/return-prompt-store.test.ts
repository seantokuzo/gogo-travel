/**
 * Return-prompt record lifecycle pins (T-7.8 / IT-8; §2.8, nav §2.3 /
 * R-nav-18): record-before-open persists; consume presents ONCE (slot
 * clears on read, every arm); the 30-minute window expires stale records
 * silently; corrupt persisted values fold to "no pending return". MMKV is
 * the package's in-memory jest substitute, so this exercises the real
 * adapter (last-viewed-trip precedent).
 */
import {
  clearDeeplinkOutRecord,
  consumePendingReturnPrompt,
  readDeeplinkOutRecord,
  recordDeeplinkOut,
  RETURN_PROMPT_WINDOW_MS,
  type DeeplinkOutRecord,
} from "./return-prompt-store";

const TRIP_ID = "33333333-cccc-4ccc-8ccc-333333333333";

function makeRecord(timestamp: number): DeeplinkOutRecord {
  return { partner: "airbnb", category: "lodging", tripId: TRIP_ID, timestamp };
}

afterEach(() => {
  clearDeeplinkOutRecord();
});

it("records and reads the outbound tap; a second tap overwrites (one slot)", () => {
  expect(readDeeplinkOutRecord()).toBeNull();
  recordDeeplinkOut(makeRecord(1_000));
  expect(readDeeplinkOutRecord()).toEqual(makeRecord(1_000));
  recordDeeplinkOut({ ...makeRecord(2_000), partner: "booking" });
  expect(readDeeplinkOutRecord()).toEqual({ ...makeRecord(2_000), partner: "booking" });
});

it("consume returns an in-window record exactly once (present once, then clear)", () => {
  const now = 10_000_000;
  recordDeeplinkOut(makeRecord(now - 5 * 60 * 1000));
  expect(consumePendingReturnPrompt(now)).toEqual(makeRecord(now - 5 * 60 * 1000));
  // The slot cleared with the read — no re-prompt on the next foreground.
  expect(consumePendingReturnPrompt(now)).toBeNull();
  expect(readDeeplinkOutRecord()).toBeNull();
});

it("a return outside the 30-minute window expires silently (record cleared, no prompt)", () => {
  const now = 10_000_000_000;
  recordDeeplinkOut(makeRecord(now - RETURN_PROMPT_WINDOW_MS - 1));
  expect(consumePendingReturnPrompt(now)).toBeNull();
  expect(readDeeplinkOutRecord()).toBeNull();
});

it("the window boundary itself still prompts; a future-stamped record does not", () => {
  const now = 10_000_000_000;
  recordDeeplinkOut(makeRecord(now - RETURN_PROMPT_WINDOW_MS));
  expect(consumePendingReturnPrompt(now)).toEqual(makeRecord(now - RETURN_PROMPT_WINDOW_MS));
  // Clock skew / corrupt future stamp — treat as expired, never trust it.
  recordDeeplinkOut(makeRecord(now + 60_000));
  expect(consumePendingReturnPrompt(now)).toBeNull();
});

it("corrupt or wrong-shape persisted values fold to no pending return", () => {
  recordDeeplinkOut({ category: "not-a-category" } as unknown as DeeplinkOutRecord);
  expect(readDeeplinkOutRecord()).toBeNull();
  expect(consumePendingReturnPrompt()).toBeNull();
});
