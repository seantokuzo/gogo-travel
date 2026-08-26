/**
 * Unit tests for the settle-request pure pieces (T-9.4 / MON-5): the
 * `pairwiseDebt` directed-edge projection (both row orientations, both signs,
 * absent pair) and the wire serializer (link format on the shared
 * `LINK_DOMAIN` placeholder; `created_by` = `to_user_id` [I-3]; derived
 * `resolved` pass-through). DB behavior lives in requests-routes.db.test.ts.
 */
import { describe, expect, it } from "vitest";
import { LINK_DOMAIN } from "@gogo/shared/config/links";
import { SettleRequestSchema, type Balance } from "@gogo/shared/domains/money";
import { pairwiseDebt } from "./requests-service.js";
import { settleRequestUrl, toSettleRequestWire } from "./requests-serialize.js";
import type { SettlementRequestRow } from "./serialize.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const pair = (user: string, counterparty: string, net: number): Balance => ({
  trip_id: TRIP,
  user_id: user,
  counterparty_id: counterparty,
  net_cents: net,
});

describe("pairwiseDebt (directed-edge projection)", () => {
  it("reads debt when the creditor is the row's user_id (positive net = counterparty owes)", () => {
    // Row (ALICE, BOB) net +500: BOB owes ALICE 500.
    const rows = [pair(ALICE, BOB, 500)];
    expect(pairwiseDebt(rows, BOB, ALICE)).toBe(500); // BOB → ALICE
    expect(pairwiseDebt(rows, ALICE, BOB)).toBe(0); // reverse direction owes nothing
  });

  it("reads debt when the debtor is the row's user_id (negative net)", () => {
    // Row (ALICE, BOB) net −700: ALICE owes BOB 700.
    const rows = [pair(ALICE, BOB, -700)];
    expect(pairwiseDebt(rows, ALICE, BOB)).toBe(700); // ALICE → BOB
    expect(pairwiseDebt(rows, BOB, ALICE)).toBe(0);
  });

  it("returns 0 for a pair with no row (zero-net pairs are omitted upstream)", () => {
    expect(pairwiseDebt([pair(ALICE, BOB, 500)], ALICE, CAROL)).toBe(0);
    expect(pairwiseDebt([], ALICE, BOB)).toBe(0);
  });

  it("ignores unrelated pairs while projecting the requested edge", () => {
    const rows = [pair(ALICE, BOB, 500), pair(ALICE, CAROL, -250), pair(BOB, CAROL, 40)];
    expect(pairwiseDebt(rows, ALICE, CAROL)).toBe(250);
    expect(pairwiseDebt(rows, CAROL, BOB)).toBe(40);
  });
});

describe("settle-request wire serialization", () => {
  const REQUEST = "22222222-2222-4222-8222-222222222222";
  const row: SettlementRequestRow = {
    id: REQUEST,
    tripId: TRIP,
    fromUserId: BOB,
    toUserId: ALICE,
    amountCents: 1234,
    currency: "USD",
    note: "dinner",
    status: "open",
    settlementId: null,
    createdAt: new Date("2026-08-26T10:00:00.000Z"),
    updatedAt: new Date("2026-08-26T10:00:00.000Z"),
  };

  it("builds the universal link from the ONE shared LINK_DOMAIN placeholder (P-14 swap point)", () => {
    expect(settleRequestUrl(TRIP, REQUEST)).toBe(
      `https://${LINK_DOMAIN}/t/${TRIP}/request/${REQUEST}`,
    );
  });

  it("serializes the full SettleRequest shape; created_by = to_user_id ([I-3])", () => {
    const wire = SettleRequestSchema.parse(toSettleRequestWire(row, false));
    expect(wire).toEqual({
      id: REQUEST,
      trip_id: TRIP,
      from_user_id: BOB,
      to_user_id: ALICE,
      amount_cents: 1234,
      currency: "USD",
      note: "dinner",
      status: "open",
      resolved: false,
      settlement_id: null,
      created_by: ALICE,
      created_at: "2026-08-26T10:00:00.000Z",
      link: settleRequestUrl(TRIP, REQUEST),
    });
  });

  it("passes the derived resolved flag through untouched ([I-1] is the caller's)", () => {
    expect(toSettleRequestWire(row, true).resolved).toBe(true);
    expect(toSettleRequestWire(row, false).resolved).toBe(false);
  });
});
