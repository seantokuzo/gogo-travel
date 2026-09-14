/**
 * Required-ness is READ OFF the shared Zod schemas (B-26). Two properties
 * are load-bearing and the second is the one a hand-list would break:
 *
 *  1. it agrees with the contract TODAY — Name is required, nothing else is;
 *  2. it FOLLOWS the contract. Change the schema and the answer changes,
 *     with no edit here. The probe below is the falsification: a synthetic
 *     schema whose optionality is flipped must flip the answer, so a future
 *     hardcoded list cannot pass this file.
 */
import { BookingCategorySchema } from "@gogo/shared";

import { CATEGORY_FIELDS } from "./form-model";
import { requiredBookingFieldKeys, schemaRequiredKeys } from "./required-fields";

const CATEGORIES = BookingCategorySchema.options;

/** A structural stand-in — only `.shape` and `.safeParse` are ever touched. */
function fakeSchema(optionality: Record<string, boolean>) {
  return {
    shape: Object.fromEntries(
      Object.entries(optionality).map(([key, optional]) => [
        key,
        { safeParse: (value: unknown) => ({ success: optional || value !== undefined }) },
      ]),
    ),
  };
}

describe("schemaRequiredKeys", () => {
  it("names exactly the members that REJECT undefined", () => {
    const required = schemaRequiredKeys(fakeSchema({ title: false, notes: true, category: false }));
    expect([...required].sort()).toEqual(["category", "title"]);
  });

  it("MUTATION: flipping a member to optional removes it — the answer is the schema's", () => {
    // The falsification for every arm in this file. A hardcoded list would
    // answer the same both times.
    const before = schemaRequiredKeys(fakeSchema({ title: false, code: false }));
    const after = schemaRequiredKeys(fakeSchema({ title: false, code: true }));
    expect([...before].sort()).toEqual(["code", "title"]);
    expect([...after]).toEqual(["title"]);
  });

  it("an all-optional schema requires nothing — no floor is invented", () => {
    expect([...schemaRequiredKeys(fakeSchema({ a: true, b: true }))]).toEqual([]);
  });
});

describe("requiredBookingFieldKeys, against the REAL contract", () => {
  it("Name is required for every category, and it is the ONLY one", () => {
    // `BookingCreateSchema` requires `category` + `title`; every detail
    // field in every `BookingDetails` member is `.optional()` by design
    // (booking.ts module doc). `category` is filtered out because no control
    // renders it — the route supplies it.
    for (const category of CATEGORIES) {
      expect([...requiredBookingFieldKeys(category)]).toEqual(["title"]);
    }
  });

  it("does not mark `category` — marking it would point at no control", () => {
    for (const category of CATEGORIES) {
      expect(requiredBookingFieldKeys(category).has("category")).toBe(false);
      expect(requiredBookingFieldKeys(category).has("details")).toBe(false);
      expect(requiredBookingFieldKeys(category).has("source")).toBe(false);
    }
  });

  it("every key it can return is rendered by a control that CAN show a marker", () => {
    // The drift guard for the plumbing rather than the derivation: if the
    // contract ever makes a detail field mandatory, the form must be able to
    // mark it. Only `Input`-backed kinds carry `required`; `datetime` and
    // `enum` render their own labels and would silently drop it.
    const MARKABLE_KINDS = new Set(["text", "int", "url", "iata", "airline"]);
    // Common-section keys (round-1 review A5): NOT in `CATEGORY_FIELDS` (they
    // render outside the per-category loop), so the kind check above can't
    // see them at all. Each is verified markable BY NAME rather than
    // silently trusted — `place` is the exact gap A5 found: it fell through
    // this exact "not in CATEGORY_FIELDS" branch via
    // `CREATE_KEY_TO_FORM_KEY`'s `place_id` → `place` mapping while
    // `PlacePickerField` had no `required` prop to show one. An allowlist
    // that must be EXTENDED for any newly-required common key (rather than a
    // bare `continue`) is what makes a future repeat of exactly this
    // impossible to miss silently — the test fails LOUD, not green-by-skip.
    const COMMON_MARKABLE_KEYS = new Set(["title", "price", "currency", "confirmation", "place"]);
    for (const category of CATEGORIES) {
      for (const key of requiredBookingFieldKeys(category)) {
        const field = CATEGORY_FIELDS[category].find((candidate) => candidate.key === key);
        if (field === undefined) {
          expect(COMMON_MARKABLE_KEYS.has(key)).toBe(true);
          continue;
        }
        expect(MARKABLE_KINDS.has(field.kind)).toBe(true);
      }
    }
  });
});
