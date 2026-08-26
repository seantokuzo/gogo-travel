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
        if (field.kind === "datetime") state[field.key] = { date: "2027-03-02", time: "14:30" };
        else if (field.kind === "int") state[field.key] = "3";
        else if (field.kind === "url") state[field.key] = "https://example.com/x";
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

  it("composeLocalDateTime round-trips through stateFromDetails (wall slicing)", () => {
    expect(composeLocalDateTime("2027-03-02", "14:30")).toBe("2027-03-02T14:30:00Z");
    const state = emptyFormState("activity");
    state["starts_at"] = { date: "2027-03-02", time: "14:30" };
    state["venue_name"] = "TeamLab";
    state["ticket_count"] = "2";
    const built = buildDetails("activity", state);
    expect(built.details).not.toBeNull();
    const back = stateFromDetails(built.details!);
    expect(back["starts_at"]).toEqual({ date: "2027-03-02", time: "14:30" });
    expect(back["venue_name"]).toBe("TeamLab");
    expect(back["ticket_count"]).toBe("2");
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
