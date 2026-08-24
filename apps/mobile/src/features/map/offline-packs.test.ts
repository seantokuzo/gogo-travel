/**
 * Pure pack machine (T-8.5 / MAP-5 — map spec §2.5, R-map-18/20/21/22).
 * Load-bearing pins:
 *  - the TileRegion envelope IS the shared region grid's 3×3 destination
 *    cells (§2.5 "one definition of the destination area") — including the
 *    antimeridian unwrap and the pole drop;
 *  - ready → stale on style OR region drift, never on a matching record;
 *  - the R-map-18 auto-download arm fires ONLY for active + no-pack (stale
 *    and failed are manual arms — §2.5 trigger 3 / R-map-21);
 *  - ceiling purge eligibility: past trips only, oldest-first, unknown trips
 *    NEVER purged (R-map-20's "never user-visible as a failure" depends on
 *    not deleting live packs);
 *  - pill precedence: downloading > failed(retry) > offline notice > hidden.
 */
import { regionCellsForDestination } from "@gogo/shared";

import {
  annotatedPackState,
  downloadProgressPercent,
  estimatePackSizeBytes,
  estimatePackTileCount,
  formatPackSize,
  isDownloadComplete,
  isUsableDestination,
  isWifiState,
  offlinePillModel,
  packBoundsFor,
  packNameFor,
  packRegionKeyFor,
  planCeilingPurge,
  shouldAutoDownloadPack,
  tripIdFromPackName,
  type OfflinePackAnnotation,
} from "./offline-packs";

const KYOTO = { lat: 35.0116, lng: 135.7681 };

describe("pack identity", () => {
  it("packNameFor/tripIdFromPackName round-trip; foreign packs read null", () => {
    expect(packNameFor("abc")).toBe("trip-abc");
    expect(tripIdFromPackName("trip-abc")).toBe("abc");
    expect(tripIdFromPackName("styleport-cache")).toBeNull();
  });
});

describe("packBoundsFor — §2.5 region envelope", () => {
  it("is the exact 3×3 grid-cell envelope, [NE, SW] position order", () => {
    // Kyoto: center cell [35.0, 35.5]×[135.5, 136.0]; ±0.5° neighbors.
    expect(packBoundsFor(KYOTO.lat, KYOTO.lng)).toEqual([
      [136.5, 36.0],
      [135.0, 34.5],
    ]);
  });

  it("covers every regionCellsForDestination cell (the shared-grid contract)", () => {
    const [[neLng, neLat], [swLng, swLat]] = packBoundsFor(KYOTO.lat, KYOTO.lng);
    for (const cell of regionCellsForDestination(KYOTO.lat, KYOTO.lng)) {
      expect(cell.minLat).toBeGreaterThanOrEqual(swLat);
      expect(cell.maxLat).toBeLessThanOrEqual(neLat);
      expect(cell.minLng).toBeGreaterThanOrEqual(swLng);
      expect(cell.maxLng).toBeLessThanOrEqual(neLng);
    }
  });

  it("unwraps antimeridian neighbors into one contiguous box (lng past 180)", () => {
    // Center cell [179.5, 180.0); the +1 neighbor wraps to [-180, -179.5) and
    // must come back as [180, 180.5] — never a world-spanning envelope.
    expect(packBoundsFor(10.2, 179.9)).toEqual([
      [180.5, 11.0],
      [179.0, 9.5],
    ]);
  });

  it("clamps at the pole — dropped neighbors don't extend the envelope", () => {
    const [[, neLat], [, swLat]] = packBoundsFor(89.9, 10.0);
    expect(neLat).toBe(90.0);
    expect(swLat).toBe(89.0);
  });
});

describe("annotatedPackState — ready/stale derivation", () => {
  const annotation: OfflinePackAnnotation = {
    tripId: "t1",
    styleUrl: "mapbox://styles/mapbox/light-v11",
    regionKey: packRegionKeyFor(KYOTO.lat, KYOTO.lng),
    completedAt: "2026-08-18T00:00:00.000Z",
    sizeBytes: 12_000_000,
  };
  const current = { styleUrl: annotation.styleUrl, regionKey: annotation.regionKey };

  it("no annotation ⇒ none", () => {
    expect(annotatedPackState(undefined, current)).toEqual({ phase: "none" });
  });

  it("matching style + region ⇒ ready with the recorded size/date", () => {
    expect(annotatedPackState(annotation, current)).toEqual({
      phase: "ready",
      sizeBytes: 12_000_000,
      completedAt: "2026-08-18T00:00:00.000Z",
    });
  });

  it("style drift ⇒ stale (§2.5 ready → stale)", () => {
    expect(
      annotatedPackState(annotation, { ...current, styleUrl: "mapbox://styles/mapbox/dark-v11" })
        .phase,
    ).toBe("stale");
  });

  it("destination/region drift ⇒ stale", () => {
    expect(
      annotatedPackState(annotation, { ...current, regionKey: packRegionKeyFor(48.85, 2.35) })
        .phase,
    ).toBe("stale");
  });
});

describe("isUsableDestination — the degrade-arm guard", () => {
  it("accepts real coordinates, rejects NaN/out-of-range (region grid throws on them)", () => {
    expect(isUsableDestination(KYOTO.lat, KYOTO.lng)).toBe(true);
    expect(isUsableDestination(-90, 180)).toBe(true);
    expect(isUsableDestination(Number.NaN, 135)).toBe(false);
    expect(isUsableDestination(35, Number.NaN)).toBe(false);
    expect(isUsableDestination(91, 0)).toBe(false);
    expect(isUsableDestination(0, 181)).toBe(false);
  });
});

describe("shouldAutoDownloadPack — R-map-18 arm", () => {
  it("fires ONLY for active + none", () => {
    expect(shouldAutoDownloadPack({ tripStatus: "active", phase: "none" })).toBe(true);
    for (const phase of ["downloading", "ready", "stale", "failed"] as const) {
      expect(shouldAutoDownloadPack({ tripStatus: "active", phase })).toBe(false);
    }
    for (const tripStatus of ["planning", "past"] as const) {
      expect(shouldAutoDownloadPack({ tripStatus, phase: "none" })).toBe(false);
    }
  });
});

describe("isWifiState — the R-map-18 wifi gate", () => {
  it("requires WIFI type AND a confirmed connection", () => {
    expect(isWifiState({ type: "WIFI", isConnected: true })).toBe(true);
    expect(isWifiState({ type: "WIFI", isConnected: false })).toBe(false);
    expect(isWifiState({ type: "WIFI" })).toBe(false);
    expect(isWifiState({ type: "CELLULAR", isConnected: true })).toBe(false);
    expect(isWifiState({ type: "NONE", isConnected: false })).toBe(false);
    expect(isWifiState({})).toBe(false);
  });
});

describe("progress helpers", () => {
  it("percent clamps + rounds; completion is the SDK's percentage contract", () => {
    expect(downloadProgressPercent({ percentage: 41.7 })).toBe(42);
    expect(downloadProgressPercent({ percentage: -5 })).toBe(0);
    expect(downloadProgressPercent({ percentage: 250 })).toBe(100);
    expect(isDownloadComplete({ percentage: 99.9 })).toBe(false);
    expect(isDownloadComplete({ percentage: 100 })).toBe(true);
  });
});

describe("size estimate (display-only — no SDK estimate API in 10.3.5)", () => {
  it("is deterministic and grows with zoom depth", () => {
    const bounds = packBoundsFor(KYOTO.lat, KYOTO.lng);
    const shallow = estimatePackTileCount(bounds, 6, 10);
    const full = estimatePackTileCount(bounds, 6, 15);
    expect(shallow).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(shallow);
    expect(estimatePackSizeBytes(bounds)).toBeGreaterThan(0);
  });

  it("counts a single-zoom box exactly (slippy tile math)", () => {
    // z6 world = 64×64; the Kyoto envelope spans lng 135→136.5 (x 56..56)
    // and lat 34.5→36 — one column, one row.
    const bounds = packBoundsFor(KYOTO.lat, KYOTO.lng);
    expect(estimatePackTileCount(bounds, 6, 6)).toBe(1);
  });

  it("counts an ANTIMERIDIAN envelope as its real span, never a world wrap", () => {
    // The 179.9°E envelope (lng 179→180.5, lat 9.5→11) is columns 63..64 at
    // z6 — two columns, one row. A cap/unwrap regression here is user-visible
    // as an absurd "~size" in the cellular ConfirmDialog (the copy a paid
    // download decision reads).
    expect(estimatePackTileCount(packBoundsFor(10.2, 179.9), 6, 6)).toBe(2);
  });

  it("formats bytes for the management UI", () => {
    expect(formatPackSize(12_345_678)).toBe("12 MB");
    expect(formatPackSize(850_000)).toBe("850 KB");
    expect(formatPackSize(100)).toBe("1 KB");
  });
});

describe("planCeilingPurge — R-map-20", () => {
  const candidate = (
    name: string,
    tripStatus: "planning" | "active" | "past" | undefined,
    completedAt: string | null,
  ) => ({ name, tripStatus, completedAt });

  it("no purge while the new download stays at or under the threshold", () => {
    expect(
      planCeilingPurge(698, [candidate("trip-a", "past", "2026-01-01T00:00:00.000Z")], 700),
    ).toEqual([]);
  });

  it("purges past trips oldest-first, exactly enough to clear the threshold", () => {
    const plan = planCeilingPurge(
      701,
      [
        candidate("trip-new", "past", "2026-06-01T00:00:00.000Z"),
        candidate("trip-old", "past", "2026-01-01T00:00:00.000Z"),
        candidate("trip-mid", "past", "2026-03-01T00:00:00.000Z"),
      ],
      700,
    );
    expect(plan).toEqual(["trip-old", "trip-mid"]);
  });

  it("unannotated (null completedAt) past packs purge first; unknown/active trips are NEVER eligible", () => {
    const plan = planCeilingPurge(
      703,
      [
        candidate("trip-active", "active", "2025-01-01T00:00:00.000Z"),
        candidate("trip-unknown", undefined, null),
        candidate("trip-unstamped", "past", null),
        candidate("trip-old", "past", "2026-01-01T00:00:00.000Z"),
      ],
      700,
    );
    // Excess is 4 but only two packs are eligible — the plan returns what it
    // can (the download still proceeds; the ceiling never surfaces as failure).
    expect(plan).toEqual(["trip-unstamped", "trip-old"]);
  });
});

describe("offlinePillModel — precedence (R-map-18/21/22)", () => {
  const ready = {
    phase: "ready",
    sizeBytes: 1,
    completedAt: "2026-08-18T00:00:00.000Z",
  } as const;

  it("downloading shows progress regardless of the offline signal", () => {
    expect(offlinePillModel({ phase: "downloading", progress: 37 }, true)).toEqual({
      kind: "progress",
      label: "Saving map… 37%",
    });
  });

  it("failed is a retry pill — online or offline (R-map-21)", () => {
    expect(offlinePillModel({ phase: "failed", message: "x" }, false).kind).toBe("retry");
    expect(offlinePillModel({ phase: "failed", message: "x" }, true).kind).toBe("retry");
  });

  it("offline states whether a saved map is in play (R-map-22)", () => {
    expect(offlinePillModel(ready, true)).toEqual({
      kind: "notice",
      label: "Offline — using saved map",
    });
    expect(offlinePillModel({ ...ready, phase: "stale" }, true).kind).toBe("notice");
    expect(offlinePillModel({ phase: "none" }, true)).toEqual({
      kind: "notice",
      label: "Offline — map may be limited",
    });
  });

  it("online with a settled pack hides — the pill never nags (R-map-21 spirit)", () => {
    expect(offlinePillModel({ phase: "none" }, false).kind).toBe("hidden");
    expect(offlinePillModel(ready, false).kind).toBe("hidden");
    expect(offlinePillModel({ ...ready, phase: "stale" }, false).kind).toBe("hidden");
  });
});
