/**
 * Settle return-prompt record lifecycle pins (T-9.7 — R-cmoney-21;
 * return-prompt-store precedent): record-before-open persists; consume
 * presents ONCE (slot clears on read, EVERY arm — fresh, stale, corrupt);
 * the 30-minute window expires stale records silently; corrupt persisted
 * values fold to "no pending return". MMKV is the package's in-memory jest
 * substitute, so this exercises the real adapter.
 */
import {
  clearSettleReturnRecord,
  consumePendingSettleReturn,
  recordSettleDeeplinkOut,
  SETTLE_RETURN_KEY,
  SETTLE_RETURN_WINDOW_MS,
  type SettleReturnRecord,
} from "./settle-return-store";

/** Same factory-wrap as return-prompt-store.test (module-doc rationale there). */
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

const T0 = 1_756_000_000_000;

function makeRecord(overrides?: Partial<SettleReturnRecord>): SettleReturnRecord {
  return {
    tripId: "11111111-1111-4111-8111-111111111111",
    counterpartyId: "44444444-4444-4444-8444-444444444444",
    method: "venmo",
    amountCents: 2550,
    timestamp: T0,
    ...overrides,
  };
}

afterEach(() => {
  clearSettleReturnRecord();
});

describe("settle-return-store (R-cmoney-21)", () => {
  it("stashes at tap and consumes once within the window — the slot clears on read", () => {
    recordSettleDeeplinkOut(makeRecord());
    expect(consumePendingSettleReturn(T0 + 60_000)).toEqual(makeRecord());
    // Present-once: the same return can never prompt twice.
    expect(consumePendingSettleReturn(T0 + 61_000)).toBeNull();
  });

  it("keeps the optional requestId (the R-money-18 linkage) through the round-trip", () => {
    const record = makeRecord({ requestId: "99999999-9999-4999-8999-999999999999" });
    recordSettleDeeplinkOut(record);
    expect(consumePendingSettleReturn(T0 + 1)).toEqual(record);
  });

  it("expires records older than 30 minutes silently — and still clears the slot", () => {
    recordSettleDeeplinkOut(makeRecord());
    expect(consumePendingSettleReturn(T0 + SETTLE_RETURN_WINDOW_MS + 1)).toBeNull();
    // The stale record was consumed, not left to resurface.
    expect(consumePendingSettleReturn(T0 + SETTLE_RETURN_WINDOW_MS + 2)).toBeNull();
  });

  it("accepts a return exactly at the window edge and rejects clock-skew (negative age)", () => {
    recordSettleDeeplinkOut(makeRecord());
    expect(consumePendingSettleReturn(T0 + SETTLE_RETURN_WINDOW_MS)).not.toBeNull();
    recordSettleDeeplinkOut(makeRecord());
    expect(consumePendingSettleReturn(T0 - 1)).toBeNull();
  });

  it("a second rail tap overwrites the slot — the freshest tap wins (ONE slot by design)", () => {
    recordSettleDeeplinkOut(makeRecord());
    const second = makeRecord({ method: "paypal", amountCents: 1000, timestamp: T0 + 5_000 });
    recordSettleDeeplinkOut(second);
    expect(consumePendingSettleReturn(T0 + 6_000)).toEqual(second);
  });

  it("folds corrupt and shape-invalid persisted values to null (validate-on-read)", () => {
    const store = mmkvInstances()[0];
    if (store === undefined) throw new Error("store instance not captured");
    store.set(SETTLE_RETURN_KEY, "{not json");
    expect(consumePendingSettleReturn(T0)).toBeNull();
    // Unknown method — a record no confirm could post (SettlementCreate
    // would reject it) never presents.
    store.set(SETTLE_RETURN_KEY, JSON.stringify(makeRecord({ method: "iou" as never })));
    expect(consumePendingSettleReturn(T0 + 1)).toBeNull();
    // Non-positive amount can't be a legal settlement (PositiveCents).
    store.set(SETTLE_RETURN_KEY, JSON.stringify(makeRecord({ amountCents: 0 })));
    expect(consumePendingSettleReturn(T0 + 1)).toBeNull();
  });

  it("clearSettleReturnRecord is the open-failure rollback — nothing prompts after it", () => {
    recordSettleDeeplinkOut(makeRecord());
    clearSettleReturnRecord();
    expect(consumePendingSettleReturn(T0 + 1)).toBeNull();
  });
});
