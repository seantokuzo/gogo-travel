#!/usr/bin/env node
/**
 * Guard: the fetch-fresh place payload is RENDER-ONLY — it must never be
 * persisted (map spec §2.4 / R-map-9; places spec R-places-11 — the
 * Foursquare zero-caching licensing contract; "enforced by review + a
 * lint-level grep in CI" is §2.4's own enforcement clause, and this is that
 * grep).
 *
 * TWO RULES, both over tracked `apps/mobile` runtime source (tests and
 * test-utils are exempt — they don't ship, and their fixtures legitimately
 * name both sides):
 *
 * 1. NO TANSTACK PERSISTER MAY EXIST IN THE MOBILE APP. §2.4's "suspenders"
 *    (a `shouldDehydrateQuery` allowlist excluding the `place-fresh` prefix)
 *    intentionally does not exist because there is nothing to configure it
 *    on: the P-8 offline ruling is WARM-SESSION only — no TQ persister, and
 *    building one is offline-spec (§2.9) scope. The moment a persister API
 *    appears, every cached query — including a lingering `place-fresh`
 *    entry — becomes storage-bound, so this guard fails and forces the §2.4
 *    exclusion to land IN THE SAME CHANGE (then this rule is updated
 *    deliberately, with the allowlist in place).
 *
 * 2. NO FRESH-TOUCHING MODULE MAY TOUCH A STORAGE/LOG SINK. Any runtime
 *    source file that references the fresh domain (`place-fresh` key,
 *    `FreshPlaceDetails`, `usePlaceFresh`/`placeFresh`) must not also
 *    reference a persistence or logging sink (zustand / MMKV /
 *    AsyncStorage / SecureStore / SQLite / file-system imports, or a
 *    `console.` call). Sink tokens are IMPORT- and CALL-SHAPED on purpose:
 *    prose in doc comments ("never enters MMKV…") must not trip the guard,
 *    only code that could actually move the payload.
 *
 * A grep is not a dataflow analysis — a determined layering violation can
 * still smuggle the payload through an intermediate module. That's what
 * review is for; this catches the direct (and by far most likely) failure
 * shape at CI cost ~0.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

/** Rule-1 tokens: any TanStack persister API/package surfacing in the app. */
export const PERSISTER_TOKENS = [
  "persistQueryClient",
  "PersistQueryClientProvider",
  "createSyncStoragePersister",
  "createAsyncStoragePersister",
  "experimental_createQueryPersister",
  "@tanstack/react-query-persist-client",
  "@tanstack/query-sync-storage-persister",
  "@tanstack/query-async-storage-persister",
];

/** Rule-2 trigger: the file works with the fetch-fresh domain. */
export const FRESH_TOKENS = [
  "place-fresh",
  "FreshPlaceDetails",
  "usePlaceFresh",
  "placeFresh",
];

/** Rule-2 sinks: import-/call-shaped so doc-comment prose can't trip them. */
export const SINK_TOKENS = [
  'from "zustand"',
  "from 'zustand'",
  'from "react-native-mmkv"',
  'from "@react-native-async-storage',
  'from "expo-secure-store"',
  'from "expo-sqlite"',
  'from "expo-file-system"',
  "AsyncStorage.",
  "SecureStore.",
  "console.",
];

const RUNTIME_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

/**
 * Rule scope: `apps/mobile` runtime source + its package.json (rule 1 —
 * a persister DEPENDENCY is a violation before its first import). Tests,
 * test-utils, and jest setup are exempt (module doc).
 */
export function isMobileRuntimeSource(file) {
  if (!file.startsWith("apps/mobile/")) return false;
  if (file === "apps/mobile/package.json") return true;
  if (!file.startsWith("apps/mobile/src/")) return false;
  if (file.startsWith("apps/mobile/src/test-utils/")) return false;
  if (file.includes("__tests__/")) return false;
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (/\.test\.[^.]+$/.test(base)) return false;
  const dot = base.lastIndexOf(".");
  const ext = dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
  return RUNTIME_EXTENSIONS.has(ext);
}

/** lstat-gated read (the nul-guard's non-regular-entry posture). */
export function readIfRegularFile(file) {
  let stats;
  try {
    stats = lstatSync(file);
  } catch {
    return null;
  }
  return stats.isFile() ? readFileSync(file, "utf8") : null;
}

/**
 * Scan `files`; returns `[{ file, rule, token }]` — one entry per offending
 * (file, token). `read` injectable for the unit tests (no fixture files).
 */
export function findFreshPersistenceViolations(files, read = readIfRegularFile) {
  const hits = [];
  for (const file of files) {
    if (!isMobileRuntimeSource(file)) continue;
    const text = read(file);
    if (text === null || text === undefined) continue;
    for (const token of PERSISTER_TOKENS) {
      if (text.includes(token)) hits.push({ file, rule: "no-persister", token });
    }
    if (file === "apps/mobile/package.json") continue;
    if (!FRESH_TOKENS.some((token) => text.includes(token))) continue;
    for (const token of SINK_TOKENS) {
      if (text.includes(token)) hits.push({ file, rule: "fresh-sink", token });
    }
  }
  return hits;
}

/** Tracked files, via git — untracked scratch files are not our business. */
export function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((f) => f.length > 0);
}

/** Neutralise workflow-command forgery in untrusted paths (nul-guard posture). */
export function safeAnnotationPath(file) {
  return file.replace(/[\r\n]+/g, " ").replaceAll("::", "__");
}

const RULE_MESSAGES = {
  "no-persister":
    "TanStack persister API in the mobile app. The P-8 offline ruling is " +
    "warm-session only (NO persister); if one is now sanctioned, the map " +
    "spec §2.4 `shouldDehydrateQuery` allowlist excluding the `place-fresh` " +
    "prefix MUST land in the same change — then update this guard deliberately.",
  "fresh-sink":
    "storage/log sink in a module that touches the fetch-fresh place " +
    "payload. Fresh details are render-only (map spec §2.4 / R-map-9, " +
    "Foursquare zero-caching licensing) — they never enter stores, storage, " +
    "analytics, or logging.",
};

/**
 * Exit contract (the whole thing CI consumes — pinned both directions by the
 * test suite, the nul-guard round-2 lesson): 0 clean, 1 on any violation.
 */
export function main({ files, read } = {}) {
  const hits = findFreshPersistenceViolations(
    files ?? trackedFiles(),
    ...(read === undefined ? [] : [read]),
  );
  if (hits.length === 0) {
    console.warn("OK — no place-fresh persistence violations in apps/mobile runtime source.");
    return 0;
  }
  for (const { file, rule, token } of hits) {
    console.error(
      `::error file=${safeAnnotationPath(file)}::\`${token}\` — ${RULE_MESSAGES[rule]}`,
    );
  }
  return 1;
}

// `node check-place-fresh-persistence.mjs` runs the check; importing (the test) does not.
if (process.argv[1] && process.argv[1].endsWith("check-place-fresh-persistence.mjs")) {
  process.exit(main());
}
