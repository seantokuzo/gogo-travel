/**
 * Trips domain (contracts spec §3.4; schema spec §3.3.4; trips spec §3.3/§3.4).
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { CursorQuerySchema, NoContentSchema, paginatedSchema } from "../api/envelope.js";
import { TripMemberRoleSchema, TripStatusSchema, type TripStatus } from "../enums.js";
import {
  CentsSchema,
  CurrencyCodeSchema,
  ISODateSchema,
  ISODateTimeSchema,
  LatSchema,
  LngSchema,
  UuidSchema,
  type ISODate,
} from "../scalars.js";

/** The `trips` row as the API returns it. */
export const TripSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  destination_name: z.string(),
  destination_lat: LatSchema,
  destination_lng: LngSchema,
  start_date: ISODateSchema,
  end_date: ISODateSchema,
  /** Effective status; date-derived unless overridden (R-db-19). */
  status: TripStatusSchema,
  /** Manual override; wins until cleared. Owner-only write ("archive" = override to 'past'). */
  status_override: TripStatusSchema.nullable(),
  base_currency: CurrencyCodeSchema,
  /** Optional overall trip cap in `base_currency`; null = no overall cap. */
  budget_cap_cents: CentsSchema.nullable(),
  /** Trip accent key into `packages/tokens`; null = app default. */
  theme: z.string().nullable(),
  created_by: UuidSchema,
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type Trip = z.infer<typeof TripSchema>;

/**
 * Free-text caps — DoS headroom, same convention as the credential caps in
 * `auth.ts` and `DisplayNameSchema` in `user.ts`: generous for any real
 * input, bounded so no write surface accepts megabyte strings. `theme` is a
 * key into `packages/tokens` themes (schema §3.3.4) — 64 is roomy for a key.
 */
const TripNameSchema = z.string().trim().min(1).max(200);
const DestinationNameSchema = z.string().trim().min(1).max(200);
const ThemeKeySchema = z.string().max(64);

const dateOrderRule = (
  val: { start_date?: ISODate | undefined; end_date?: ISODate | undefined },
  ctx: z.core.$RefinementCtx,
): void => {
  if (val.start_date !== undefined && val.end_date !== undefined && val.start_date > val.end_date) {
    ctx.addIssue({
      code: "custom",
      message: "start_date must be on or before end_date",
      path: ["end_date"],
    });
  }
};

/**
 * `POST /trips` (trips spec §3.3). Dates are required at creation and the
 * destination is structured (Overture-backed search) — lat/lng always
 * present (Gate 2). `base_currency` defaults server-side to 'USD'.
 */
export const TripCreateSchema = z
  .object({
    name: TripNameSchema,
    destination_name: DestinationNameSchema,
    destination_lat: LatSchema,
    destination_lng: LngSchema,
    start_date: ISODateSchema,
    end_date: ISODateSchema,
    base_currency: CurrencyCodeSchema.optional(),
    theme: ThemeKeySchema.optional(),
  })
  .superRefine(dateOrderRule);
export type TripCreate = z.infer<typeof TripCreateSchema>;

/**
 * `PATCH /trips/:tripId` (trips spec §3.3). Per-field authz is the server's
 * (§3.2 matrix). `status` is the owner-only manual override (`null` clears
 * it — derivation resumes). `expect_updated_at` is the optional optimistic-
 * concurrency precondition (§3.5 rule 2). Date-order across a partial update
 * is re-validated server-side against stored values.
 */
export const TripUpdateSchema = z
  .object({
    name: TripNameSchema.optional(),
    destination_name: DestinationNameSchema.optional(),
    destination_lat: LatSchema.optional(),
    destination_lng: LngSchema.optional(),
    start_date: ISODateSchema.optional(),
    end_date: ISODateSchema.optional(),
    theme: ThemeKeySchema.nullable().optional(),
    base_currency: CurrencyCodeSchema.optional(),
    status: TripStatusSchema.nullable().optional(),
    expect_updated_at: ISODateTimeSchema.optional(),
  })
  .superRefine(dateOrderRule);
export type TripUpdate = z.infer<typeof TripUpdateSchema>;

/**
 * `Trip` plus the CALLER's role — `POST /trips` (always `'owner'`) and
 * `GET /trips/:tripId` responses (trips spec §3.3).
 */
export const TripWithRoleSchema = TripSchema.extend({
  role: TripMemberRoleSchema,
});
export type TripWithRole = z.infer<typeof TripWithRoleSchema>;

/**
 * `GET /trips` list item (trips spec §3.3):
 * `Trip & { role: trip_member_role, member_count: int }`.
 */
export const TripListItemSchema = TripSchema.extend({
  role: TripMemberRoleSchema,
  /** Membership rows on the trip — always ≥ 1 (the owner, R-trips-3). */
  member_count: z.int().positive(),
});
export type TripListItem = z.infer<typeof TripListItemSchema>;

/**
 * `GET /trips` query (trips spec §3.3: `{ cursor?, limit? }`) — the standard
 * `CursorQuerySchema` list shape (envelope §3.5) plus `limit`, which is
 * coerced (query params arrive as strings) and server-capped — the bounds
 * here ARE the server's cap (page-size caps are server-defined).
 */
export const TripListQuerySchema = CursorQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type TripListQuery = z.infer<typeof TripListQuerySchema>;

/**
 * Derived-status rule (trips spec §3.4) — the single definition server and
 * client both use, so the boundary day can never drift (same seam pattern as
 * `canViewPhoto`). `today` is an explicit input (caller supplies its tz's
 * current date). ISO dates compare lexicographically.
 */
export function deriveTripStatus(
  today: ISODate,
  start_date: ISODate | null | undefined,
  end_date: ISODate | null | undefined,
): TripStatus {
  if (!start_date || !end_date) return "planning";
  if (today < start_date) return "planning";
  if (today > end_date) return "past";
  return "active";
}

// ---------------------------------------------------------------------------
// Endpoint descriptors (trips spec §3.3; contracts spec §3.6)
// ---------------------------------------------------------------------------

const tripIdParams = z.object({ tripId: UuidSchema });

/**
 * Machine-readable mirror of the trip CRUD routes (API-TRIPS-1). All run
 * behind `requireAuth`; the `/:tripId` routes additionally sit behind the
 * trip-membership gate — a non-member's 404 is indistinguishable from an
 * absent trip (R-trips-1, IDOR posture). Members/invites descriptors land
 * with API-TRIPS-2/3 in `domains/member.ts`.
 */
export const tripEndpoints = {
  /** Trip + creator's owner membership in ONE transaction (R-trips-3). */
  createTrip: {
    method: "POST",
    path: "/trips",
    body: TripCreateSchema,
    response: TripWithRoleSchema,
  },
  /** Only trips where the caller holds a membership row (R-trips-4). */
  listTrips: {
    method: "GET",
    path: "/trips",
    query: TripListQuerySchema,
    response: paginatedSchema(TripListItemSchema),
  },
  /** 404 for absent trip OR non-member — indistinguishable (R-trips-1). */
  getTrip: {
    method: "GET",
    path: "/trips/:tripId",
    params: tripIdParams,
    response: TripWithRoleSchema,
  },
  /**
   * Row-grain LWW with optional `expect_updated_at` precondition
   * (R-trips-5/6); per-field authz per §3.2 (R-trips-20); returns the full
   * updated row (R-trips-19).
   */
  updateTrip: {
    method: "PATCH",
    path: "/trips/:tripId",
    params: tripIdParams,
    body: TripUpdateSchema,
    response: TripSchema,
  },
  /** Owner-only; cascades per schema §3.6 (R-trips-8). 204. */
  deleteTrip: {
    method: "DELETE",
    path: "/trips/:tripId",
    params: tripIdParams,
    response: NoContentSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
