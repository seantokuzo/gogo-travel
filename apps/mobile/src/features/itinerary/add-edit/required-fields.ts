/**
 * Which booking-form fields are REQUIRED — derived from the shared Zod
 * schemas, never hand-listed (B-26, device QA 2026-09-11: "there's no
 * indicator of what fields are required").
 *
 * WHY DERIVED. A hand-list in the UI is a second source of truth for the
 * wire contract, and `.claude/rules/shared.md` R-shared-1 exists because
 * that duplicate always drifts: make `confirmation_code` mandatory in
 * `packages/shared` and a hand-listed form keeps saying it is optional,
 * right up until the save 400s with the form still claiming everything was
 * filled in. So required-ness is READ OFF the schema at render time by
 * probing each field with `undefined`: a member that rejects `undefined`
 * is required, one that accepts it is `.optional()`. That probe is Zod's
 * own answer, so it cannot disagree with the parse the save runs.
 *
 * WHAT THE CONTRACT ACTUALLY SAYS (today, 2026-09-11) — read it before
 * assuming this file is broken because it marks so little:
 *
 *  - `BookingCreateSchema`: only `category` and `title` are required, and
 *    `category` is not a form control (the route picks it). So **Name is
 *    the only required booking field.**
 *  - Every per-category `BookingDetails` member: `category` (the
 *    discriminant literal) and NOTHING else — every detail field is
 *    `.optional()` "by design (an `idea` may know nothing; capture fills
 *    what it finds; the UI prompts for gaps)" (booking.ts module doc).
 *  - `BookingUpdateSchema`: every field optional (a PATCH is partial).
 *
 * WHAT THE SCHEMA CANNOT EXPRESS, and is therefore NOT marked here:
 *
 *  - **Conditional pairs.** "a price requires a currency" (R-ib-12) is a
 *    `superRefine`, not an optionality flag — it depends on the OTHER
 *    field's value, so no static marker is honest. It surfaces where it
 *    can be honest: as the save's field-level error (`save-errors.ts`).
 *  - **Client composition invariants.** "set both date and time, or clear
 *    both" and "pick the time zone for this time" (`TZ_MISSING_ERROR`) are
 *    `buildDetails` rules with no wire counterpart — a datetime is optional
 *    on the wire and only becomes half-required once you start filling it.
 *
 * Neither gap is papered over with a hardcoded marker. Whether the PRODUCT
 * wants more required fields than the contract does (e.g. a flight
 * insisting on a departure time) is a Law #4 spec question, recorded in the
 * B-26 PR body — not something this module invents.
 */
import { BookingCreateSchema, BookingDetailsSchema, type BookingCategory } from "@gogo/shared";

import { CATEGORY_FIELDS } from "./form-model";

/**
 * The structural slice of a Zod schema this module needs. Declared locally
 * rather than imported as `z.ZodObject`: `apps/mobile` has no `zod`
 * dependency (the schemas arrive built, through `@gogo/shared`), and the
 * probe only ever touches `.shape` and `.safeParse`.
 */
interface OptionalityProbe {
  safeParse(value: unknown): { success: boolean };
}
interface ObjectSchemaLike {
  readonly shape: Readonly<Record<string, OptionalityProbe>>;
}
interface UnionSchemaLike {
  readonly options: readonly ObjectSchemaLike[];
}

/**
 * Keys of an object schema that REJECT `undefined` — i.e. the ones a
 * caller must supply. Zod 4 keeps `.shape` addressable through
 * `.superRefine()`, so the refined create/update schemas probe directly.
 */
export function schemaRequiredKeys(schema: ObjectSchemaLike): ReadonlySet<string> {
  const required = new Set<string>();
  for (const [key, member] of Object.entries(schema.shape)) {
    if (!member.safeParse(undefined).success) required.add(key);
  }
  return required;
}

/** The `BookingDetails` union member for a category, or `null` if absent. */
function detailsMemberFor(category: BookingCategory): ObjectSchemaLike | null {
  const union = BookingDetailsSchema as unknown as UnionSchemaLike;
  for (const member of union.options) {
    const discriminant = member.shape["category"];
    if (discriminant !== undefined && discriminant.safeParse(category).success) return member;
  }
  return null;
}

/**
 * Form field keys the CREATE contract requires, expressed in the form's own
 * key space (the ids `BookingForm` renders against).
 *
 * `category` is filtered out deliberately: it is required on the wire but
 * is not a control the user can fill — the route supplies it — so marking
 * it would point at nothing.
 */
export function requiredBookingFieldKeys(category: BookingCategory): ReadonlySet<string> {
  const required = new Set<string>();
  for (const key of schemaRequiredKeys(BookingCreateSchema as unknown as ObjectSchemaLike)) {
    const formKey = CREATE_KEY_TO_FORM_KEY[key];
    if (formKey !== undefined) required.add(formKey);
  }
  const details = detailsMemberFor(category);
  if (details !== null) {
    const detailKeys = new Set(CATEGORY_FIELDS[category].map((field) => field.key));
    for (const key of schemaRequiredKeys(details)) {
      if (detailKeys.has(key)) required.add(key);
    }
  }
  return required;
}

/**
 * Wire key → the form key that renders it. NOT a required-ness list (that
 * is read off the schema above) — purely the id translation between the
 * contract's names and the §2.9 testID/field names, which differ for two
 * of them (`price_cents`/`confirmation_code`). Wire keys with no control —
 * `category` (route-supplied), `details` (a container, its members are
 * marked individually), `source` (never user-set) — are absent on purpose,
 * so a newly-required one of those cannot silently mark a random field.
 */
const CREATE_KEY_TO_FORM_KEY: Readonly<Record<string, string>> = {
  title: "title",
  price_cents: "price",
  currency: "currency",
  confirmation_code: "confirmation",
  place_id: "place",
};
