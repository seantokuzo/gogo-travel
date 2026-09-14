/**
 * The B-8 SECONDARY, made testable (B-26): a refused save has to say WHY,
 * and where it can, it has to say it ON the field that is wrong.
 *
 * The regression these pin: `BookingForm` used to answer every client-side
 * schema refusal with one fixed sentence ("The booking details don't
 * validate — check the fields") and every SERVER refusal with another
 * ("Couldn't save the booking. Try again."), discarding `parsed.error` and
 * `ApiRequestError.message` respectively. The server's message is the only
 * place a rule like "the category's primary end time precedes its start
 * time" is ever stated.
 */
import { BookingCreateSchema } from "@gogo/shared";

import {
  bannerForFieldErrors,
  failureFromApiError,
  failureFromIssues,
  fieldLabelFor,
  formKeyForPath,
} from "./save-errors";

describe("formKeyForPath", () => {
  it("maps the common section's wire keys onto the form's own ids", () => {
    expect(formKeyForPath("flight", ["title"])).toBe("title");
    expect(formKeyForPath("flight", ["price_cents"])).toBe("price");
    expect(formKeyForPath("flight", ["currency"])).toBe("currency");
    expect(formKeyForPath("flight", ["confirmation_code"])).toBe("confirmation");
  });

  it("maps a details member onto the field that renders it", () => {
    expect(formKeyForPath("flight", ["details", "origin_iata"])).toBe("origin_iata");
    expect(formKeyForPath("lodging", ["details", "property_name"])).toBe("property_name");
  });

  it("routes a ZONE rejection to its datetime field — the zone has no slot of its own", () => {
    // BookingForm renders the zone picker under the datetime field and
    // shares that field's error key (the TZ_MISSING_ERROR split), so a
    // `departs_tz` message keyed anywhere else renders nowhere.
    expect(formKeyForPath("flight", ["details", "departs_tz"])).toBe("departs_at");
    expect(formKeyForPath("train", ["details", "arrives_tz"])).toBe("arrives_at");
  });

  it("refuses to guess: an unrendered or whole-object path maps to nothing", () => {
    // A wrong guess is worse than a banner — it would pin a reason on an
    // innocent field.
    expect(formKeyForPath("flight", [])).toBeNull();
    expect(formKeyForPath("flight", ["source"])).toBeNull();
    expect(formKeyForPath("flight", ["details"])).toBeNull();
    // `notes` is on the wire for every category but no form field renders it.
    expect(formKeyForPath("flight", ["details", "notes"])).toBeNull();
    // A lodging field asked for under `flight` belongs to no control here.
    expect(formKeyForPath("flight", ["details", "property_name"])).toBeNull();
  });
});

describe("failureFromIssues (the client-side safeParse refusal)", () => {
  it("puts each reason on its field and points the banner at them", () => {
    const failure = failureFromIssues(
      "flight",
      [
        { path: ["title"], message: "Too small: expected string to have >=1 characters" },
        { path: ["currency"], message: "price_cents requires a currency" },
      ],
      "fallback",
    );
    expect(failure.fieldErrors).toEqual({
      title: "Too small: expected string to have >=1 characters",
      currency: "price_cents requires a currency",
    });
    expect(failure.banner).toBe("These fields need attention: Name, Currency.");
    expect(failure.banner).not.toContain("don't validate");
  });

  it("a single offender is named, not counted", () => {
    const failure = failureFromIssues(
      "flight",
      [{ path: ["details", "origin_iata"], message: "Too big" }],
      "fallback",
    );
    expect(failure.fieldErrors).toEqual({ origin_iata: "Too big" });
    expect(failure.banner).toBe("From (IATA) needs attention — see the message under it.");
  });

  it("a reason with no field of its own is shown VERBATIM in the banner", () => {
    // The whole point of the B-8 SECONDARY: a cross-field or service rule is
    // stated nowhere else, so erasing it erases the only explanation.
    const failure = failureFromIssues(
      "flight",
      [{ path: [], message: "the category's primary end time precedes its start time" }],
      "fallback",
    );
    expect(failure.fieldErrors).toEqual({});
    expect(failure.banner).toBe("the category's primary end time precedes its start time");
  });

  it("keeps the FIRST reason per field — an error slot shows one message", () => {
    const failure = failureFromIssues(
      "flight",
      [
        { path: ["title"], message: "first" },
        { path: ["title"], message: "second" },
      ],
      "fallback",
    );
    expect(failure.fieldErrors["title"]).toBe("first");
  });

  it("falls back only when there is genuinely nothing to say", () => {
    expect(failureFromIssues("flight", [], "fallback").banner).toBe("fallback");
    expect(failureFromIssues("flight", [{ path: ["title"], message: "  " }], "fb").banner).toBe(
      "fb",
    );
  });

  it("REAL schema: an empty title produces a real reason on the Name field", () => {
    // Not a synthetic issue list — this is what the form actually gets.
    const parsed = BookingCreateSchema.safeParse({
      category: "flight",
      title: "",
      details: { category: "flight" },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const failure = failureFromIssues("flight", parsed.error.issues, "fallback");
    expect(Object.keys(failure.fieldErrors)).toEqual(["title"]);
    expect(failure.fieldErrors["title"]).not.toBe("");
    expect(failure.banner).toBe("Name needs attention — see the message under it.");
  });

  it("REAL schema: the R-ib-12 price/currency rule lands on Currency, not in a void", () => {
    const parsed = BookingCreateSchema.safeParse({
      category: "flight",
      title: "SFO to Tokyo",
      details: { category: "flight" },
      price_cents: 8999,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const failure = failureFromIssues("flight", parsed.error.issues, "fallback");
    expect(failure.fieldErrors["currency"]).toBe("price_cents requires a currency");
  });
});

describe("failureFromApiError (the SERVER refusal)", () => {
  it("shows the server's own message when nothing structured came back", () => {
    // The B-8 case verbatim: the booking service answers VALIDATION_FAILED
    // with a bare sentence and no details payload.
    const failure = failureFromApiError(
      "flight",
      {
        status: 400,
        message: "the category's primary end time precedes its start time",
      },
      "Couldn't save the booking. Try again.",
    );
    expect(failure.banner).toBe("the category's primary end time precedes its start time");
    expect(failure.fieldErrors).toEqual({});
  });

  it("spreads a flattened Zod payload onto the fields it names", () => {
    // `apps/server/src/http/validation.ts` sends `z.flattenError`.
    const failure = failureFromApiError(
      "flight",
      {
        status: 400,
        message: "request body failed validation",
        details: {
          formErrors: [],
          fieldErrors: { title: ["Too small"], confirmation_code: ["Too big"] },
        },
      },
      "fallback",
    );
    expect(failure.fieldErrors).toEqual({ title: "Too small", confirmation: "Too big" });
    expect(failure.banner).toBe("These fields need attention: Name, Confirmation code.");
  });

  it("a flattened payload keyed `details` stays a banner reason, not a guess", () => {
    // `flattenError` buckets nested paths under their TOP-LEVEL segment, so
    // `details.departs_at` arrives as `details` — which field it belongs to
    // is unknowable from here.
    const failure = failureFromApiError(
      "flight",
      {
        status: 400,
        message: "request body failed validation",
        details: { formErrors: [], fieldErrors: { details: ["Invalid datetime"] } },
      },
      "fallback",
    );
    expect(failure.fieldErrors).toEqual({});
    expect(failure.banner).toBe("Invalid datetime");
  });

  it("survives a details payload that is not the shape we expect", () => {
    for (const details of [null, "nope", 42, { fieldErrors: "nope" }, { formErrors: [1, 2] }]) {
      const failure = failureFromApiError(
        "flight",
        { status: 500, message: "boom", details },
        "fb",
      );
      expect(failure.banner).toBe("boom");
      expect(failure.fieldErrors).toEqual({});
    }
  });

  it("falls back when the server said nothing at all", () => {
    expect(failureFromApiError("flight", { status: 500, message: "   " }, "fb").banner).toBe("fb");
  });

  it("clamps a hostile-length server message instead of rendering a wall of text", () => {
    const failure = failureFromApiError("flight", { status: 400, message: "x".repeat(5000) }, "fb");
    expect(failure.banner.length).toBeLessThanOrEqual(300);
    expect(failure.banner.endsWith("…")).toBe(true);
  });
});

describe("bannerForFieldErrors (the buildDetails / money-parse refusal)", () => {
  it("names the offending fields rather than restating their messages", () => {
    // Those fields already render their own text; what the user cannot see
    // from the Save button at the bottom of the form is WHICH ones.
    expect(
      bannerForFieldErrors("flight", {
        title: "Give it a name.",
        departs_at: "Pick the time zone for this time.",
      }),
    ).toBe("These fields need attention: Name, Departs.");
  });

  it("ignores cleared entries — the form keeps empty strings as 'no error'", () => {
    expect(bannerForFieldErrors("flight", { title: "Give it a name.", seat: "" })).toBe(
      "Name needs attention — see the message under it.",
    );
  });
});

describe("fieldLabelFor", () => {
  it("answers for the common section and the per-category fields", () => {
    expect(fieldLabelFor("flight", "title")).toBe("Name");
    expect(fieldLabelFor("flight", "departs_at")).toBe("Departs");
    expect(fieldLabelFor("lodging", "check_out")).toBe("Check-out");
  });

  it("is null for anything nothing renders", () => {
    expect(fieldLabelFor("flight", "notes")).toBeNull();
    expect(fieldLabelFor("flight", "check_in")).toBeNull();
  });
});
