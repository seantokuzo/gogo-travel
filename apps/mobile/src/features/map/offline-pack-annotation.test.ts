/**
 * MMKV pack annotation (T-8.5 — §2.5's "small MMKV record"). Load-bearing:
 * corrupt or shape-drifted records read as ABSENT (never a crash), and the
 * list surface only returns valid records — the purge planner's candidate
 * source must not see garbage.
 */
import { createMMKV } from "react-native-mmkv";

import {
  clearPackAnnotationsForTests,
  listPackAnnotations,
  readPackAnnotation,
  removePackAnnotation,
  writePackAnnotation,
} from "./offline-pack-annotation";
import type { OfflinePackAnnotation } from "./offline-packs";

const annotation = (tripId: string): OfflinePackAnnotation => ({
  tripId,
  styleUrl: "mapbox://styles/mapbox/light-v11",
  regionKey: "r:70:271",
  completedAt: "2026-08-18T00:00:00.000Z",
  sizeBytes: 12_000_000,
});

beforeEach(() => {
  clearPackAnnotationsForTests();
});

it("write/read round-trips; remove clears; absent reads undefined", () => {
  expect(readPackAnnotation("t1")).toBeUndefined();
  writePackAnnotation(annotation("t1"));
  expect(readPackAnnotation("t1")).toEqual(annotation("t1"));
  removePackAnnotation("t1");
  expect(readPackAnnotation("t1")).toBeUndefined();
});

it("corrupt JSON and shape drift read as ABSENT, never throw", () => {
  const storage = createMMKV();
  storage.set("gogo.offlinePack.bad-json", "{not json");
  storage.set("gogo.offlinePack.bad-shape", JSON.stringify({ tripId: 42 }));
  expect(readPackAnnotation("bad-json")).toBeUndefined();
  expect(readPackAnnotation("bad-shape")).toBeUndefined();
});

it("list returns only VALID records — the purge candidate source", () => {
  writePackAnnotation(annotation("t1"));
  writePackAnnotation(annotation("t2"));
  createMMKV().set("gogo.offlinePack.corrupt", "??");
  const listed = listPackAnnotations();
  expect(listed.map((entry) => entry.tripId).sort()).toEqual(["t1", "t2"]);
});

it("annotations are namespaced — foreign gogo.* keys are untouched by the test reset", () => {
  const storage = createMMKV();
  storage.set("gogo.appearance", "dark");
  writePackAnnotation(annotation("t1"));
  clearPackAnnotationsForTests();
  expect(readPackAnnotation("t1")).toBeUndefined();
  expect(storage.getString("gogo.appearance")).toBe("dark");
  storage.remove("gogo.appearance");
});
