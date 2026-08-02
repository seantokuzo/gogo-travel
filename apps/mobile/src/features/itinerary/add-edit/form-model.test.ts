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

describe("money (Law #2 — integer cents, string math)", () => {
  it("parses plain amounts into exact cents", () => {
    expect(parseMoneyToCents("120")).toEqual({ ok: true, cents: 12000 });
    expect(parseMoneyToCents("89.99")).toEqual({ ok: true, cents: 8999 });
    expect(parseMoneyToCents("89,9")).toEqual({ ok: true, cents: 8990 });
    expect(parseMoneyToCents("0.05")).toEqual({ ok: true, cents: 5 });
    // The classic float trap: 0.1 + 0.2 territory stays exact via strings.
    expect(parseMoneyToCents("0.29")).toEqual({ ok: true, cents: 29 });
  });

  it("rejects junk (negatives, letters, three decimals, thousands separators)", () => {
    for (const bad of ["-5", "abc", "1.234", "1,234.56", "12.", ""]) {
      expect(parseMoneyToCents(bad).ok).toBe(false);
    }
  });

  it("centsToMoneyText round-trips", () => {
    expect(centsToMoneyText(12000)).toBe("120");
    expect(centsToMoneyText(8999)).toBe("89.99");
    expect(centsToMoneyText(5)).toBe("0.05");
    for (const cents of [12000, 8999, 5, 100, 1]) {
      const parsed = parseMoneyToCents(centsToMoneyText(cents));
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

  it("moped/restaurant carry no fields (panel renders nothing for them)", () => {
    expect(deeplinkInputFor("moped_rental", emptyFormState("moped_rental"))).toEqual({
      category: "moped_rental",
    });
    expect(deeplinkInputFor("restaurant", emptyFormState("restaurant"))).toEqual({
      category: "restaurant",
    });
  });
});
