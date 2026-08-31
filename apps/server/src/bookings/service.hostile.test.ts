/**
 * Booking service × hostile fixtures (T-S3.4, testing-overhaul spec §3.4) —
 * the minimal PURE server consumer: import-only use of `bookings/service.ts`
 * with a stub `DbClient` whose `transaction` is a sentinel. A payload that
 * REACHES the sentinel passed `derivedInstantsOf`'s validation mirror; one
 * that rejects with `VALIDATION_FAILED` (sentinel untouched) did not. No
 * container, no fixtures seeded — this file needs no Docker.
 *
 * NOT a duplicate of `routes.db.test.ts`'s B-8 pins: those pin the 12h
 * boundary BOTH SIDES against the REAL `bookings_time_order_ck` constraint
 * (11h59m insert / 12h01m 400, grace-set membership). This file pins what
 * only the hostile PACK expresses — the correct-composition shape (which no
 * existing test sends, because no existing client can produce it) and the
 * pack's z-stamped shapes on either side of the grace.
 *
 * GRACE-SENSITIVE PINS (spec §3.4 "grace-window-sensitive pins marked"):
 * tagged [GRACE] below. The 12h transport grace (`TZ_INVERSION_GRACE_MS` +
 * migration 0001) reverts together with B-9 (the QUEUE B-8 row's DoD);
 * each [GRACE] pin carries its flip instruction for that PR. The
 * correct-composition pin is the one that does NOT flip — it is the B-9
 * acceptance harness's server half and must stay green before, during and
 * after the revert.
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

  it("[GRACE] the Z-stamped eastbound flight (7h apparent inversion) is admitted TODAY by the 12h transport grace — flips with B-9", async () => {
    // Flip instruction (B-9 / grace-revert PR): when `TZ_INVERSION_GRACE_MS`
    // + migration 0001 revert (B-8 DoD), this exact payload must become
    // VALIDATION_FAILED with the transaction untouched — swap this pin's
    // assertions for the extreme-fixture pin's shape below. Until then,
    // GREEN here documents that the server knowingly stores wrong instants
    // for current clients. Falsification (today): narrowing the grace below
    // 7h, or dropping `flight` from the grace set, reds this.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "NRT-LAX (current client)",
        details: DATE_LINE_EASTBOUND.zStamped,
      }),
    );
    expect(error).toBe(SENTINEL);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("[GRACE] the Z-stamped extreme hop (AKL→PPT, 16h10m inversion) is REJECTED without touching the db — the grace is bounded, so this real flight is still unenterable", async () => {
    // The pack's proof the grace is a partial unblock: a real ~6h flight
    // whose z-inversion exceeds 12h. Stays a rejection FOREVER for this
    // payload shape (after B-9 the fix is that clients stop producing it);
    // listed [GRACE] because its message/mechanism cites the grace mirror.
    // Falsification: widening the grace beyond 16h10m (or unbounding it)
    // reds this — the drift the boundary pins in routes.db.test.ts guard at
    // 12h exactly, guarded here at the pack's real-flight magnitude.
    const { db, transaction } = stubDb();
    const error = await rejectionOf(
      create(db, {
        category: "flight",
        title: "AKL-PPT (current client)",
        details: DATE_LINE_EASTBOUND_EXTREME.zStamped,
      }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe("VALIDATION_FAILED");
    expect(transaction).not.toHaveBeenCalled();
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
