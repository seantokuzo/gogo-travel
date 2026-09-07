/**
 * Form-model pins (T-7.6 / IT-7 — §2.4 pure halves):
 *  - every category's field config composes a VALID BookingDetails via the
 *    shared schema (falsifiable against the wire, not against itself);
 *  - datetime both-or-neither rule; int validation; empty-field omission;
 *  - Law #2 money: string-math cents, float-free, reversible;
 *  - §3.2 status options (no idea segment from booked; cancelled terminal);
 *  - gap-tap prefill seeds the category's primary start;
 *  - deeplink input mapping feeds the §2.7 panel from live form state.
 */
import { BookingDetailsSchema, BOOKING_CATEGORIES } from "@gogo/shared";

import {
  addOptionSlug,
  buildDetails,
  CATEGORY_FIELDS,
  centsToMoneyText,
  composeLocalDateTime,
  deeplinkInputFor,
  emptyFormState,
  fieldInputTraits,
  parseMoneyToCents,
  primaryStartKey,
  stateFromDetails,
  statusOptionsFor,
  type DetailsFormState,
} from "./form-model";

describe("buildDetails (state → wire)", () => {
  it("every category: a fully-populated form state parses under BookingDetailsSchema", () => {
    for (const category of BOOKING_CATEGORIES) {
      const state = emptyFormState(category);
      for (const field of CATEGORY_FIELDS[category]) {
        if (field.kind === "datetime")
          state[field.key] = {
            date: "2027-03-02",
            time: "14:30",
            // B-9: a wire-zoned time needs its zone — buildDetails refuses
            // to Z-stamp one (that refusal IS the B-8 fix).
            ...(field.tzKey !== undefined ? { tz: "Asia/Tokyo" } : {}),
          };
        else if (field.kind === "int") state[field.key] = "3";
        else if (field.kind === "url") state[field.key] = "https://example.com/x";
        else if (field.kind === "iata") state[field.key] = "NRT";
        else if (field.kind === "enum") state[field.key] = field.options[0] ?? "";
        else state[field.key] = "Some text";
      }
      const built = buildDetails(category, state);
      expect(built.errors).toEqual({});
      expect(built.details).not.toBeNull();
      const parsed = BookingDetailsSchema.safeParse(built.details);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.category).toBe(category);
      // KEY-IDENTITY pin (round-1 blocker): `success` alone proves value
      // FORMATS only — BookingDetailsSchema members are non-strict objects
      // that STRIP unknown keys (R-shared-10), so a CATEGORY_FIELDS key
      // typo (`flight_number` → `flight_num`) parsed green while the datum
      // was silently dropped on the wire. Equality turns any stripped key
      // into an inequality, pinning all 8 categories' key maps at once.
      expect(parsed.success && parsed.data).toEqual(built.details);
    }
  });

  it("empty fields are omitted — a blank form is the minimal {category} member", () => {
    const built = buildDetails("flight", emptyFormState("flight"));
    expect(built.details).toEqual({ category: "flight" });
  });

  it("a datetime with only one half set is an error, never a silent drop", () => {
    const state = emptyFormState("lodging");
    state["check_in"] = { date: "2027-03-02", time: "" };
    const built = buildDetails("lodging", state);
    expect(built.details).toBeNull();
    expect(built.errors["check_in"]).toMatch(/both/i);
  });

  it("int fields reject non-integers", () => {
    const state = emptyFormState("lodging");
    state["guests"] = "2.5";
    const built = buildDetails("lodging", state);
    expect(built.details).toBeNull();
    expect(built.errors["guests"]).toBeDefined();
  });

  it("B-20: IATA fields must be exactly 3 letters; lowercase normalizes, junk errors", () => {
    // Lowercase self-heals (edit-mode prefill of stored lowercase must save,
    // not strand the user on an error for text they never typed).
    const ok = emptyFormState("flight");
    ok["origin_iata"] = "nrt";
    ok["destination_iata"] = "LAX";
    const builtOk = buildDetails("flight", ok);
    expect(builtOk.errors).toEqual({});
    expect(builtOk.details).toMatchObject({ origin_iata: "NRT", destination_iata: "LAX" });

    // Too short / not-a-code both error field-level (never the opaque
    // generic banner), and empty stays legal (every detail field optional).
    for (const bad of ["NR", "NRT4", "Narita"]) {
      const state = emptyFormState("flight");
      state["origin_iata"] = bad;
      const built = buildDetails("flight", state);
      expect(built.details).toBeNull();
      expect(built.errors["origin_iata"]).toMatch(/3-letter/);
    }
    expect(buildDetails("flight", emptyFormState("flight")).details).toEqual({
      category: "flight",
    });
  });

  it("B-20 R1: the IATA gate fires only on DIRTY values — an untouched stored prefill passes verbatim", () => {
    // A pre-B-20 (or AI-capture) booking can legally store origin_iata
    // "Narita" — the wire is optionalString(200), deliberately un-narrowed
    // (Q2). The gate guards what the USER typed; a title-only edit must not
    // strand the booking on a field the user never touched (round-1
    // correctness lane; B-15 dirty-guard precedent).
    const prefill = stateFromDetails({ category: "flight", origin_iata: "Narita" });
    const built = buildDetails("flight", { ...prefill }, prefill);
    expect(built.errors).toEqual({});
    expect(built.details).toMatchObject({ origin_iata: "Narita" }); // verbatim, not NARITA

    // Control: a USER-TYPED non-code (dirty — ≠ the prefill) still errors.
    const dirty = buildDetails("flight", { ...prefill, origin_iata: "Nari" }, prefill);
    expect(dirty.details).toBeNull();
    expect(dirty.errors["origin_iata"]).toMatch(/3-letter/);

    // Lowercase self-heal survives the prefill skip: a stored "nrt" is a
    // REAL code — it still normalizes to "NRT" on save, never verbatim.
    const lower = stateFromDetails({ category: "flight", origin_iata: "nrt" });
    const healed = buildDetails("flight", { ...lower }, lower);
    expect(healed.errors).toEqual({});
    expect(healed.details).toMatchObject({ origin_iata: "NRT" });
  });

  it("composeLocalDateTime round-trips through stateFromDetails (wall slicing)", () => {
    expect(composeLocalDateTime("2027-03-02", "14:30")).toBe("2027-03-02T14:30:00Z");
    const state = emptyFormState("activity");
    state["starts_at"] = { date: "2027-03-02", time: "14:30" };
    state["venue_name"] = "TeamLab";
    state["ticket_count"] = "2";
    const built = buildDetails("activity", state);
    expect(built.details).not.toBeNull();
    const back = stateFromDetails(built.details!);
    // B-9: the decomposed value carries `raw` — the stored string, re-emitted
    // verbatim if the user never opens the field (no `tz`: activity has no
    // `*_tz` on the wire, so it stays on the zoneless path).
    expect(back["starts_at"]).toEqual({
      date: "2027-03-02",
      time: "14:30",
      raw: "2027-03-02T14:30:00Z",
    });
    expect(back["venue_name"]).toBe("TeamLab");
    expect(back["ticket_count"]).toBe("2");
  });
});

describe("fieldInputTraits (B-20 — one derivation for every rendered field)", () => {
  it("iata: WIRE cap (B-9 R1 — never the 3-letter save rule), uppercase transform, no autocorrect", () => {
    const traits = fieldInputTraits({ key: "origin_iata", label: "From (IATA)", kind: "iata" });
    // B-9 widened the airport field to the wire cap so "Narita
    // International" is typeable; the 3-letter rule is enforced at the SAVE
    // gate (`buildDetails`), never as a typing cap. A 3 here would re-arm
    // the pre-B-9 bug for any consumer that trusts this one derivation.
    expect(traits.maxLength).toBe(200);
    expect(traits.autoCapitalize).toBe("characters");
    expect(traits.autoCorrect).toBe(false);
    expect(traits.transform("nrt")).toBe("NRT");
  });

  it("designator text: uppercase transform + no autocorrect ('ua837' → 'UA837')", () => {
    const traits = fieldInputTraits({
      key: "flight_number",
      label: "Flight number",
      kind: "text",
      designator: true,
    });
    expect(traits.transform("ua837")).toBe("UA837");
    expect(traits.autoCapitalize).toBe("characters");
    expect(traits.autoCorrect).toBe(false);
    expect(traits.maxLength).toBe(20);
  });

  it("plain text mirrors the wire caps: 200, 2000 when multiline; transform is identity", () => {
    const plain = fieldInputTraits({ key: "airline", label: "Airline", kind: "text" });
    expect(plain.maxLength).toBe(200);
    expect(plain.transform("Ana")).toBe("Ana");
    const notes = fieldInputTraits({
      key: "description",
      label: "Description",
      kind: "text",
      multiline: true,
    });
    expect(notes.maxLength).toBe(2000);
  });

  it("url: never capitalized or autocorrected (a 'corrected' URL is a broken URL)", () => {
    const traits = fieldInputTraits({ key: "external_url", label: "URL", kind: "url" });
    expect(traits.keyboardType).toBe("url");
    expect(traits.autoCapitalize).toBe("none");
    expect(traits.autoCorrect).toBe(false);
    expect(traits.maxLength).toBe(2048);
  });

  it("int: number pad + the INT_RE 9-digit ceiling", () => {
    const traits = fieldInputTraits({ key: "guests", label: "Guests", kind: "int" });
    expect(traits.keyboardType).toBe("number-pad");
    expect(traits.maxLength).toBe(9);
  });
});

describe("money (Law #2 — integer cents, string math; T-9.1 rider: shared ISO-4217 helpers)", () => {
  it("parses plain amounts into exact cents (2-decimal behavior unchanged by the rider)", () => {
    expect(parseMoneyToCents("120", "USD")).toEqual({ ok: true, cents: 12000 });
    expect(parseMoneyToCents("89.99", "USD")).toEqual({ ok: true, cents: 8999 });
    expect(parseMoneyToCents("89,9", "USD")).toEqual({ ok: true, cents: 8990 });
    expect(parseMoneyToCents("0.05", "USD")).toEqual({ ok: true, cents: 5 });
    // The classic float trap: 0.1 + 0.2 territory stays exact via strings.
    expect(parseMoneyToCents("0.29", "USD")).toEqual({ ok: true, cents: 29 });
  });

  it("zero-decimal currencies parse whole text AS the minor units (the rider's behavior change)", () => {
    expect(parseMoneyToCents("1500", "JPY")).toEqual({ ok: true, cents: 1500 });
    // Control arm: the SAME text under a 2dp currency still scales ×100 —
    // the split is the currency's, not a parser-wide change.
    expect(parseMoneyToCents("1500", "USD")).toEqual({ ok: true, cents: 150000 });
  });

  it("zero-decimal currencies reject decimal input (control: identical text valid under USD)", () => {
    for (const text of ["1500.5", "1500,5"]) {
      expect(parseMoneyToCents(text, "JPY").ok).toBe(false);
      expect(parseMoneyToCents(text, "USD").ok).toBe(true);
    }
  });

  it("rejects junk for any currency (negatives, letters, three decimals, thousands separators)", () => {
    for (const bad of ["-5", "abc", "1.234", "1,234.56", "12.", ""]) {
      expect(parseMoneyToCents(bad, "USD").ok).toBe(false);
      expect(parseMoneyToCents(bad, "JPY").ok).toBe(false);
    }
  });

  it("centsToMoneyText keeps the pre-rider 2dp display shape EXACTLY and round-trips", () => {
    expect(centsToMoneyText(12000, "USD")).toBe("120");
    expect(centsToMoneyText(8999, "USD")).toBe("89.99");
    expect(centsToMoneyText(5, "USD")).toBe("0.05");
    for (const cents of [12000, 8999, 5, 100, 1]) {
      const parsed = parseMoneyToCents(centsToMoneyText(cents, "USD"), "USD");
      expect(parsed).toEqual({ ok: true, cents });
    }
  });

  it("centsToMoneyText renders zero-decimal currencies whole and round-trips", () => {
    expect(centsToMoneyText(1500, "JPY")).toBe("1500");
    expect(centsToMoneyText(2550, "JPY")).toBe("2550");
    for (const cents of [1500, 2550, 1, 999999]) {
      const parsed = parseMoneyToCents(centsToMoneyText(cents, "JPY"), "JPY");
      expect(parsed).toEqual({ ok: true, cents });
    }
  });
});

describe("status options (§3.2)", () => {
  it("booked offers no idea segment (two-step friction); cancelled is terminal", () => {
    expect(statusOptionsFor("idea")).toEqual(["idea", "planned", "booked"]);
    expect(statusOptionsFor("planned")).toEqual(["idea", "planned", "booked"]);
    expect(statusOptionsFor("booked")).toEqual(["planned", "booked"]);
    expect(statusOptionsFor("cancelled")).toEqual(["cancelled"]);
  });
});

describe("prefill + slugs", () => {
  it("day+time prefill seeds the category's primary start (R-itin-14)", () => {
    const state = emptyFormState("activity", { day: "2027-03-02", time: "14:00" });
    expect(state[primaryStartKey("activity")]).toEqual({ date: "2027-03-02", time: "14:00" });
  });

  it("day WITHOUT time does NOT touch details (schedule-fallback leg, §2.4)", () => {
    const state = emptyFormState("activity", { day: "2027-03-02" });
    expect(state[primaryStartKey("activity")]).toEqual({ date: "", time: "" });
  });

  it("slugs are §2.9 kebab", () => {
    expect(addOptionSlug("car_rental")).toBe("car-rental");
    expect(addOptionSlug("place_visit")).toBe("place-visit");
    expect(addOptionSlug("flight")).toBe("flight");
  });
});

describe("deeplinkInputFor (§2.7 mapping)", () => {
  it("flight maps IATA + wall depart date + cabin", () => {
    const state: DetailsFormState = emptyFormState("flight");
    state["origin_iata"] = "SFO";
    state["destination_iata"] = "NRT";
    state["departs_at"] = { date: "2027-03-01", time: "10:00" };
    state["cabin_class"] = "economy";
    expect(deeplinkInputFor("flight", state)).toEqual({
      category: "flight",
      fields: {
        originIata: "SFO",
        destinationIata: "NRT",
        departDate: "2027-03-01",
        cabinClass: "economy",
      },
    });
  });

  it("lodging prefers address, falls back to property name; train passes the composed ISO", () => {
    const lodging = emptyFormState("lodging");
    lodging["property_name"] = "Park Hyatt";
    expect(deeplinkInputFor("lodging", lodging)).toMatchObject({
      fields: { location: "Park Hyatt" },
    });
    lodging["address"] = "3-7-1-2 Nishi-Shinjuku";
    expect(deeplinkInputFor("lodging", lodging)).toMatchObject({
      fields: { location: "3-7-1-2 Nishi-Shinjuku" },
    });

    const train = emptyFormState("train");
    train["origin_station"] = "Tokyo";
    train["departs_at"] = { date: "2027-03-02", time: "09:12" };
    expect(deeplinkInputFor("train", train)).toMatchObject({
      fields: { originStation: "Tokyo", outwardDate: "2027-03-02T09:12:00Z" },
    });
  });

  it("car_rental maps pickup location + pickup/dropoff DATES in the right slots", () => {
    const state = emptyFormState("car_rental");
    state["pickup_location"] = "Kyoto Station";
    state["pickup_at"] = { date: "2027-03-02", time: "10:00" };
    state["dropoff_at"] = { date: "2027-03-05", time: "18:00" };
    // Inverted pickup/dropoff reads would ship Kayak Cars URLs with swapped
    // dates — pinned per-field, not just by shape.
    expect(deeplinkInputFor("car_rental", state)).toEqual({
      category: "car_rental",
      fields: {
        pickupLocation: "Kyoto Station",
        pickupDate: "2027-03-02",
        dropoffDate: "2027-03-05",
      },
    });
  });

  it("moped/restaurant carry no fields (panel renders nothing for them)", () => {
    expect(deeplinkInputFor("moped_rental", emptyFormState("moped_rental"))).toEqual({
      category: "moped_rental",
    });
    expect(deeplinkInputFor("restaurant", emptyFormState("restaurant"))).toEqual({
      category: "restaurant",
    });
  });
});
