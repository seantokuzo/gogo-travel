/**
 * Booking service × hostile fixtures (T-S3.4, testing-overhaul spec §3.4) —
 * the minimal PURE server consumer: import-only use of `bookings/service.ts`
 * with a stub `DbClient` whose `transaction` is a sentinel. A payload that
 * REACHES the sentinel passed `derivedInstantsOf`'s validation mirror; one
 * that rejects with `VALIDATION_FAILED` (sentinel untouched) did not. No
 * container, no fixtures seeded — this file needs no Docker.
 *
 * NOT a duplicate of `routes.db.test.ts`'s B-8 pins: those run the whole
 * route against the REAL `bookings_time_order_ck` (correct composition
 * inserts with ordered instants, z-stamped 400, no residual window, no
 * graced category), and `db/constraints.test.ts` pins the constraint itself.
 * This file pins what only the hostile PACK expresses — the
 * correct-composition shapes and the pack's z-stamped shapes — with no
 * container in the loop.
 *
 * GRACE REVERTED 2026-09-06 (B-8 DoD): the 12h transport grace
 * (`TZ_INVERSION_GRACE_MS` + migration 0001) is gone, reverted together with
 * B-9's client half by migration 0003. [WAS-GRACE] marks the pins the revert
 * rewrote: the two formerly-[GRACE] ones, flipped per the instructions they
 * carried, plus the correct-composition arm added for the extreme hop (the
 * flight the window could never admit). Nothing is window-sensitive now.
 * The correct-composition pin is the one that never flipped: it was the B-9
 * acceptance harness's server half, green before, during and after.
 *
 * Falsification (R-test-7): stated per test.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DATE_LINE_EASTBOUND,
  DATE_LINE_EASTBOUND_EXTREME,
  DATE_LINE_WESTBOUND,
  EMPTY_STATES,
  MULTI_ZONE_TRIP_CREATES,
} from "@gogo/shared/testing";
import type { DbClient } from "../db/create-user.js";
import { HttpError } from "../http/errors.js";
import { createBooking, type ServiceBookingCreate } from "./service.js";

const TRIP_ID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";
const USER_ID = "0b0a3c6e-2f1d-4f7e-8a2b-1c9d8e7f6a5b";

/** Thrown by the stub the moment validation lets a payload through. */
const SENTINEL = new Error("hostile: payload passed validation and reached db.transaction");

function stubDb(): { db: DbClient; transaction: ReturnType<typeof vi.fn> } {
  const transaction = vi.fn(() => Promise.reject(SENTINEL));
  return { db: { transaction } as unknown as DbClient, transaction };
}

function create(db: DbClient, input: ServiceBookingCreate): Promise<unknown> {
  return createBooking(db, { tripId: TRIP_ID, userId: USER_ID, input });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => error,
  );
}

describe("createBooking validation mirror × hostile pack (pure, stub db)", () => {
  it("the CORRECT composition of the eastbound date-line flight is admitted — grace-INDEPENDENT (the B-9 acceptance harness's server half; never flips)", async () => {
    // Real offsets ⇒ derived instants ordered (+9h) ⇒ no inversion for the
    // grace to excuse: the server needs NO change for post-B-9 clients.
    // Falsification: any validation added that rejects offset-carrying or
    // tz-carrying details (e.g. an over-eager schema "cleanup") reds this —
    // and would block the B-8 fix from shipping.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "NRT-LAX (correct composition)",
        details: DATE_LINE_EASTBOUND.details,
      }),
    );
    expect(error).toBe(SENTINEL);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("[WAS-GRACE] the Z-stamped eastbound flight (7h apparent inversion) is REJECTED without touching the db — the 12h grace is gone (B-8 DoD)", async () => {
    // FLIPPED 2026-09-06 exactly as the pin's own instruction directed: this
    // payload used to be admitted by `TZ_INVERSION_GRACE_MS`, documenting
    // that the server knowingly stored wrong instants for pre-B-9 clients.
    // With the grace and migration 0001 reverted it must be
    // VALIDATION_FAILED with the transaction untouched — the same shape as
    // the extreme-fixture pin below. Nothing legitimate is lost: the
    // CORRECT composition of this same flight is the first pin in this file
    // and stayed green throughout. Falsification: reintroducing any window
    // ≥7h for `flight` in `derivedInstantsOf` reds this.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "NRT-LAX (pre-B-9 client)",
        details: DATE_LINE_EASTBOUND.zStamped,
      }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe("VALIDATION_FAILED");
    expect((error as HttpError).message).toBe(
      "the category's primary end time precedes its start time",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("[WAS-GRACE] the Z-stamped extreme hop (AKL→PPT, 16h10m inversion) is REJECTED without touching the db — unchanged by the revert, now for the plain reason", async () => {
    // This pin never needed to flip: 16h10m always exceeded the window. What
    // changed is WHY — it is no longer "outside the grace" but simply
    // inverted, the same verdict the 7h pin above now gets. Keeping both
    // arms is what proves the magnitude no longer matters. Falsification:
    // reintroducing an unbounded (or ≥16h10m) transport window reds this.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "AKL-PPT (pre-B-9 client)",
        details: DATE_LINE_EASTBOUND_EXTREME.zStamped,
      }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe("VALIDATION_FAILED");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("[WAS-GRACE] the CORRECT composition of the extreme hop (AKL→PPT with real offsets) is admitted — the revert costs no legitimate flight", async () => {
    // The discriminator for the two rejections above: the AKL→PPT hop is a
    // REAL Air Tahiti Nui route, and a post-B-9 client sends it with
    // +12:00/-10:00 offsets, deriving an ordered 5h50m interval. Without
    // this arm "reject everything with a big apparent inversion" would look
    // identical to "reject only genuinely inverted instants" — and the
    // extreme hop is precisely the flight the 12h grace could never admit,
    // so the revert makes it enterable for the first time.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "AKL-PPT (real offsets)",
        details: DATE_LINE_EASTBOUND_EXTREME.details,
      }),
    );
    expect(error).toBe(SENTINEL);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("the Z-stamped westbound flight is admitted with NO grace involved — silently corrupt instants are not a validation matter at all", async () => {
    // zStampedInterval is +27h50m (ordered), so this passes even with the
    // grace deleted: the silent-corruption arm never had a server-side
    // tripwire, which is why only instant-level client pins (the mobile
    // hostile suite) can catch it. Falsification: fixture drift (self-test
    // reds first) or a new ordering rule tighter than end>=start.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "LAX-NRT (current client)",
        details: DATE_LINE_WESTBOUND.zStamped,
      }),
    );
    expect(error).toBe(SENTINEL);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("empty state: the minimal {category} details are admitted — the timeless-booking path derives null instants and validates vacuously", async () => {
    // Falsification: any create-path validation that assumes times exist
    // (e.g. dereferencing starts_at) throws/reds here before the sentinel.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "Idea with no details",
        details: EMPTY_STATES.minimalDetails("flight"),
      }),
    );
    expect(error).toBe(SENTINEL);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("the multi-zone trip's zero-decimal-priced stays pass the mirror whole — JPY/KRW price_cents reach the write path unscaled", async () => {
    // The service performs no currency math on create (Law #2: integer
    // minor units end to end); a ×100/÷100 "normalization" sneaking into
    // the write path would not be visible here as a validation error, but
    // ordered lodging times must be admitted as-is. Falsification: a
    // service-side inversion rule leaking to lodging (grace mis-scoped
    // wider) still admits these — this arm guards the ADMIT side; the
    // REJECT side (inverted lodging → 400) is pinned against the real
    // constraint in routes.db.test.ts.
    for (const wireCreate of MULTI_ZONE_TRIP_CREATES) {
      const { db, transaction } = stubDb();
      const error = await rejectionOf(create(db, wireCreate));
      expect(error).toBe(SENTINEL);
      expect(transaction).toHaveBeenCalledTimes(1);
    }
  });
});
