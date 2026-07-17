#!/usr/bin/env node
/**
 * .github/scripts/aggregate-verdict.mjs
 *
 * Deterministic verdict aggregator for GoGo Travel's IN-SESSION PR review pipeline.
 * Pure Node, zero deps. There is NO GitHub Action and NO API billing: the main
 * Claude Code agent (Sean's Max plan) spawns one specialist SUBAGENT per lane,
 * each emits a line-format sentinel, the agent saves them to files, then runs
 * this script to compute the verdict that drives fix → judge → merge.
 *
 * SENTINEL FORMAT (line-based, NOT JSON). Each lane emits ONE block:
 *   <!-- GOGO-REVIEW-<LANE>
 *   verdict: ship | fix-then-ship | rethink
 *   blocking: <N>
 *   advisory: <N>
 *   sensitive: true | false
 *   ci_failing: true | false      (correctness lane only)
 *   -->
 * LANE ∈ CORRECTNESS | SECURITY | TESTS | PERFORMANCE | CONVENTIONS.
 * Line format (no braces / quotes) is the shared truth with seantokuzo-mcp: a
 * JSON sentinel can trip a sandbox brace/quote validator; a `key: value` block
 * never does, and it survives a copy through a PR comment unchanged. Canonical
 * pin: .claude/rules/pr-review-files.md.
 *
 * Two entry points:
 *   - aggregate({ comments, prMeta, laneResults, round }) — PURE, no I/O.
 *   - main() — CLI: read sentinel files (or stdin), aggregate, print the sticky
 *     body to stdout + a one-line verdict summary to stderr. No network.
 *
 * CLI:
 *   node aggregate-verdict.mjs [--round N] [--head SHA] [--pr N] \
 *        [--additions N] [--deletions N] <sentinel-file>...
 *   # or pipe:  cat .tmp/review/round-2/*.md | node aggregate-verdict.mjs --round 2
 *
 * The same exported aggregate() is unit-tested in aggregate-verdict.test.mjs
 * (run: node --test .github/scripts/*.test.mjs) so it can also be a CI gate.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// --- lane configuration ---------------------------------------------------

const LANES = {
  correctness: { key: "CORRECTNESS", emoji: "✅", label: "Correctness" },
  security: { key: "SECURITY", emoji: "🔒", label: "Security" },
  tests: { key: "TESTS", emoji: "🧪", label: "Tests" },
  performance: { key: "PERFORMANCE", emoji: "⚡", label: "Performance" },
  conventions: { key: "CONVENTIONS", emoji: "📐", label: "Conventions" },
};
const LANE_IDS = ["correctness", "security", "tests", "performance", "conventions"];

const STICKY_MARKER = "GOGO-VERDICT-STICKY";
// Sticky DETECTION must anchor to the real HTML-comment open (`<!-- ` + marker),
// never the bare token: a lane comment that merely MENTIONS the marker in prose
// is not a sticky and must still be parsed for its sentinel. (STICKY_MARKER stays
// bare — renderSticky() wraps it in the `<!-- ... -->` delimiters itself.)
const STICKY_OPEN = "<!-- " + STICKY_MARKER;
const ROUND_LABEL = "VERDICT_ROUND";
const VALID_VERDICTS = new Set(["ship", "fix-then-ship", "rethink"]);
const MAX_ROUNDS = 4;

// --- small helpers --------------------------------------------------------

/** Coerce a value to a non-negative integer; anything weird becomes 0. */
function num(v) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A comment is "sticky" (a verdict comment, not a sentinel) only if it carries the real HTML-comment sticky marker. */
function isStickyComment(body) {
  return body.includes(STICKY_OPEN);
}

// --- sentinel + sticky extraction (pure) ----------------------------------

/**
 * Parse a line-format sentinel body into a field map. Returns null if no
 * `key: value` line is present.
 */
function parseSentinelLines(text) {
  const map = {};
  let sawKey = false;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    map[key] = val;
    sawKey = true;
  }
  return sawKey ? map : null;
}

/**
 * Pull the relevant sentinel for one lane out of the comment list.
 *   - comments must be chronological-ascending (aggregate() sorts them).
 *   - skip sticky comments (self-poisoning guard).
 *   - "most recent instance wins" across rounds / blocks.
 */
export function extractSentinel(comments, laneKey) {
  // \b after the lane key stops GOGO-REVIEW-SECURITY matching a mistyped
  // GOGO-REVIEW-SECURITYEXTRA marker.
  const re = new RegExp("<!--\\s*GOGO-REVIEW-" + laneKey + "\\b\\s*([\\s\\S]*?)-->", "g");
  let mostRecent = null;
  let sawUnparseable = false;
  for (const c of comments) {
    const body = typeof c?.body === "string" ? c.body : "";
    if (!body || isStickyComment(body)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      const parsed = parseSentinelLines(m[1]);
      if (!parsed) {
        sawUnparseable = true;
        continue;
      }
      mostRecent = parsed;
    }
  }
  return { sentinel: mostRecent, sawUnparseable: mostRecent ? false : sawUnparseable };
}

/**
 * Find the existing verdict sticky (last one wins) and compute THIS round's
 * number from its round marker + 1. No sticky → round 1. Sticky present but
 * round unparseable → round 2 (a sticky implies a prior round happened). The
 * CLI can override this with --round when it is driving the loop directly.
 */
export function findExistingSticky(comments) {
  let found = null;
  for (const c of comments) {
    const body = typeof c?.body === "string" ? c.body : "";
    if (body.includes(STICKY_OPEN)) found = c;
  }
  if (!found) return { comment: null, round: 1 };
  const m = String(found.body).match(new RegExp(ROUND_LABEL + ":\\s*(\\d+)"));
  const prev = m ? parseInt(m[1], 10) : null;
  return { comment: found, round: prev !== null ? prev + 1 : 2 };
}

/** Build a normalized lane object from the comments + the lane's optional run result. */
function buildLane(comments, laneId, jobResult) {
  const meta = LANES[laneId];
  const { sentinel, sawUnparseable } = extractSentinel(comments, meta.key);
  const jobOk = jobResult === undefined || jobResult === "" || jobResult === "success";
  // A sentinel is USABLE only if it carries a recognized verdict. A sentinel
  // without a valid verdict is a degraded lane (never "present"), so it can
  // never let the aggregate report "ship".
  if (sentinel && VALID_VERDICTS.has(sentinel.verdict)) {
    return {
      id: laneId,
      emoji: meta.emoji,
      label: meta.label,
      present: true,
      verdict: sentinel.verdict,
      blocking: num(sentinel.blocking),
      advisory: num(sentinel.advisory),
      sensitive: sentinel.sensitive === "true",
      ciFailing:
        sentinel.ci_failing === "true" ? true : sentinel.ci_failing === "false" ? false : null,
      jobResult: jobResult ?? null,
      jobOk,
      note: jobOk ? null : "job: " + jobResult,
    };
  }
  const reason = !jobOk
    ? "job-failed"
    : sentinel
      ? "no-verdict" // a sentinel was parsed but its verdict is not in the enum
      : sawUnparseable
        ? "malformed-sentinel"
        : "no-sentinel";
  return {
    id: laneId,
    emoji: meta.emoji,
    label: meta.label,
    present: false,
    verdict: null,
    blocking: 0,
    advisory: 0,
    sensitive: false,
    ciFailing: null,
    jobResult: jobResult ?? null,
    jobOk,
    reason,
  };
}

// --- sticky body rendering (pure) -----------------------------------------

function laneLine(l) {
  if (!l.present) {
    return "- " + l.emoji + " " + l.label + ": ⚠️ no verdict (" + l.reason + ")";
  }
  const note = l.jobOk ? "" : " — ⚠️ " + l.note;
  return (
    "- " +
    l.emoji +
    " " +
    l.label +
    ": " +
    l.verdict +
    " (" +
    l.blocking +
    " blocking, " +
    l.advisory +
    " advisory)" +
    note
  );
}

function renderSticky(a) {
  const L = [];
  L.push("<!-- " + STICKY_MARKER + " -->");
  L.push("<!-- " + ROUND_LABEL + ": " + a.round + " -->");
  if (a.headSha) L.push("<!-- VERDICT_HEAD_SHA: " + a.headSha + " -->");
  L.push("");
  L.push("## 📋 Auto-Review Verdict — Round " + a.round);
  L.push("");
  L.push("**Verdict**: " + a.verdict);
  L.push("**Blocking**: " + a.totalBlocking + " | **Advisory**: " + a.totalAdvisory);
  const ciText = a.ciFailing === true ? "red" : a.ciFailing === false ? "green" : "unknown";
  L.push("**CI**: " + ciText);
  L.push("");
  if (a.degraded) {
    L.push(
      "> ⚠️ One or more specialist lanes produced no usable verdict this round — the verdict is incomplete. Re-run the affected lane(s) before merging.",
    );
    L.push("");
  }
  L.push("### Specialists");
  for (const l of a.lanes) L.push(laneLine(l));
  L.push("");
  L.push("_Line-level findings are in the specialist reports + inline review threads._");
  L.push("");
  L.push("---");
  L.push("");
  if (a.escalate) {
    L.push("> 🚨 Escalation criteria met (reason: " + a.escalateReason + ").");
    L.push("> Consider a deep review: `/code-review ultra` (deep cloud, user-triggered).");
    L.push("");
  }
  if (a.capReached) {
    L.push("> 🚨 " + MAX_ROUNDS + "-round cap reached. Human decision required to merge or close.");
    L.push("");
  }
  L.push(
    "🤖 _Verdict computed deterministically by `.github/scripts/aggregate-verdict.mjs` from " +
      a.lanes.length +
      " specialist sentinels (no LLM)._",
  );
  return L.join("\n");
}

// --- the pure aggregator --------------------------------------------------

/**
 * Compute the aggregate verdict + sticky body from sentinel-bearing comments +
 * PR metadata. Pure — no network, no env, no process exit. `comments` is an
 * array of `{ id, created_at, body }`; in-session the main agent builds it from
 * the per-lane sentinel files (and, optionally, the prior round's sticky so the
 * round auto-increments). `round` is an explicit override that wins when set.
 * Escalation is a RECOMMENDATION only — it suggests `/code-review ultra`.
 */
export function aggregate({
  comments = [],
  prMeta = {},
  laneResults = {},
  round: roundOverride,
} = {}) {
  const ordered = [...comments].sort((a, b) =>
    String(a?.created_at ?? "").localeCompare(String(b?.created_at ?? "")),
  );

  const lanes = LANE_IDS.map((id) => buildLane(ordered, id, laneResults[id]));
  const present = lanes.filter((l) => l.present);
  const degraded = lanes.some((l) => !l.present);

  const totalBlocking = present.reduce((s, l) => s + l.blocking, 0);
  const totalAdvisory = present.reduce((s, l) => s + l.advisory, 0);
  const sensitivePaths = present.some((l) => l.sensitive);
  const correctness = lanes.find((l) => l.id === "correctness");
  const ciFailing = correctness && correctness.present ? correctness.ciFailing : null;

  let verdict;
  if (present.some((l) => l.verdict === "rethink")) verdict = "rethink";
  else if (totalBlocking > 0) verdict = "fix-then-ship";
  else verdict = "ship";
  if (degraded && verdict === "ship") verdict = "fix-then-ship";

  const { comment: existingSticky, round: computedRound } = findExistingSticky(ordered);
  const round =
    Number.isInteger(roundOverride) && roundOverride > 0 ? roundOverride : computedRound;

  // 4-round cap: round >= 4 is the final allowed round (banner + escalation
  // suppressed); round > 4 forces "rethink". A clean round-4 ship stays ship.
  const capReached = round >= MAX_ROUNDS;
  if (round > MAX_ROUNDS) verdict = "rethink";

  // Escalation RECOMMENDATION (not at the cap). No label, no auto-trigger — the
  // sticky just suggests the user run a deep `/code-review ultra`.
  const diffTotal = num(prMeta.additions) + num(prMeta.deletions);
  let escalate = false;
  let escalateReason = null;
  if (!capReached) {
    if (verdict === "rethink") {
      escalate = true;
      escalateReason = "rethink-verdict";
    } else if (sensitivePaths && totalBlocking > 0) {
      escalate = true;
      escalateReason = "sensitive-paths-with-blocking";
    } else if (totalBlocking > 5) {
      escalate = true;
      escalateReason = ">5-blocking";
    } else if (diffTotal > 500) {
      escalate = true;
      escalateReason = "large-diff";
    }
  }

  const headSha =
    typeof prMeta.headRefOid === "string" && /^[0-9a-f]{7,64}$/.test(prMeta.headRefOid)
      ? prMeta.headRefOid
      : null;

  const view = {
    round,
    verdict,
    totalBlocking,
    totalAdvisory,
    ciFailing,
    lanes,
    escalate,
    escalateReason,
    capReached,
    degraded,
    headSha,
    prNumber: prMeta.number ?? null,
  };
  const stickyBody = renderSticky(view);

  return {
    ...view,
    sensitivePaths,
    diffTotal,
    existingStickyId: existingSticky ? existingSticky.id : null,
    stickyBody,
  };
}

// --- CLI wrapper (file / stdin I/O only — no network) ---------------------

function parseArgs(argv) {
  const files = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--round") opts.round = argv[++i];
    else if (a === "--head") opts.head = argv[++i];
    else if (a === "--pr") opts.pr = argv[++i];
    else if (a === "--additions") opts.additions = argv[++i];
    else if (a === "--deletions") opts.deletions = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--")) {
      /* ignore unknown flags */
    } else files.push(a);
  }
  return { files, opts };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    // eslint-disable-next-line no-console -- CLI help text; stdout is this tool's output channel
    console.log(
      "Usage: aggregate-verdict.mjs [--round N] [--head SHA] [--pr N] [--additions N] [--deletions N] <sentinel-file>...",
    );
    return;
  }

  // Each file (or, if none, all of stdin) is one sentinel-bearing "comment".
  // Synthetic ascending timestamps keep arg order = chronological order, so a
  // later file wins for a lane it shares with an earlier one.
  const comments = [];
  let ts = 0;
  for (const f of files) {
    comments.push({
      id: comments.length + 1,
      created_at: "t" + String(++ts).padStart(6, "0"),
      body: readFileSync(f, "utf8"),
    });
  }
  if (comments.length === 0) {
    const stdin = readStdin();
    if (stdin.trim()) comments.push({ id: 1, created_at: "t000001", body: stdin });
  }

  const prMeta = {
    number: opts.pr ? parseInt(opts.pr, 10) : null,
    headRefOid: opts.head,
    additions: opts.additions,
    deletions: opts.deletions,
  };
  const round = opts.round ? parseInt(opts.round, 10) : undefined;

  const result = aggregate({ comments, prMeta, round });

  // The sticky body goes to stdout (the agent can post it with `gh pr comment`
  // or `gh api ... --input -`); the machine-readable summary goes to stderr.
  process.stdout.write(result.stickyBody + "\n");
  process.stderr.write(
    "verdict=" +
      result.verdict +
      " round=" +
      result.round +
      " blocking=" +
      result.totalBlocking +
      " advisory=" +
      result.totalAdvisory +
      " degraded=" +
      result.degraded +
      " cap=" +
      result.capReached +
      " escalate=" +
      result.escalate +
      (result.escalateReason ? "(" + result.escalateReason + ")" : "") +
      "\n",
  );
}

// Run main() only when invoked directly (not when imported by the test file).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(
      "✗ aggregate-verdict failed: " + (err instanceof Error ? err.stack : String(err)),
    );
    process.exit(1);
  }
}
