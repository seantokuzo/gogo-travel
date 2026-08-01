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
  DEEPLINK_RETURN_KEY,
  readDeeplinkOutRecord,
  recordDeeplinkOut,
  RETURN_PROMPT_WINDOW_MS,
  type DeeplinkOutRecord,
} from "./return-prompt-store";

/**
 * The package's jest mock scopes each `createMMKV()` to its own Map (no
 * shared default instance), so the raw-bytes test below needs a handle on
 * the STORE MODULE's instance: wrap the factory (keeping the real mock
 * adapter) and expose the created instances on the mocked module. The list
 * lives INSIDE the factory — `jest.mock` hoists above this file's consts,
 * so an outer binding would hit its TDZ when the store module imports mmkv.
 */
jest.mock("react-native-mmkv", () => {
  const actual = jest.requireActual<typeof import("react-native-mmkv")>("react-native-mmkv");
  const instances: unknown[] = [];
  return {
    ...actual,
    __instances: instances,
    createMMKV: (...args: Parameters<typeof actual.createMMKV>) => {
      const instance = actual.createMMKV(...args);
      instances.push(instance);
      return instance;
    },
  };
});

function mmkvInstances(): { set(key: string, value: string): void }[] {
  return (jest.requireMock("react-native-mmkv") as { __instances: unknown[] }).__instances as {
    set(key: string, value: string): void;
  }[];
}

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

it("raw non-JSON in the slot folds to no pending return (JSON.parse catch arm, R1)", () => {
  const storeInstance = mmkvInstances()[0];
  expect(storeInstance).toBeDefined();
  // Bypass recordDeeplinkOut (which always stringifies) — this is the
  // torn-write/foreign-writer shape the catch arm exists for.
  storeInstance?.set(DEEPLINK_RETURN_KEY, "{not json");
  expect(readDeeplinkOutRecord()).toBeNull();
  expect(consumePendingReturnPrompt()).toBeNull();
});
