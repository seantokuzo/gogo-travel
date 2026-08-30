#!/usr/bin/env node
/**
 * QA-only destination seed (device QA 2026-08-29).
 *
 * WHY THIS EXISTS: a fresh install cannot create its first trip. Trip
 * creation requires a spine-backed destination pick (`new.tsx` — "Search and
 * pick a destination"), but the `places` spine is populated by ingest that is
 * triggered by trip create / destination change, and by a search-miss trigger
 * that throttles per GEOGRAPHIC CELL — which a text-only query can never
 * anchor. No places -> no trip -> no ingest -> no places. See B-7.
 *
 * These rows are `source = 'custom'`, NOT `overture`/`fsq_os`: they are
 * hand-entered QA fixtures and must never be mistaken for spine data.
 *
 * The schema forbids tagging them: `places_custom_source_id_ck` enforces
 * `(source = 'custom') = (source_id IS NULL)`, so a custom row CANNOT carry a
 * marker in source_id. --remove therefore matches on source='custom', the
 * exact name list below, AND `created_by` in the SAME owner selection the
 * insert path uses (--user <email>, else every user) — never other accounts'
 * rows. Caveat that follows: if a resolved owner hand-created a custom place
 * named exactly 'Tokyo', --remove would delete it too.
 *
 * Deletes are guarded: --remove prints the target DB host (host only — never
 * the URL or credentials) and refuses to run without an explicit --force.
 *
 *   node scripts/seed-qa-places.mjs                    # insert (idempotent)
 *   node scripts/seed-qa-places.mjs --remove --force   # delete qa-seed rows
 *
 * Requires DATABASE_URL. Run via `node --env-file-if-exists=apps/server/.env`.
 * This is a DEVELOPMENT convenience — it is not wired into any app code path,
 * migration, or CI job, and it must never be run against production data.
 */
import { createRequire } from "node:module";

// pnpm does not hoist to the workspace root, so resolve `postgres` from the
// server workspace that actually depends on it rather than from this file.
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const postgres = require("postgres");

const NAMES = () => PLACES.map(([name]) => name);

/** Well-known destinations — name, lat, lng, category. */
const PLACES = [
  ["Tokyo", 35.6762, 139.6503, "locality"],
  ["Kyoto", 35.0116, 135.7681, "locality"],
  ["Osaka", 34.6937, 135.5023, "locality"],
  ["Lisbon", 38.7223, -9.1393, "locality"],
  ["Porto", 41.1579, -8.6291, "locality"],
  ["Barcelona", 41.3874, 2.1686, "locality"],
  ["Madrid", 40.4168, -3.7038, "locality"],
  ["Paris", 48.8566, 2.3522, "locality"],
  ["Rome", 41.9028, 12.4964, "locality"],
  ["Amsterdam", 52.3676, 4.9041, "locality"],
  ["London", 51.5072, -0.1276, "locality"],
  ["New York", 40.7128, -74.006, "locality"],
  ["San Francisco", 37.7749, -122.4194, "locality"],
  ["Mexico City", 19.4326, -99.1332, "locality"],
  ["Reykjavik", 64.1466, -21.9426, "locality"],
  ["Bangkok", 13.7563, 100.5018, "locality"],
  ["Hanoi", 21.0278, 105.8342, "locality"],
  ["Seoul", 37.5665, 126.978, "locality"],
  ["Sydney", -33.8688, 151.2093, "locality"],
  ["Cape Town", -33.9249, 18.4241, "locality"],
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — run with --env-file-if-exists=apps/server/.env");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

/**
 * `places_custom_created_by_ck` requires an owner for custom rows, and search
 * only returns a custom place to its creator (search-query.ts:158:
 * `source <> 'custom' or created_by = userId`). So rows are seeded to real
 * users — pass --user <email> for a specific one, else every user. --remove
 * resolves owners through this SAME selection so it can only delete rows the
 * insert path could have created.
 */
async function resolveOwners() {
  const emailArg = process.argv.indexOf("--user");
  return emailArg !== -1 && process.argv[emailArg + 1]
    ? await sql`select id, email from users where email = ${process.argv[emailArg + 1]}`
    : await sql`select id, email from users order by created_at asc`;
}

try {
  if (process.argv.includes("--remove")) {
    // Deletes are destructive and DATABASE_URL alone decides WHICH database
    // eats them — surface the target host (host only, never the URL or its
    // credentials) and refuse to proceed without an explicit --force.
    console.warn(`--remove targets database host: ${new URL(url).hostname}`);
    if (!process.argv.includes("--force")) {
      console.error(
        "refusing to delete without --force — check the host above, then re-run with --force",
      );
      process.exitCode = 1;
    } else {
      const owners = await resolveOwners();
      if (owners.length === 0) throw new Error("no matching user — nothing to remove");
      const removed = await sql`
        delete from places where source = 'custom' and name = any(${NAMES()})
          and created_by = any(${owners.map((o) => o.id)}) returning id`;
      console.warn(`removed ${removed.length} qa-seed place(s)`);
    }
  } else {
    const owners = await resolveOwners();
    if (owners.length === 0) throw new Error("no user to own the seeded places — sign in first");

    // Seed for EVERY user by default: a custom place is only visible to its
    // creator, so seeding one account leaves the other with an empty search
    // and the same dead end. Each user gets their own copy of the set.
    let inserted = 0;
    for (const owner of owners) {
      for (const [name, lat, lng, category] of PLACES) {
        // Idempotent: skip anything already seeded so re-running is safe.
        const [existing] = await sql`
          select id from places where source = 'custom' and name = ${name}
            and created_by = ${owner.id} limit 1`;
        if (existing) continue;
        await sql`
          insert into places (source, source_id, name, lat, lng, category, created_by)
          values ('custom', null, ${name}, ${lat}, ${lng}, ${category}, ${owner.id})`;
        inserted += 1;
      }
      console.warn(`seeded for ${owner.email}`);
    }
    const [{ n }] =
      await sql`select count(*)::int as n from places where source = 'custom' and name = any(${NAMES()})`;
    console.warn(`inserted ${inserted} new; ${n} qa-seed place(s) total`);
  }
} catch (err) {
  console.error("seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
