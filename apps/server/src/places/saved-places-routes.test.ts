/**
 * Unit pins for the saved-places constraint walkers (T-8.1 / PL-4 — the
 * `fkViolationTable` / `isPlaceFkViolation` driver-trap precedent), plus
 * live-through-the-router pins for the two arms no container test can
 * reach deterministically (PR #21 r1 A1/A3): the POST 23503→404 catch arm
 * and the PATCH-note post-update race arm, driven through the REAL router
 * on a scripted fake `DbClient` via the `SavedPlacesRouterDeps` seam.
 *
 * The walkers are the one spot where the PROD driver's error shape differs
 * from the TEST driver's: postgres-js (testcontainers) says
 * `constraint_name`, pg-protocol's DatabaseError (Neon serverless) says
 * `constraint`. No container-backed test can produce the prod shape — so it
 * is pinned here synthetically, or the 409/404 mapping silently degrades to
 * a 500 in production only. The router-level pins below anchor the ARMS
 * (not just the walkers): fixtures alone self-reference the constant, so a
 * dead-coded catch arm — or a constant drift — stayed green until these.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { TripMemberRole } from "@gogo/shared/enums";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { RequestVars } from "../http/errors.js";
import { expectIndistinguishable404s } from "../http/idor-404.test-util.js";
import type { PlaceRow, SavedPlaceRow } from "./serialize.js";
import {
  createSavedPlacesRouter,
  isSavedPlaceDuplicate,
  isSavedPlacePlaceFkViolation,
  SAVED_PLACES_PLACE_FK,
  SAVED_PLACES_TRIP_PLACE_UQ,
} from "./saved-places-routes.js";

/** An Error carrying arbitrary protocol fields (both drivers subclass Error). */
function driverError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("db error"), fields);
}

describe("isSavedPlaceDuplicate (23505 → the R-places-16 409)", () => {
  it("reads pg-protocol DatabaseError's `constraint` — the PROD (Neon serverless) shape", () => {
    expect(
      isSavedPlaceDuplicate(driverError({ code: "23505", constraint: SAVED_PLACES_TRIP_PLACE_UQ })),
    ).toBe(true);
  });

  it("reads postgres-js's `constraint_name` — the TEST driver shape — and walks a cause chain", () => {
    const inner = driverError({ code: "23505", constraint_name: SAVED_PLACES_TRIP_PLACE_UQ });
    expect(isSavedPlaceDuplicate(new Error("Failed query", { cause: inner }))).toBe(true);
  });

  it("is constraint-PRECISE: another unique violation stays loud (false)", () => {
    expect(
      isSavedPlaceDuplicate(driverError({ code: "23505", constraint_name: "some_other_uq" })),
    ).toBe(false);
    // A 23505 with NEITHER field is not this constraint either.
    expect(isSavedPlaceDuplicate(driverError({ code: "23505" }))).toBe(false);
  });

  it("ignores other SQLSTATEs and non-Errors", () => {
    expect(
      isSavedPlaceDuplicate(
        driverError({ code: "23503", constraint_name: SAVED_PLACES_TRIP_PLACE_UQ }),
      ),
    ).toBe(false);
    expect(isSavedPlaceDuplicate("nope")).toBe(false);
    expect(isSavedPlaceDuplicate(undefined)).toBe(false);
  });
});

describe("isSavedPlacePlaceFkViolation (23503 race residue → the canonical 404)", () => {
  it("accepts BOTH driver shapes for the place FK", () => {
    expect(
      isSavedPlacePlaceFkViolation(
        driverError({ code: "23503", constraint: SAVED_PLACES_PLACE_FK }),
      ),
    ).toBe(true);
    expect(
      isSavedPlacePlaceFkViolation(
        driverError({ code: "23503", constraint_name: SAVED_PLACES_PLACE_FK }),
      ),
    ).toBe(true);
  });

  it("walks a Drizzle cause chain", () => {
    const inner = driverError({ code: "23503", constraint_name: SAVED_PLACES_PLACE_FK });
    expect(isSavedPlacePlaceFkViolation(new Error("Failed query", { cause: inner }))).toBe(true);
  });

  it("is constraint-PRECISE: the gate-proven trip FK stays loud (false)", () => {
    expect(
      isSavedPlacePlaceFkViolation(
        driverError({ code: "23503", constraint_name: "saved_places_trip_id_trips_id_fk" }),
      ),
    ).toBe(false);
    expect(isSavedPlacePlaceFkViolation(driverError({ code: "23505" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Router-level arm pins (PR #21 r1 A1/A3) — the real router + middleware
// chain over a scripted fake DbClient. These bite where the walker fixtures
// cannot: dead-coding the catch arm, or reverting the PATCH race fold to a
// 500, goes RED here while every fixture pin stays green.
// ---------------------------------------------------------------------------

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const SAVED_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const FIXTURE_NOW = new Date("2026-08-08T00:00:00Z");

const spinePlaceRow: PlaceRow = {
  id: PLACE_ID,
  source: "overture",
  sourceId: "overture-fixture",
  name: "Fixture Cafe",
  lat: "38.691600",
  lng: "-9.216000",
  category: null,
  wikiRef: null,
  createdBy: null,
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

const savedPlaceRow: SavedPlaceRow = {
  id: SAVED_ID,
  tripId: TRIP_ID,
  placeId: PLACE_ID,
  note: "window seat",
  createdBy: USER_ID,
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

interface FakeDbScript {
  /** Role the `requireTripMember` gate select answers with, every time. */
  role: TripMemberRole;
  /** Successive answers for `select().from(places)` (visibility check / the PATCH place fetch). */
  placeSelects: PlaceRow[][];
  /** `insert().values().returning()` outcome — reject to exercise a catch arm. */
  insert?: () => Promise<SavedPlaceRow[]>;
  /** `update().set().where().returning()` rows. */
  update?: SavedPlaceRow[];
}

/**
 * Just enough of the Drizzle builder surface for the POST and PATCH paths
 * (gate select, place selects, insert, update). Every chain resolves from
 * the script; an unscripted call fails loud.
 */
function fakeDb(script: FakeDbScript): DbClient {
  const placeQueue = [...script.placeSelects];
  const fake = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.tripMembers) return Promise.resolve([{ role: script.role }]);
          if (table === schema.places) return Promise.resolve(placeQueue.shift() ?? []);
          return Promise.reject(new Error("fake db: unscripted select target"));
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () =>
          script.insert ? script.insert() : Promise.reject(new Error("fake db: unscripted insert")),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(script.update ?? []),
        }),
      }),
    }),
  };
  return fake as unknown as DbClient;
}

/** The real router behind a stand-in for the app-wide `requireAuth`. */
function harnessApp(db: DbClient): Hono<RequestVars> {
  const app = new Hono<RequestVars>();
  app.use("*", async (c, next) => {
    c.set("auth", { userId: USER_ID, sessionId: "session-fixture" });
    await next();
  });
  app.route("/api", createSavedPlacesRouter({ db }));
  return app;
}

const jsonRequest = (app: Hono<RequestVars>, method: string, path: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST 23503 catch arm — live through the router (r1 A3)", () => {
  it("place-FK violation from the insert maps to the canonical 404 for BOTH driver shapes", async () => {
    // postgres-js shape, Drizzle-wrapped (what the container suite would see
    // if the race ever fired there); pg-protocol shape thrown bare (what the
    // PROD Neon serverless driver throws).
    const thrownShapes: Error[] = [
      new Error("Failed query", {
        cause: driverError({ code: "23503", constraint_name: SAVED_PLACES_PLACE_FK }),
      }),
      driverError({ code: "23503", constraint: SAVED_PLACES_PLACE_FK }),
    ];

    const responses: Response[] = [];
    for (const thrown of thrownShapes) {
      const app = harnessApp(
        fakeDb({
          role: "editor",
          // Visibility check finds the place; the insert then loses the race.
          placeSelects: [[spinePlaceRow]],
          insert: () => Promise.reject(thrown),
        }),
      );
      responses.push(await jsonRequest(app, "POST", `/api/trips/${TRIP_ID}/saved-places`, {
        place_id: PLACE_ID,
      }));
    }
    // Canonical NOT_FOUND envelope, byte-identical across both shapes — the
    // race residue is indistinguishable from a place that never existed.
    await expectIndistinguishable404s(responses);
  });
});

describe("PATCH-note race arm — live through the router (r1 A1)", () => {
  it("update lands but the place row is gone (concurrent unsave + place delete) → canonical 404, byte-identical to the id-door 404", async () => {
    const app = harnessApp(
      fakeDb({
        role: "editor",
        // The post-update place fetch comes back empty: between the UPDATE
        // and the SELECT, a concurrent unsave released the RESTRICT FK and a
        // concurrent delete removed the place (and, with it, the pin).
        placeSelects: [[]],
        update: [savedPlaceRow],
      }),
    );

    const raced = await jsonRequest(
      app,
      "PATCH",
      `/api/trips/${TRIP_ID}/saved-places/${SAVED_ID}`,
      { note: "still here?" },
    );
    // The canonical savedPlaceId-door 404 from the same harness (malformed
    // id short-circuits before any db write) — the race arm must be
    // byte-identical to it, never a 500, never a distinguishable body.
    const idDoor = await jsonRequest(app, "PATCH", `/api/trips/${TRIP_ID}/saved-places/not-a-uuid`, {
      note: "still here?",
    });
    await expectIndistinguishable404s([raced, idDoor]);
  });
});
