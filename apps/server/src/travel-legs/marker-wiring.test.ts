/**
 * Live dirty-day marker composition pin (T-7.3 Wave-2 integration): the prod
 * composition root (`src/index.ts`) must hand `buildTravelLegs`'s LIVE
 * marker to EVERY mutation surface whose writes move calendar placement —
 * bookings (T-7.1) and itinerary (T-7.2). Both wire builders accept an
 * OPTIONAL marker and fall back to the dormant no-op
 * (`createDirtyDayMarker()` — dirty-days.ts), so reverting the handoff
 * compiles clean, every suite stays green, and item/booking mutations'
 * marks silently drop: legs stop recomputing with zero errors.
 *
 * index.ts is the un-importable composition root (it boots the server), so
 * this pin is a static source scan — the only-writer.test.ts pattern. The
 * behavioral half (item create → marks arrive at the live worker → real
 * recompute drains) is the WIRING ASSERTION test in `routes.db.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * `buildXxxDeps(travelLegs.marker)` — whitespace/trailing-comma tolerant so
 * a formatter wrap can't fake a regression; anything else (bare call, other
 * argument) is NOT a live handoff.
 */
const liveHandoff = (builder: string) =>
  new RegExp(String.raw`${builder}\(\s*travelLegs\.marker\s*,?\s*\)`);

describe("live marker composition pin (index.ts → wire builders)", () => {
  const indexSource = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");

  it("scan-drift guard: index.ts is the real composition root", () => {
    // If the path or file shape drifts, fail HERE before the pins can pass
    // over the wrong file.
    expect(indexSource).toContain("buildTravelLegs(");
    expect(indexSource).toContain("createApp(");
  });

  it("pattern distinguishes the live handoff from the dormant form (positive control)", () => {
    const pattern = liveHandoff("buildItineraryDeps");
    expect(pattern.test("buildItineraryDeps(travelLegs.marker)")).toBe(true);
    expect(pattern.test("buildItineraryDeps(\n      travelLegs.marker,\n    )")).toBe(true);
    // The regression this file exists to catch: the bare (dormant) call.
    expect(pattern.test("buildItineraryDeps()")).toBe(false);
    expect(pattern.test("buildItineraryDeps(createDirtyDayMarker())")).toBe(false);
  });

  it("index.ts hands the LIVE worker marker to the bookings deps (T-7.1 surface)", () => {
    expect(indexSource).toMatch(liveHandoff("buildBookingsDeps"));
  });

  it("index.ts hands the LIVE worker marker to the itinerary deps (T-7.2 surface)", () => {
    expect(indexSource).toMatch(liveHandoff("buildItineraryDeps"));
  });
});
