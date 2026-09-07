/**
 * Settle-flow fixtures (T-9.7 / CMON-5+CMON-6) — wire-schema-VALID
 * documents for the settle/request suites, extending money-fixtures (its
 * module doc carries the posture: every builder round-trips through the
 * `@gogo/shared` schema so contract drift turns suites RED).
 *
 * NEW FILE on purpose (W4 ∥ contract): T-9.6 owns expense fixtures in
 * money-fixtures.ts; settle fixtures live here so the waves never write
 * one file.
 */
import {
  SettleRequestDetailSchema,
  SettlementSchema,
  type SettleRequestDetail,
  type Settlement,
  type UserProfile,
} from "@gogo/shared";

import { MEMBER_B_ID, TEST_TRIP_ID } from "./ids";
import { makeSettleRequest, TEST_REQUEST_ID } from "./money-fixtures";
import { TEST_USER } from "./session-fixtures";
import { makeUserProfile } from "./trip-fixtures";

export const TEST_SETTLEMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A counterparty profile with EVERY §3.4 handle set (all four rails render). */
export function makeHandlesProfile(overrides?: Partial<UserProfile>): UserProfile {
  return makeUserProfile({
    id: MEMBER_B_ID,
    display_name: "Blair",
    venmo_username: "blair-v",
    cashtag: "blairc",
    paypalme_username: "blairpay",
    zelle_handle: "blair@example.com",
    zelle_display_name: "Blair Z",
    ...overrides,
  });
}

/**
 * Q2 document: an OPEN request billing the CALLER (from = TEST_USER) sent
 * by Blair (creditor/requester) — the recipient-view default universe.
 */
export function makeSettleRequestDetail(
  overrides?: Partial<SettleRequestDetail>,
): SettleRequestDetail {
  return SettleRequestDetailSchema.parse({
    ...makeSettleRequest({
      from_user_id: TEST_USER.id,
      to_user_id: MEMBER_B_ID,
      created_by: MEMBER_B_ID,
    }),
    requester: makeHandlesProfile(),
    ...overrides,
  });
}

/** S1/S2 row — Blair paid the caller 2550 by default. */
export function makeSettlement(overrides?: Partial<Settlement>): Settlement {
  return SettlementSchema.parse({
    id: TEST_SETTLEMENT_ID,
    trip_id: TEST_TRIP_ID,
    from_user_id: MEMBER_B_ID,
    to_user_id: TEST_USER.id,
    amount_cents: 2550,
    currency: "USD",
    method: "venmo",
    note: null,
    settled_at: "2026-08-23T10:00:00.000Z",
    created_by: MEMBER_B_ID,
    created_at: "2026-08-23T10:00:00.000Z",
    ...overrides,
  });
}

export { TEST_REQUEST_ID };

export interface SettleApiOptions {
  /** Q2 responder result; default: the open recipient-view document. */
  requestDetail?: (input: Record<string, unknown>) => Promise<unknown>;
  /** S1 responder; default: echo the body into a valid Settlement. */
  createSettlement?: (input: Record<string, unknown>) => Promise<unknown>;
  /** Q1 responder; default: mint an open request from the body. */
  createSettleRequest?: (input: Record<string, unknown>) => Promise<unknown>;
  /** Q3 responder; default: 204-shaped undefined. */
  cancelSettleRequest?: (input: Record<string, unknown>) => Promise<unknown>;
  /** S2 responder; default: empty page. */
  settlements?: Settlement[];
}

/**
 * Settle-family `overrides` for `mockNavApi` — `METHOD path` → responder,
 * the descriptor-routing convention of trip-fixtures.
 */
export function settleApiOverrides(
  opts: SettleApiOptions = {},
): Record<string, (input: Record<string, unknown>) => Promise<unknown>> {
  return {
    "GET /trips/:tripId/settle-requests/:requestId":
      opts.requestDetail ?? (() => Promise.resolve(makeSettleRequestDetail())),
    "POST /trips/:tripId/settlements":
      opts.createSettlement ??
      ((input) => {
        const body = input["body"] as Record<string, unknown>;
        return Promise.resolve(
          makeSettlement({
            from_user_id: body["from_user_id"] as string,
            to_user_id: body["to_user_id"] as string,
            amount_cents: body["amount_cents"] as number,
            currency: body["currency"] as string,
            method: body["method"] as Settlement["method"],
            note: (body["note"] as string | undefined) ?? null,
            created_by: body["from_user_id"] as string,
          }),
        );
      }),
    "POST /trips/:tripId/settle-requests":
      opts.createSettleRequest ??
      ((input) => {
        const body = input["body"] as Record<string, unknown>;
        return Promise.resolve(
          makeSettleRequest({
            from_user_id: body["from_user_id"] as string,
            amount_cents: (body["amount_cents"] as number | undefined) ?? 2550,
            note: (body["note"] as string | undefined) ?? null,
          }),
        );
      }),
    "DELETE /trips/:tripId/settle-requests/:requestId":
      opts.cancelSettleRequest ?? (() => Promise.resolve(undefined)),
    "GET /trips/:tripId/settlements": () =>
      Promise.resolve({ items: opts.settlements ?? [], nextCursor: null }),
  };
}
