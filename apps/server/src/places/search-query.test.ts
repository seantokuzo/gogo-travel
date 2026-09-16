/**
 * Unit pins for the near-search prefilter box edges (T-6.5 round-1 #7):
 * the ±180 no-wrap clamp and the deliberate polar-sliver exclusion.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tierNameFoldExpr } from "../db/schema/places.js";
import { nearPrefilterBox } from "./search-query.js";

describe("nearPrefilterBox", () => {
  it("clamps at ±180 instead of wrapping (v1 no-antimeridian posture)", () => {
    const box = nearPrefilterBox(10, 179.9, 50_000);
    expect(box.maxLng).toBe(180); // clamped, never wrapped onto -180
    expect(box.minLng).toBeLessThan(179.9);
    expect(box.minLng).toBeGreaterThan(179); // ~0.46° half-width at lat 10
    // The far side of the date line is deliberately lost (comment contract).
    expect(box.minLng).toBeLessThanOrEqual(box.maxLng);
  });

  it("clamps at the poles on the lat axis", () => {
    const box = nearPrefilterBox(89.9, 0, 50_000);
    expect(box.maxLat).toBe(90);
    expect(box.minLat).toBeCloseTo(89.9 - 50_000 / 111_320, 6);
  });

  it("above |lat| ≈ 89.43° the cos-clamp UNDER-covers by design (polar sliver excluded)", () => {
    const lat = 89.9; // cos ≈ 0.0017 — well under the 0.01 clamp
    const box = nearPrefilterBox(lat, 0, 50_000);
    const clampedHalf = 50_000 / (111_320 * 0.01); // ≈ 44.91°
    const trueHalf = 50_000 / (111_320 * Math.cos((lat * Math.PI) / 180)); // ≈ 257°
    expect(box.maxLng).toBeCloseTo(clampedHalf, 6);
    expect(box.maxLng).toBeLessThan(trueHalf); // narrower than the true circle
  });

  it("mid-latitude boxes over-cover symmetrically (residual trims the corners)", () => {
    const box = nearPrefilterBox(38.7, -9.14, 2_000);
    expect(box.maxLat - 38.7).toBeCloseTo(38.7 - box.minLat, 12);
    expect(box.maxLng - -9.14).toBeCloseTo(-9.14 - box.minLng, 12);
    // Lng half-width exceeds lat half-width by 1/cos(lat).
    expect(box.maxLng - -9.14).toBeGreaterThan(box.maxLat - 38.7);
  });
});

/**
 * Review R1 B1 (blocking) "cheaper belt, no DB" suggestion: a DB-free unit
 * pin comparing `tierNameFoldExpr`'s EMITTED SQL text to migration 0006's
 * index-expression text byte-for-byte, so a drift in the shared fold
 * function is caught without a container. `dialect.sqlToQuery(expr,
 * "indexes")` is the same rendering path drizzle-kit itself uses to emit a
 * CREATE INDEX expression — verified live: passing the fold applied to a
 * raw `"name"` SQL fragment and to the real `places.name` column produce
 * IDENTICAL text via this invoke-source, matching the migration exactly.
 *
 * Falsification: drift the combining-mark range in `tierNameFoldExpr`
 * (`db/schema/places.ts`) by one codepoint (U+036F → U+036E) — this test
 * goes RED because the emitted text no longer appears in the migration
 * file (the migration itself is untouched by the mutation, so the two
 * sides diverge). Also reds if the fold's `normalize()`/combining-strip is
 * dropped entirely (review R1 B2's mutation).
 */
describe("tierNameFoldExpr / migration 0006 parity (DB-free)", () => {
  it("the fold expression's emitted SQL text is byte-identical to migration 0006's index expression", () => {
    const dialect = new PgDialect();
    const exprText = dialect.sqlToQuery(tierNameFoldExpr(sql`"name"`), "indexes").sql;

    const migrationPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0006_destination_tier_name_fold_idx.sql",
    );
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain(exprText);
  });
});
