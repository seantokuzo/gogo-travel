/**
 * Unit tests for the place-fresh non-persistence guard (map spec §2.4 —
 * T-8.4). Fixtures are in-memory strings through the injected reader (the
 * nul-guard test pattern); the exit contract is pinned BOTH directions
 * (round-2 lesson there: a guard whose `return 1` can flip to `return 0`
 * with a green suite is not a gate).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  findFreshPersistenceViolations,
  FRESH_TOKENS,
  isMobileRuntimeSource,
  main,
  PERSISTER_TOKENS,
  SINK_TOKENS,
  trackedFiles,
} from "./check-place-fresh-persistence.mjs";

const readerFor = (files) => (file) => files[file];

// ---------------------------------------------------------------------------
// Rule 1 — no TanStack persister in the mobile app
// ---------------------------------------------------------------------------

test("flags a persister API import anywhere in mobile runtime source", () => {
  const file = "apps/mobile/src/data/query-client.ts";
  const hits = findFreshPersistenceViolations(
    [file],
    readerFor({
      [file]: 'import { persistQueryClient } from "@tanstack/react-query-persist-client";\n',
    }),
  );
  // Both the API name and the package specifier match — two hits, same rule.
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.file === file && h.rule === "no-persister"));
});

test("flags a persister package landing in apps/mobile/package.json", () => {
  const file = "apps/mobile/package.json";
  const hits = findFreshPersistenceViolations(
    [file],
    readerFor({
      [file]: '{ "dependencies": { "@tanstack/query-sync-storage-persister": "^5.0.0" } }\n',
    }),
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, "no-persister");
});

test("CONTROL: package.json without persister deps is clean (and rule 2 never applies to it)", () => {
  const file = "apps/mobile/package.json";
  // `console.` would be a rule-2 sink in a source file; package.json is
  // rule-1 scope only, so this must not trip.
  const hits = findFreshPersistenceViolations(
    [file],
    readerFor({ [file]: '{ "name": "mobile", "scripts": { "x": "console." } }\n' }),
  );
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// Rule 2 — fresh-touching modules must not touch sinks
// ---------------------------------------------------------------------------

test("flags a fresh-touching module that imports a storage sink", () => {
  const file = "apps/mobile/src/features/places/fresh-cache.ts";
  const hits = findFreshPersistenceViolations(
    [file],
    readerFor({
      [file]:
        'import { MMKV } from "react-native-mmkv";\n' +
        'import type { FreshPlaceDetails } from "@gogo/shared";\n',
    }),
  );
  assert.deepEqual(hits, [{ file, rule: "fresh-sink", token: 'from "react-native-mmkv"' }]);
});

test("flags a fresh-touching module that console-logs", () => {
  const file = "apps/mobile/src/data/places.ts";
  const hits = findFreshPersistenceViolations(
    [file],
    readerFor({ [file]: 'const x = usePlaceFresh(id);\nconsole.log(x);\n' }),
  );
  assert.deepEqual(hits, [{ file, rule: "fresh-sink", token: "console." }]);
});

test("CONTROL: sink WITHOUT fresh domain is clean (zustand stores are fine elsewhere)", () => {
  const file = "apps/mobile/src/features/map/pending-focus.ts";
  const hits = findFreshPersistenceViolations(
    [file],
    readerFor({ [file]: 'import { create } from "zustand";\nexport const s = create(() => ({}));\n' }),
  );
  assert.deepEqual(hits, []);
});

test("CONTROL: fresh domain WITHOUT sinks is clean — prose mentions of MMKV/Zustand don't trip", () => {
  const file = "apps/mobile/src/data/places.ts";
  const hits = findFreshPersistenceViolations(
    [file],
    readerFor({
      [file]:
        "/** place-fresh payloads never enter Zustand, SQLite, MMKV, analytics, or console logging. */\n" +
        "export function usePlaceFresh() {}\n",
    }),
  );
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("scope: tests, test-utils, jest files, and non-mobile files are exempt", () => {
  const dirty = 'const a = usePlaceFresh(); console.log(a); persistQueryClient();\n';
  for (const file of [
    "apps/mobile/src/data/places.test.tsx",
    "apps/mobile/src/__tests__/place-detail-screen.test.tsx",
    "apps/mobile/src/test-utils/fresh-fixtures.ts",
    "apps/mobile/jest.setup.js",
    "apps/server/src/places/routes.ts",
    "packages/shared/src/domains/place.ts",
    "docs/STATE.md",
  ]) {
    assert.equal(isMobileRuntimeSource(file), false, file);
    assert.deepEqual(findFreshPersistenceViolations([file], readerFor({ [file]: dirty })), []);
  }
});

test("scope: runtime source files under apps/mobile/src ARE covered", () => {
  for (const file of [
    "apps/mobile/src/data/places.ts",
    "apps/mobile/src/app/[tripId]/map/place/[placeId].tsx",
    "apps/mobile/src/features/places/index.ts",
  ]) {
    assert.equal(isMobileRuntimeSource(file), true, file);
  }
});

// ---------------------------------------------------------------------------
// Exit contract (what CI consumes) — pinned both directions
// ---------------------------------------------------------------------------

test("exit contract: violation ⇒ 1, clean ⇒ 0", () => {
  const dirtyFile = "apps/mobile/src/data/places.ts";
  assert.equal(
    main({
      files: [dirtyFile],
      read: readerFor({ [dirtyFile]: "usePlaceFresh();\nconsole.log(1);\n" }),
    }),
    1,
  );
  assert.equal(
    main({ files: [dirtyFile], read: readerFor({ [dirtyFile]: "usePlaceFresh();\n" }) }),
    0,
  );
});

// ---------------------------------------------------------------------------
// The guard runs green against the REAL tree (the whole point of landing it)
// ---------------------------------------------------------------------------

test("the actual repo passes the guard today", () => {
  assert.equal(main({ files: trackedFiles() }), 0);
});

test("token lists are non-empty and disjoint where it matters", () => {
  assert.ok(PERSISTER_TOKENS.length > 0);
  assert.ok(FRESH_TOKENS.length > 0);
  assert.ok(SINK_TOKENS.length > 0);
  // A fresh token doubling as a sink token would make every fresh module
  // self-flagging — structural sanity, not behavior.
  for (const token of FRESH_TOKENS) assert.ok(!SINK_TOKENS.includes(token));
});
