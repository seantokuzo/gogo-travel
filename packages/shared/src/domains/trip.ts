/**
 * Trips domain (contracts spec §3.4; schema spec §3.3.4; trips spec §3.3/§3.4).
 */
import { z } from "zod";
import { TripStatusSchema, type TripStatus } from "../enums.js";
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
    name: z.string().trim().min(1),
    destination_name: z.string().trim().min(1),
    destination_lat: LatSchema,
    destination_lng: LngSchema,
    start_date: ISODateSchema,
    end_date: ISODateSchema,
    base_currency: CurrencyCodeSchema.optional(),
    theme: z.string().optional(),
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
    name: z.string().trim().min(1).optional(),
    destination_name: z.string().trim().min(1).optional(),
    destination_lat: LatSchema.optional(),
    destination_lng: LngSchema.optional(),
    start_date: ISODateSchema.optional(),
    end_date: ISODateSchema.optional(),
    theme: z.string().nullable().optional(),
    base_currency: CurrencyCodeSchema.optional(),
    status: TripStatusSchema.nullable().optional(),
    expect_updated_at: ISODateTimeSchema.optional(),
  })
  .superRefine(dateOrderRule);
export type TripUpdate = z.infer<typeof TripUpdateSchema>;

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
