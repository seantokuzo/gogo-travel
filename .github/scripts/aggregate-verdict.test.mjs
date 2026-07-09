#!/usr/bin/env node
/**
 * .github/scripts/aggregate-verdict.test.mjs
 *
 * Unit tests for the deterministic verdict aggregator. Pure — exercises the
 * exported aggregate() / extractSentinel() / findExistingSticky() with synthetic
 * line-format sentinel comments. No deps, no build, no pnpm.
 *
 * Run: node --test .github/scripts/*.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregate, extractSentinel, findExistingSticky } from "./aggregate-verdict.mjs";

// --- fixture helpers ------------------------------------------------------

let _id = 1000;
let _t = 0;
function ts() {
  _t += 1;
  return "2026-01-01T00:00:" + String(_t).padStart(2, "0") + "Z";
}

/** Render a line-format sentinel comment for a lane from a structured object. */
function mk(laneKey, obj, at = ts()) {
  const lines = [];
  if (obj.verdict !== undefined) lines.push("verdict: " + obj.verdict);
  if (obj.blocking_count !== undefined) lines.push("blocking: " + obj.blocking_count);
  if (obj.advisory_count !== undefined) lines.push("advisory: " + obj.advisory_count);
  if (obj.sensitive_paths_touched !== undefined)
    lines.push("sensitive: " + obj.sensitive_paths_touched);
  if (obj.ci_failing !== undefined) lines.push("ci_failing: " + obj.ci_failing);
  const sentinel = "<!-- GOGO-REVIEW-" + laneKey + "\n" + lines.join("\n") + "\n-->";
  return {
    id: _id++,
    created_at: at,
    body: sentinel + "\n\n## " + laneKey + " Review\n\nfindings",
  };
}
/** A bare sentinel comment from a raw body string (for malformed / edge cases). */
function raw(body, at = ts()) {
  return { id: _id++, created_at: at, body };
}
/** An existing verdict sticky at a given round. */
function sticky(round, at = ts()) {
  return {
    id: _id++,
    created_at: at,
    body:
      "<!-- GOGO-VERDICT-STICKY -->\n<!-- VERDICT_ROUND: " +
      round +
      " -->\n\n## Verdict — Round " +
      round,
  };
}

const META = { additions: 10, deletions: 5, headRefOid: "abc1234def5678", number: 42 };
function ship(extra = {}) {
  return {
    verdict: "ship",
    blocking_count: 0,
    advisory_count: 0,
    sensitive_paths_touched: false,
    ...extra,
  };
}

const LANE_KEYS = [
  ["correctness", "CORRECTNESS"],
  ["security", "SECURITY"],
  ["tests", "TESTS"],
  ["performance", "PERFORMANCE"],
  ["conventions", "CONVENTIONS"],
];

/** A full clean set of all 5 lane sentinels, with per-lane overrides. */
function full(overrides = {}) {
  return LANE_KEYS.map(([id, key]) => {
    const base = id === "correctness" ? ship({ ci_failing: false }) : ship();
    return mk(key, { ...base, ...(overrides[id] || {}) });
  });
}

// --- tests ----------------------------------------------------------------

test("1. all lanes ship, round 1 → ship, no escalation, head sha marker", () => {
  const r = aggregate({ comments: full({ security: { advisory_count: 1 } }), prMeta: META });
  assert.equal(r.verdict, "ship");
  assert.equal(r.round, 1);
  assert.equal(r.escalate, false);
  assert.equal(r.degraded, false);
  assert.equal(r.totalAdvisory, 1);
  assert.match(r.stickyBody, /<!-- VERDICT_ROUND: 1 -->/);
  assert.match(r.stickyBody, /<!-- VERDICT_HEAD_SHA: abc1234def5678 -->/);
});

test("2. any rethink → overall rethink + escalate(rethink-verdict)", () => {
  const r = aggregate({
    comments: full({ security: { verdict: "rethink", blocking_count: 1 } }),
    prMeta: META,
  });
  assert.equal(r.verdict, "rethink");
  assert.equal(r.escalate, true);
  assert.equal(r.escalateReason, "rethink-verdict");
});

test("3. blocking>0 but no rethink → fix-then-ship", () => {
  const r = aggregate({
    comments: full({ tests: { verdict: "fix-then-ship", blocking_count: 2 } }),
    prMeta: META,
  });
  assert.equal(r.verdict, "fix-then-ship");
  assert.equal(r.totalBlocking, 2);
});

test("4. >5-blocking escalation boundary: 5 no, 6 yes", () => {
  const make = (a, b) =>
    full({
      security: { verdict: "fix-then-ship", blocking_count: a },
      performance: { verdict: "fix-then-ship", blocking_count: b },
    });
  const five = aggregate({ comments: make(3, 2), prMeta: META });
  assert.equal(five.totalBlocking, 5);
  assert.equal(five.escalate, false);
  const six = aggregate({ comments: make(3, 3), prMeta: META });
  assert.equal(six.escalate, true);
  assert.equal(six.escalateReason, ">5-blocking");
});

test("5. large-diff escalation boundary: 500 no, 501 yes (verdict still ship)", () => {
  const at500 = aggregate({
    comments: full(),
    prMeta: { ...META, additions: 300, deletions: 200 },
  });
  assert.equal(at500.verdict, "ship");
  assert.equal(at500.escalate, false);
  const at501 = aggregate({
    comments: full(),
    prMeta: { ...META, additions: 301, deletions: 200 },
  });
  assert.equal(at501.escalate, true);
  assert.equal(at501.escalateReason, "large-diff");
});

test("6. sensitive paths: alone no escalate, +blocking escalates", () => {
  const a = aggregate({
    comments: full({ security: { sensitive_paths_touched: true } }),
    prMeta: META,
  });
  assert.equal(a.sensitivePaths, true);
  assert.equal(a.escalate, false);
  const b = aggregate({
    comments: full({
      security: { verdict: "fix-then-ship", blocking_count: 1, sensitive_paths_touched: true },
    }),
    prMeta: META,
  });
  assert.equal(b.escalate, true);
  assert.equal(b.escalateReason, "sensitive-paths-with-blocking");
});

test("7. round parsing: none→1, sticky:2→3, sticky-without-round→2", () => {
  assert.equal(aggregate({ comments: full(), prMeta: META }).round, 1);
  assert.equal(findExistingSticky([sticky(2)]).round, 3);
  const noRound = raw("<!-- GOGO-VERDICT-STICKY -->\n\n## Verdict (round marker missing)");
  assert.equal(findExistingSticky([noRound]).round, 2);
});

test("8. cap: round 4 is final (banner, NOT forced, escalation suppressed); round 5 forces rethink", () => {
  const round4 = aggregate({
    comments: [sticky(3, "2026-01-01T00:00:01Z"), ...full()],
    prMeta: { ...META, additions: 9000, deletions: 9000 },
  });
  assert.equal(round4.round, 4);
  assert.equal(round4.capReached, true);
  assert.equal(round4.verdict, "ship", "clean round 4 stays ship");
  assert.equal(round4.escalate, false, "escalation suppressed at the cap");
  assert.match(round4.stickyBody, /4-round cap reached/);

  const round5 = aggregate({
    comments: [sticky(4, "2026-01-01T00:00:01Z"), ...full()],
    prMeta: META,
  });
  assert.equal(round5.round, 5);
  assert.equal(round5.verdict, "rethink", "over-cap forces rethink");
  assert.equal(round5.escalate, false);
});

test("9a. missing lane (job-failed, no sentinel) → degraded, never ship, no escalate", () => {
  const comments = full().filter((_, i) => i !== 1); // drop security (index 1)
  const r = aggregate({ comments, prMeta: META, laneResults: { security: "failure" } });
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, "fix-then-ship");
  assert.equal(r.escalate, false);
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, false);
  assert.equal(sec.reason, "job-failed");
  assert.match(r.stickyBody, /no verdict \(job-failed\)/);
});

test("9b. lane ok, no sentinel posted → reason no-sentinel", () => {
  const comments = full().filter((_, i) => i !== 1);
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.lanes.find((l) => l.id === "security").reason, "no-sentinel");
});

test("9c. marker present but no key:value lines → malformed-sentinel, no throw", () => {
  const bad = raw("<!-- GOGO-REVIEW-SECURITY\n(this lane crashed before emitting fields)\n-->");
  const comments = [bad, ...full().filter((_, i) => i !== 1)];
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.lanes.find((l) => l.id === "security").reason, "malformed-sentinel");
});

test("10. most-recent sentinel wins across rounds", () => {
  const comments = [
    ...full(),
    // explicitly latest — `full()` uses the shared auto-incrementing clock
    mk(
      "SECURITY",
      { verdict: "rethink", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: false },
      "2027-01-01T00:00:00Z"
    ),
  ];
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "rethink");
  assert.equal(r.verdict, "rethink");
});

test("11. self-poisoning guard: a sticky quoting a sentinel marker is not parsed", () => {
  const poison = raw(
    "<!-- GOGO-VERDICT-STICKY -->\n<!-- VERDICT_ROUND: 1 -->\n\nExample: <!-- GOGO-REVIEW-SECURITY verdict: ship -->"
  );
  const comments = [poison, ...full().filter((_, i) => i !== 1)];
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.lanes.find((l) => l.id === "security").present, false);
});

test("12. ci_failing maps to CI line: true→red, false→green, absent→unknown", () => {
  const base = (corr) => [mk("CORRECTNESS", corr), ...full().filter((_, i) => i !== 0)];
  const red = aggregate({ comments: base(ship({ ci_failing: true })), prMeta: META });
  assert.equal(red.ciFailing, true);
  assert.match(red.stickyBody, /\*\*CI\*\*: red/);
  const green = aggregate({ comments: base(ship({ ci_failing: false })), prMeta: META });
  assert.match(green.stickyBody, /\*\*CI\*\*: green/);
  const unknown = aggregate({ comments: base(ship()), prMeta: META });
  assert.equal(unknown.ciFailing, null);
  assert.match(unknown.stickyBody, /\*\*CI\*\*: unknown/);
});

test("13. sticky byte-exactness: markers present and `|` survives in the output", () => {
  const r = aggregate({ comments: full(), prMeta: META });
  assert.match(r.stickyBody, /<!-- GOGO-VERDICT-STICKY -->/);
  assert.match(r.stickyBody, /<!-- VERDICT_ROUND: 1 -->/);
  assert.ok(
    r.stickyBody.includes("**Blocking**: 0 | **Advisory**: 0"),
    "the `|` survives verbatim"
  );
});

test("14. sticky shape: CI line + standard markers + all 5 specialists listed", () => {
  const r = aggregate({ comments: full(), prMeta: META });
  assert.match(r.stickyBody, /<!-- GOGO-VERDICT-STICKY -->/);
  assert.match(r.stickyBody, /### Specialists\n/);
  assert.match(r.stickyBody, /\*\*CI\*\*:/);
  for (const label of ["Correctness", "Security", "Tests", "Performance", "Conventions"]) {
    assert.match(r.stickyBody, new RegExp(label + ":"), label + " lane line present");
  }
});

test("15. empty comments → all lanes degraded, fix-then-ship, no throw", () => {
  const r = aggregate({ comments: [], prMeta: {} });
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, "fix-then-ship");
  assert.equal(r.round, 1);
  assert.equal(r.escalate, false);
  assert.equal(r.headSha, null);
  assert.equal(r.lanes.length, 5);
});

test("16. line parsing: whitespace-tolerant keys/values, extra keys ignored, missing fields default", () => {
  const sec = extractSentinel(
    [
      raw(
        "<!-- GOGO-REVIEW-SECURITY\n   verdict :   ship  \nblocking:0\nrationale: looks fine\n-->"
      ),
    ],
    "SECURITY"
  ).sentinel;
  assert.equal(sec.verdict, "ship");
  assert.equal(sec.blocking, "0");
  assert.equal(sec.rationale, "looks fine");
  // a present-but-no-advisory sentinel still aggregates with advisory defaulting to 0
  const comments = [
    raw("<!-- GOGO-REVIEW-SECURITY\nverdict: ship\nblocking: 0\n-->"),
    ...full().filter((_, i) => i !== 1),
  ];
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.lanes.find((l) => l.id === "security").advisory, 0);
});

test("17. multi-round line-format: round-3 sticky + fresh ship sentinels → round 4, cap, ship", () => {
  const comments = [
    sticky(1, "2026-01-01T00:00:01Z"),
    sticky(2, "2026-01-01T00:00:05Z"),
    sticky(3, "2026-01-01T00:00:09Z"),
    ...full(),
  ];
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.round, 4, "latest sticky was round 3 → this is round 4");
  assert.equal(r.capReached, true);
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, "ship");
  assert.match(r.stickyBody, /<!-- VERDICT_ROUND: 4 -->/);
  assert.match(r.stickyBody, /4-round cap reached/);
});

test("18. lane posted a valid sentinel but its run failed → trusted, noted, not degraded", () => {
  const r = aggregate({ comments: full(), prMeta: META, laneResults: { security: "failure" } });
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, true, "valid sentinel trusted even when the run result is failure");
  assert.equal(sec.jobOk, false);
  assert.equal(sec.note, "job: failure");
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, "ship");
  assert.match(r.stickyBody, /Security: ship .* — ⚠️ job: failure/);
});

test("19. present sentinel with an out-of-enum (or missing) verdict → degraded, never ship", () => {
  const garbage = aggregate({ comments: full({ security: { verdict: "lgtm" } }), prMeta: META });
  const sec = garbage.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, false);
  assert.equal(sec.reason, "no-verdict");
  assert.notEqual(garbage.verdict, "ship");
  const missing = aggregate({
    comments: [
      raw("<!-- GOGO-REVIEW-SECURITY\nblocking: 0\nadvisory: 1\n-->"),
      ...full().filter((_, i) => i !== 1),
    ],
    prMeta: META,
  });
  assert.equal(missing.lanes.find((l) => l.id === "security").reason, "no-verdict");
  assert.notEqual(missing.verdict, "ship");
});

test("20. headSha validated: invalid OIDs → null + no marker; 7- and 64-char hex accepted", () => {
  for (const bad of ["ABCDEF1", "abcdef", "g123456", "abc 123", "a".repeat(65), ""]) {
    const r = aggregate({ comments: full(), prMeta: { ...META, headRefOid: bad } });
    assert.equal(r.headSha, null, "must reject " + JSON.stringify(bad));
    assert.doesNotMatch(r.stickyBody, /VERDICT_HEAD_SHA/);
  }
  for (const good of ["a".repeat(7), "a".repeat(64)]) {
    const r = aggregate({ comments: full(), prMeta: { ...META, headRefOid: good } });
    assert.equal(r.headSha, good);
    assert.match(r.stickyBody, /<!-- VERDICT_HEAD_SHA: a+ -->/);
  }
});

test("21. existingStickyId reflects the prior sticky (drives PATCH vs POST when posting)", () => {
  const s = sticky(1);
  const withSticky = aggregate({ comments: [s, ...full()], prMeta: META });
  assert.equal(withSticky.existingStickyId, s.id);
  const without = aggregate({ comments: full(), prMeta: META });
  assert.equal(without.existingStickyId, null);
});

test("22. num() coercion: string→int, float→floor, negative/NaN→0", () => {
  const comments = full({
    security: { verdict: "fix-then-ship", blocking_count: "3", advisory_count: "2" },
    performance: { verdict: "fix-then-ship", blocking_count: "-5", advisory_count: "x" },
  });
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.totalBlocking, 3, "'3' → 3, '-5' → 0");
  assert.equal(r.totalAdvisory, 2, "'2' → 2, 'x' → 0");
});

test("23. round-3 boundary: round-2 sticky → round 3, cap NOT reached, verdict not forced", () => {
  const r = aggregate({ comments: [sticky(2, "2026-01-01T00:00:01Z"), ...full()], prMeta: META });
  assert.equal(r.round, 3);
  assert.equal(r.capReached, false);
  assert.equal(r.verdict, "ship");
  assert.doesNotMatch(r.stickyBody, /4-round cap reached/);
});

test("24. stale-but-valid wins when a newer same-lane sentinel is malformed", () => {
  const comments = [
    mk("SECURITY", ship(), "2026-01-01T00:00:01Z"),
    raw("<!-- GOGO-REVIEW-SECURITY\n(crashed mid-emit)\n-->", "2026-01-01T00:00:40Z"),
    ...full().filter((_, i) => i !== 1),
  ];
  const r = aggregate({ comments, prMeta: META });
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, true);
  assert.equal(sec.verdict, "ship");
});

test("25. two sentinel blocks in one comment → the last block wins", () => {
  const body =
    "<!-- GOGO-REVIEW-SECURITY\nverdict: ship\nblocking: 0\n-->\nmid\n" +
    "<!-- GOGO-REVIEW-SECURITY\nverdict: rethink\nblocking: 2\n-->";
  const comments = [raw(body), ...full().filter((_, i) => i !== 1)];
  const r = aggregate({ comments, prMeta: META });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "rethink");
});

test("26. escalation is a RECOMMENDATION (no label) pointing at /code-review ultra, not a CI workflow", () => {
  const r = aggregate({
    comments: full({ security: { verdict: "rethink", blocking_count: 1 } }),
    prMeta: META,
  });
  assert.equal(r.escalate, true);
  assert.equal(
    r.applyLabel,
    undefined,
    "no label is applied — in-session, user-triggered deep review"
  );
  assert.match(r.stickyBody, /Escalation criteria met \(reason: rethink-verdict\)/);
  assert.match(r.stickyBody, /\/code-review ultra/);
  assert.doesNotMatch(r.stickyBody, /gh workflow run/);
});

test("27. sentinel marker boundary: no cross-lane bleed, no prefix mis-match", () => {
  // cross-lane: a CONVENTIONS sentinel must not be read as CORRECTNESS
  const r = aggregate({
    comments: [
      raw("<!-- GOGO-REVIEW-CONVENTIONS\nverdict: ship\nblocking: 0\n-->"),
      mk("CORRECTNESS", ship({ ci_failing: false })),
    ],
    prMeta: META,
  });
  assert.equal(r.lanes.find((l) => l.id === "conventions").present, true);
  assert.equal(r.lanes.find((l) => l.id === "correctness").present, true);
  assert.equal(r.lanes.find((l) => l.id === "security").present, false);
  // a longer marker with SECURITY as a prefix must NOT match the SECURITY lane
  assert.equal(
    extractSentinel([raw("<!-- GOGO-REVIEW-SECURITYEXTRA\nverdict: ship\n-->")], "SECURITY")
      .sentinel,
    null
  );
});

test("28. round override: explicit round wins over computed; 0/invalid falls back", () => {
  // No sticky present (would compute round 1); override to 3 → cap not reached.
  const r3 = aggregate({ comments: full(), prMeta: META, round: 3 });
  assert.equal(r3.round, 3);
  assert.equal(r3.capReached, false);
  // Override 5 → over-cap forces rethink even on a clean set.
  const r5 = aggregate({ comments: full(), prMeta: META, round: 5 });
  assert.equal(r5.round, 5);
  assert.equal(r5.verdict, "rethink");
  // Invalid overrides fall back to the computed round (1).
  for (const bad of [0, -2, 1.5, NaN, "2"]) {
    assert.equal(
      aggregate({ comments: full(), prMeta: META, round: bad }).round,
      1,
      "fallback for " + JSON.stringify(bad)
    );
  }
  // Override coexists with a sticky-derived round, taking precedence.
  assert.equal(aggregate({ comments: [sticky(2), ...full()], prMeta: META, round: 1 }).round, 1);
});

test("29. a lane comment that only MENTIONS the sticky marker in prose still parses as its lane", () => {
  // Regression: isStickyComment must anchor to the real `<!-- GOGO-VERDICT-STICKY`
  // HTML-comment open, NOT the bare token — a prose mention must not drop the lane.
  // (This is the over-match that silently dropped the conventions lane.)
  const body =
    "<!-- GOGO-REVIEW-CONVENTIONS\nverdict: ship\nblocking: 0\nadvisory: 0\nsensitive: false\n-->\n\n" +
    "## Conventions Review\n\nNote: the aggregator (not this lane) writes the GOGO-VERDICT-STICKY comment.";
  const comments = [raw(body), ...full().filter((_, i) => i !== 4)]; // index 4 = conventions
  const r = aggregate({ comments, prMeta: META });
  const conv = r.lanes.find((l) => l.id === "conventions");
  assert.equal(conv.present, true, "prose mention of the sticky marker must not skip the lane");
  assert.equal(conv.verdict, "ship");
  assert.equal(r.degraded, false);
});
