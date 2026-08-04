/**
 * Travel-leg model pins (T-7.5 / IT-3 — R-itin-4/5/6). Pure suite: the
 * projection IS the chip's behavior, so these pins are falsifiable —
 * break the ladder and the default-mode pins go red, not a snapshot.
 *
 * The transit-only cases are not edge cases: with the Mapbox token parked
 * they are the shipping configuration.
 */
import type { TravelLeg } from "@gogo/shared";

import {
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  makeTravelLeg,
} from "@/test-utils/itinerary-fixtures";

import {
  formatLegDistance,
  formatLegDuration,
  indexLegsByPair,
  isNoTravelLeg,
  legPairKey,
  pickDefaultMode,
  TRAVEL_MODE_ORDER,
  WALKING_PREFERRED_MAX_SECONDS,
  type LegOption,
} from "./legs-model";

function option(mode: LegOption["mode"], durationSeconds: number): LegOption {
  return { mode, durationSeconds, distanceMeters: 1000, provider: "mapbox" };
}

describe("indexLegsByPair (§2.2 pair keying)", () => {
  it("groups by (from, to) and orders modes walk → drive → cycle → transit", () => {
    const legs: TravelLeg[] = [
      makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "transit"),
      makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "driving"),
      makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "walking"),
      makeTravelLeg(ITEM_B_ID, ITEM_C_ID, "cycling"),
    ];
    const index = indexLegsByPair(legs);
    expect([...index.byPair.keys()]).toHaveLength(2);
    expect(index.byPair.get(legPairKey(ITEM_A_ID, ITEM_B_ID))?.map((o) => o.mode)).toEqual([
      "walking",
      "driving",
      "transit",
    ]);
    expect(index.byPair.get(legPairKey(ITEM_B_ID, ITEM_C_ID))?.map((o: LegOption) => o.mode)).toEqual(["cycling"]);
  });

  it("is DIRECTIONAL — the reverse pair is a different key (R-ib-20)", () => {
    const index = indexLegsByPair([makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "walking")]);
    expect(index.byPair.has(legPairKey(ITEM_A_ID, ITEM_B_ID))).toBe(true);
    // CONTROL: the same items, reversed, must NOT resolve — this is what
    // makes a reorder drop its now-wrong chip instead of showing it backwards.
    expect(index.byPair.has(legPairKey(ITEM_B_ID, ITEM_A_ID))).toBe(false);
  });

  it("carries duration/distance/provider through verbatim", () => {
    const index = indexLegsByPair([
      makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "transit", {
        duration_seconds: 1234,
        distance_meters: 5678,
        provider: "transitous",
      }),
    ]);
    expect(index.byPair.get(legPairKey(ITEM_A_ID, ITEM_B_ID))?.[0]).toEqual({
      mode: "transit",
      durationSeconds: 1234,
      distanceMeters: 5678,
      provider: "transitous",
    });
  });

  it("a duplicate (from, to, mode) keeps the first row (R-ib-22 says it can't happen)", () => {
    const index = indexLegsByPair([
      makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "walking", { duration_seconds: 100 }),
      makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "walking", { duration_seconds: 999 }),
    ]);
    const options = index.byPair.get(legPairKey(ITEM_A_ID, ITEM_B_ID));
    expect(options).toHaveLength(1);
    expect(options?.[0]?.durationSeconds).toBe(100);
  });

  it("no legs → an empty index (R-itin-6: the absent case is data, not an error)", () => {
    expect(indexLegsByPair([]).byPair.size).toBe(0);
  });
});

describe("pickDefaultMode (R-itin-5)", () => {
  it("walking wins at or under 15 minutes", () => {
    expect(
      pickDefaultMode([option("walking", WALKING_PREFERRED_MAX_SECONDS), option("driving", 300)]),
    ).toBe("walking");
  });

  it("one second over the threshold, driving wins", () => {
    expect(
      pickDefaultMode([
        option("walking", WALKING_PREFERRED_MAX_SECONDS + 1),
        option("driving", 300),
      ]),
    ).toBe("driving");
  });

  it("driving wins when there is no walking leg at all", () => {
    expect(pickDefaultMode([option("driving", 900), option("transit", 600)])).toBe("driving");
  });

  it("transit-only (the parked-Mapbox reality) shows transit, not nothing", () => {
    expect(pickDefaultMode([option("transit", 1080)])).toBe("transit");
  });

  it("cycling-only shows cycling", () => {
    expect(pickDefaultMode([option("cycling", 800)])).toBe("cycling");
  });

  it("a long walk with nothing else still shows, rather than hiding a real leg", () => {
    expect(pickDefaultMode([option("walking", 3600)])).toBe("walking");
  });

  it("transit outranks a long walk when both exist", () => {
    expect(pickDefaultMode([option("walking", 3600), option("transit", 900)])).toBe("transit");
  });

  it("R-itin-5 itself: a long walk with driving present picks DRIVING, not cycling", () => {
    // The spec case, and the one that arrives the day the Mapbox token is
    // unparked. Without this, promoting `cycling` above the `driving`
    // early-return breaks R-itin-5 and every one of the 882 tests stays green
    // (round 2, probe P2) — no fixture anywhere paired cycling with another
    // mode.
    expect(
      pickDefaultMode([option("walking", 1200), option("driving", 480), option("cycling", 900)]),
    ).toBe("driving");
  });

  it("with driving absent, cycling beats a long walk", () => {
    expect(pickDefaultMode([option("cycling", 600), option("walking", 2400)])).toBe("cycling");
  });

  it("with driving absent, transit outranks cycling", () => {
    expect(pickDefaultMode([option("transit", 2700), option("cycling", 600)])).toBe("transit");
  });

  it("the tail order is exactly transit → cycling → long-walking", () => {
    // Pins the ORDER, not just membership: any permutation of the tail
    // changes at least one of these.
    const all = [option("walking", 3600), option("cycling", 1800), option("transit", 2700)];
    expect(pickDefaultMode(all)).toBe("transit");
    expect(pickDefaultMode([option("walking", 3600), option("cycling", 1800)])).toBe("cycling");
    expect(pickDefaultMode([option("walking", 3600)])).toBe("walking");
  });

  it("no options → null (the caller emits no chip)", () => {
    expect(pickDefaultMode([])).toBeNull();
  });

  it("every mode in the shared enum is reachable as a default", () => {
    for (const mode of TRAVEL_MODE_ORDER) {
      expect(pickDefaultMode([option(mode, 120)])).toBe(mode);
    }
  });
});

describe("formatLegDuration / formatLegDistance", () => {
  it("rounds to whole minutes; only an exactly-zero leg reads 0 min", () => {
    // 0 is the server's deliberate same-place value (`provider: "same_place"`,
    // every mode 0s/0m), not missing data — reporting it as a minute of
    // walking misdescribes the wire. A sub-minute NONZERO leg still floors to
    // "1 min": it took some time.
    expect(formatLegDuration(0)).toBe("0 min");
    expect(formatLegDuration(1)).toBe("1 min");
    expect(formatLegDuration(29)).toBe("1 min");
    expect(formatLegDuration(1080)).toBe("18 min");
    expect(formatLegDuration(1109)).toBe("18 min");
    expect(formatLegDuration(1111)).toBe("19 min");
  });

  it("splits hours off above 60 minutes", () => {
    expect(formatLegDuration(3540)).toBe("59 min");
    expect(formatLegDuration(3600)).toBe("1 h");
    expect(formatLegDuration(3900)).toBe("1 h 5 min");
    expect(formatLegDuration(7200)).toBe("2 h");
  });

  it("metres under a kilometre, one decimal above it", () => {
    expect(formatLegDistance(0)).toBe("0 m");
    expect(formatLegDistance(450)).toBe("450 m");
    expect(formatLegDistance(999)).toBe("999 m");
    expect(formatLegDistance(1000)).toBe("1.0 km");
    expect(formatLegDistance(3450)).toBe("3.5 km");
  });
});

describe("isNoTravelLeg — the server's same-place legs (R-itin-6)", () => {
  const zero = (mode: LegOption["mode"]): LegOption => ({
    mode,
    durationSeconds: 0,
    distanceMeters: 0,
    provider: "same_place",
  });

  it("all-zero across every mode is 'no travel'", () => {
    expect(isNoTravelLeg([zero("walking"), zero("driving"), zero("cycling"), zero("transit")])).toBe(
      true,
    );
  });

  it("CONTROL: one real mode makes it a genuine leg", () => {
    expect(isNoTravelLeg([zero("walking"), option("transit", 900)])).toBe(false);
  });

  it("zero duration but real distance is still a leg (not a same-place row)", () => {
    expect(
      isNoTravelLeg([{ mode: "walking", durationSeconds: 0, distanceMeters: 40, provider: "mapbox" }]),
    ).toBe(false);
  });

  it("an empty option list is not 'no travel' — it is no leg at all", () => {
    expect(isNoTravelLeg([])).toBe(false);
  });
});
