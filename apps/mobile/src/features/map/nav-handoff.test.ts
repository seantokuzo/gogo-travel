/**
 * Nav handoff URL (T-8.3 / MAP-2 — R-map-8). Load-bearing: the exact Maps
 * URLs API shape (the research-verified format — the T-7.5 directions.ts
 * ruling) with COORDINATES as the destination, comma encoded, negatives
 * intact. A drifted format opens Maps on a garbage query on every navigate
 * tap.
 */
import { navHandoffUrlFor } from "./nav-handoff";

describe("navHandoffUrlFor", () => {
  it("builds the documented dir?api=1 URL with lat,lng as the destination", () => {
    expect(navHandoffUrlFor({ lat: 35.0116, lng: 135.7681 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=35.0116%2C135.7681",
    );
  });

  it("keeps hemisphere signs (southern/western coordinates)", () => {
    expect(navHandoffUrlFor({ lat: -33.8688, lng: -70.6693 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=-33.8688%2C-70.6693",
    );
  });

  // B-7 part 3: a coordinate-less custom place — null, never a URL pointing
  // at "null,null". Falsification: drop either null check and this returns
  // a string containing the literal text "null".
  it("null for a coordinate-less place — never a 'null,null' URL", () => {
    expect(navHandoffUrlFor({ lat: null, lng: null })).toBeNull();
  });

  it("null on a HALF-null pair too (defensive — the pair invariant should make this unreachable)", () => {
    expect(navHandoffUrlFor({ lat: null, lng: 135.7681 })).toBeNull();
    expect(navHandoffUrlFor({ lat: 35.0116, lng: null })).toBeNull();
  });
});
