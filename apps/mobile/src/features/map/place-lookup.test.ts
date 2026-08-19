/**
 * Sheet place resolution (T-8.3 / MAP-2 — R-map-4 seam glue). Load-bearing:
 * the id → row join over the saved-places cache, and the UNRESOLVED ⇒ null
 * degrade (interim-limited pin coverage ruling — no improvised row source).
 */
import { savedPlaceRowFor } from "./place-lookup";
import { makeSavedPlaceWithPlace } from "@/test-utils/trip-fixtures";

const PLACE_A = "44444444-4444-4444-8444-444444444441";
const PLACE_B = "44444444-4444-4444-8444-444444444442";

const rows = [
  makeSavedPlaceWithPlace({
    id: "55555555-5555-4555-8555-555555555551",
    place_id: PLACE_A,
    place: { id: PLACE_A, name: "Fushimi Inari" },
  }),
  makeSavedPlaceWithPlace({
    id: "55555555-5555-4555-8555-555555555552",
    place_id: PLACE_B,
    place: { id: PLACE_B, name: "Nishiki Market" },
  }),
];

it("resolves a selected id to its embedded place row", () => {
  expect(savedPlaceRowFor(rows, PLACE_B)?.name).toBe("Nishiki Market");
});

it("unresolved id ⇒ null (no sheet — the ruling's degrade)", () => {
  expect(savedPlaceRowFor(rows, "99999999-9999-4999-8999-999999999999")).toBeNull();
});

it("undefined cache (still loading) ⇒ null", () => {
  expect(savedPlaceRowFor(undefined, PLACE_A)).toBeNull();
});
