/**
 * Unit tests for the plan-doc byte-budget guard (ADR-009).
 *
 * Every fixture is built at runtime (in memory, or in a mkdtemp dir for the
 * real-filesystem and CLI tests). The live docs are NOT read here: a test that
 * asserted "the real STATE.md is under budget" would be red on every branch
 * where STATE is mid-shrink; the CI step `Plan-doc byte budgets` runs the
 * script on the real tree and is that check.
 *
 * Boundary tests use LITERAL numbers (6144, 20480, 400), never `BUDGETS.x`.
 * A test written against the constant it guards passes when somebody raises
 * the constant. The `BUDGETS` pin below is the one place the literals meet it.
 *
 * Each test names the mutation that must turn it red.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUDGETS,
  checkBudgets,
  formatViolation,
  inspectBudgets,
  main,
  makeFsReader,
  MAX_LINE_ANNOTATIONS,
  parseArgs,
  safeAnnotationPath,
} from "./check-doc-budgets.mjs";

const SCRIPT = fileURLToPath(new URL("./check-doc-budgets.mjs", import.meta.url));

const HEADINGS = [
  "## CURRENT DIRECTION",
  "## NEXT SESSION",
  "## In-flight decisions",
  "## Blockers / Waiting on Sean",
];
const HEAD = HEADINGS.map((h) => `${h}\n`).join("");
// QUEUE's three section headings, exactly as the I-2 live format spells them.
const QUEUE_HEADINGS = ["## Active", "## Blocked", "## Recently done"];
const QUEUE_HEAD = QUEUE_HEADINGS.map((h) => `${h}\n`).join("");
const QL = QUEUE_HEADINGS.length; // lines QUEUE_HEAD occupies: a body's line N is file line N + QL
const STATE = "docs/STATE.md";
const QUEUE = "docs/QUEUE.md";

/** The I-2 live-format QUEUE (spec-queue-state-shrink.md, I-2), verbatim. It has no annotations to strip. */
const I2_TEMPLATE = [
  "# GoGo Travel — Work Queue",
  "",
  "> Live **index**: ≤20,480 bytes, every line ≤400 bytes (CI `check-doc-budgets`, [ADR-009](decisions/ADR-009-plan-doc-byte-budgets.md)).",
  "> One row per live item, no narrative. Order is **derived**: highest-priority `queued` row whose `depends_on` are all `done`. IDs never renumber.",
  "> Status enum ([ADR-002](decisions/ADR-002-status-enum-lock.md)): `queued · in-progress · blocked · done · deferred · cancelled`.",
  "> **Detail is read by ID, never whole files:** `grep -nE '^\\| B-30 +\\|' docs/QUEUE.md docs/history/QUEUE-*.md` · ID-less rows: `grep -nF '<handle>' docs/history/QUEUE-*.md`.",
  "> Not prettier-formatted on purpose (`.prettierignore`): table padding re-inflates this file 5×.",
  "",
  "## Active",
  "",
  "| ID | Title | Status | Priority | Depends on |",
  "| --- | --- | --- | --- | --- |",
  "| B-30 | Destination-tz both sides; un-wips `cross-tab-state` | queued | P1 | — |",
  "",
  "## Blocked",
  "",
  "| ID | Title | Status | Priority | Blocker |",
  "| --- | --- | --- | --- | --- |",
  "",
  "## Recently done",
  "",
  "| ID | Title | Done |",
  "| --- | --- | --- |",
  "",
].join("\n");

/** A STATE fixture of EXACTLY `total` bytes: all four headings, then one long filler line. */
function stateOf(total, filler = "x") {
  const room = total - Buffer.byteLength(HEAD);
  assert.ok(room >= 0, `fixture too small: ${total}`);
  const unit = Buffer.byteLength(filler);
  const out = HEAD + filler.repeat(Math.floor(room / unit)) + "x".repeat(room % unit);
  assert.equal(Buffer.byteLength(out), total, "fixture must be exactly the requested bytes");
  return out;
}

/** A QUEUE fixture of EXACTLY `total` bytes: the three headings, then filler lines of at most 400 B (terminator excluded). */
function queueOf(total) {
  let left = total - Buffer.byteLength(QUEUE_HEAD);
  assert.ok(left >= 0, `fixture too small: ${total}`);
  let out = QUEUE_HEAD;
  while (left > 400) {
    out += `${"x".repeat(399)}\n`;
    left -= 400;
  }
  out += "x".repeat(left);
  assert.equal(Buffer.byteLength(out), total, "fixture must be exactly the requested bytes");
  return out;
}

const cleanFiles = () => ({
  [STATE]: HEAD,
  [QUEUE]: `${QUEUE_HEAD}| B-1 | a row | queued | P1 | — |\n`,
});
const readerFor = (files) => (path) => files[path];
const kindsOf = (files) => checkBudgets(BUDGETS, readerFor(files)).map((v) => v.kind);

/** Run `main` with console captured; returns the exit code and what it printed. */
function runMain(options) {
  const error = mock.method(console, "error", () => {});
  const warn = mock.method(console, "warn", () => {});
  try {
    const code = main(options);
    return {
      code,
      errors: error.mock.calls.map((c) => c.arguments.join(" ")),
      warns: warn.mock.calls.map((c) => c.arguments.join(" ")),
    };
  } finally {
    error.mock.restore();
    warn.mock.restore();
  }
}

/** A throwaway repo root with `docs/` and the given files. */
function withRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "doc-budgets-"));
  try {
    mkdirSync(join(root, "docs"));
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

// ---------------------------------------------------------------------------
// The numbers themselves
// ---------------------------------------------------------------------------

test("BUDGETS are exactly the ADR-009 numbers — raising one means amending the ADR", () => {
  // Mutation: change 6144, 20480 or 400, or drop/reword a heading (STATE's or QUEUE's) -> red.
  assert.deepEqual(BUDGETS, [
    { path: "docs/STATE.md", maxBytes: 6144, requiredHeadings: HEADINGS },
    {
      path: "docs/QUEUE.md",
      maxBytes: 20480,
      maxLineBytes: 400,
      requiredHeadings: QUEUE_HEADINGS,
    },
  ]);
});

// ---------------------------------------------------------------------------
// File-size boundary
// ---------------------------------------------------------------------------

test("a clean pair passes", () => {
  assert.deepEqual(checkBudgets(BUDGETS, readerFor(cleanFiles())), []);
});

test("STATE at exactly 6144 B passes; 6145 B fails with the measured and allowed bytes", () => {
  // Mutation: `>` -> `>=` makes the first assertion red; `>` -> `> 6145` the second.
  assert.deepEqual(kindsOf({ ...cleanFiles(), [STATE]: stateOf(6144) }), []);
  assert.deepEqual(checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: stateOf(6145) })), [
    { path: STATE, kind: "bytes", actual: 6145, limit: 6144 },
  ]);
});

test("QUEUE at exactly 20480 B passes; 20481 B fails", () => {
  // Mutation: `>` -> `>=` on the file cap -> the first assertion goes red.
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: queueOf(20480) }), []);
  assert.deepEqual(checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: queueOf(20481) })), [
    { path: QUEUE, kind: "bytes", actual: 20481, limit: 20480 },
  ]);
});

test("LONG-LINE PIN: 7000 B of STATE in one line fails on bytes (a line count cannot see it)", () => {
  // Valid headings + one 7000-B-total file: ONLY the byte cap can object.
  // Mutation: count lines (or any proxy) instead of bytes -> red.
  const files = { ...cleanFiles(), [STATE]: stateOf(7000) };
  assert.equal(files[STATE].split("\n").length, 5, "four heading lines + one filler line");
  assert.deepEqual(checkBudgets(BUDGETS, readerFor(files)), [
    { path: STATE, kind: "bytes", actual: 7000, limit: 6144 },
  ]);
});

test("LONG-LINE PIN (done-condition shape): a bare 1-line 7000 B file fails on bytes", () => {
  const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: "x".repeat(7000) }));
  assert.deepEqual(found[0], { path: STATE, kind: "bytes", actual: 7000, limit: 6144 });
});

test("a single 25,000 B QUEUE line fails BOTH caps (file and line)", () => {
  const text = `${QUEUE_HEAD}${"x".repeat(25000)}`;
  const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: text }));
  assert.deepEqual(
    found.map((v) => [v.kind, v.actual, v.limit]),
    [
      ["bytes", Buffer.byteLength(text), 20480],
      ["line", 25000, 400],
    ],
  );
});

// ---------------------------------------------------------------------------
// Per-line cap (QUEUE)
// ---------------------------------------------------------------------------

test("a QUEUE line of exactly 400 B passes; 401 B fails, with its 1-based line number", () => {
  // The file stays far under 20 KB, so only the per-line cap can object.
  // Mutation: `>` -> `>=` -> the 400 case goes red; drop the line check -> the 401 case does.
  const at = `${QUEUE_HEAD}| a |\n${"x".repeat(400)}\n| b |\n`;
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: at }), []);
  const over = `${QUEUE_HEAD}| a |\n| b |\n${"x".repeat(401)}\n| c |\n`;
  assert.deepEqual(checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: over })), [
    { path: QUEUE, kind: "line", actual: 401, limit: 400, line: 3 + QL },
  ]);
});

test("the per-line cap applies to QUEUE only — STATE has no line cap", () => {
  const files = { ...cleanFiles(), [STATE]: `${HEAD}${"x".repeat(3000)}\n` };
  assert.deepEqual(kindsOf(files), []);
});

test("the line terminator is not counted, but a CR before it is", () => {
  const lf = `${QUEUE_HEAD}${"x".repeat(400)}\n`;
  const crlf = `${QUEUE_HEAD}${"x".repeat(400)}\r\n`;
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: lf }), []);
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: crlf }), ["line"]);
});

test("a final line with no trailing newline is still measured", () => {
  const found = checkBudgets(
    BUDGETS,
    readerFor({ ...cleanFiles(), [QUEUE]: `${QUEUE_HEAD}| a |\n${"x".repeat(401)}` }),
  );
  assert.deepEqual(found, [{ path: QUEUE, kind: "line", actual: 401, limit: 400, line: 2 + QL }]);
});

test("every offending line is reported, not just the first", () => {
  const rows = [401, 10, 450, 10, 999].map((n) => "x".repeat(n)).join("\n");
  const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: QUEUE_HEAD + rows }));
  assert.deepEqual(
    found.map((v) => [v.line, v.actual]),
    [
      [1 + QL, 401],
      [3 + QL, 450],
      [5 + QL, 999],
    ],
  );
});

// ---------------------------------------------------------------------------
// Bytes, not characters
// ---------------------------------------------------------------------------

test("MULTIBYTE: 2,100 x U+2460 is 2,100 chars but 6,300 B — it fails on bytes", () => {
  // Same shape as the spec: chars are far under 6144, bytes are over.
  // Mutation: measure `.length` of the decoded text instead of bytes -> red.
  const text = stateOf(Buffer.byteLength(HEAD) + 6300, "①");
  assert.ok(text.length < 6144, `chars ${text.length} must be under the cap`);
  assert.deepEqual(checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: text })), [
    { path: STATE, kind: "bytes", actual: Buffer.byteLength(HEAD) + 6300, limit: 6144 },
  ]);
  const bare = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: "①".repeat(2100) }));
  assert.deepEqual(bare[0], { path: STATE, kind: "bytes", actual: 6300, limit: 6144 });
});

test("MULTIBYTE: a file of multibyte chars that is EXACTLY 6144 B passes", () => {
  // 3-byte chars right up to the edge: the boundary is in bytes, both sides.
  assert.deepEqual(kindsOf({ ...cleanFiles(), [STATE]: stateOf(6144, "①") }), []);
  assert.deepEqual(kindsOf({ ...cleanFiles(), [STATE]: stateOf(6145, "①") }), ["bytes"]);
});

test("MULTIBYTE per-line: 134 x U+2460 is 134 chars but 402 B — fails; 133 + 1 ASCII = 400 B passes", () => {
  // Mutation: measure the line's decoded `.length` -> the first assertion goes red.
  const over = `${"①".repeat(134)}\n`;
  assert.ok(over.length < 400);
  assert.deepEqual(
    checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: QUEUE_HEAD + over })),
    [{ path: QUEUE, kind: "line", actual: 402, limit: 400, line: 1 + QL }],
  );
  const at = `${"①".repeat(133)}x\n`;
  assert.equal(Buffer.byteLength(at), 401, "400 content bytes + newline");
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: QUEUE_HEAD + at }), []);
});

test("MULTIBYTE: 4-byte emoji (2 UTF-16 units) — 100 of them is 400 B and passes; 101 fails", () => {
  const emoji = "\u{1F600}";
  assert.equal(emoji.length, 2);
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: QUEUE_HEAD + emoji.repeat(100) }), []);
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: QUEUE_HEAD + emoji.repeat(101) }), ["line"]);
});

test("RAW BYTES: invalid UTF-8 is counted as the bytes it is, not as U+FFFD replacements", () => {
  // 400 x 0xFF decodes to 400 replacement chars = 1,200 B as text; on disk it is 400 B.
  // Mutation: size a line via `Buffer.byteLength(buffer.toString())` -> the first case goes red.
  const head = Buffer.from(QUEUE_HEAD);
  const bad = Buffer.concat([head, Buffer.alloc(400, 0xff)]);
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: bad }), []);
  const over = Buffer.concat([head, Buffer.alloc(401, 0xff)]);
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: over }), ["line"]);
});

// ---------------------------------------------------------------------------
// Empty / missing files
// ---------------------------------------------------------------------------

test("EMPTY: an empty STATE fails on all four headings (and not on bytes)", () => {
  const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: "" }));
  assert.deepEqual(
    found.map((v) => [v.kind, v.heading]),
    HEADINGS.map((h) => ["heading", h]),
  );
});

test("EMPTY: an empty QUEUE now FAILS on its three headings (and not on bytes) — string and Buffer alike", () => {
  // Was "an empty QUEUE passes (no lower bound)"; QUEUE gained required headings, so it fails.
  // Mutation: drop QUEUE's requiredHeadings from BUDGETS -> both cases go red.
  for (const empty of ["", Buffer.alloc(0)]) {
    const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: empty }));
    assert.deepEqual(
      found.map((v) => [v.path, v.kind, v.heading]),
      QUEUE_HEADINGS.map((h) => [QUEUE, "heading", h]),
    );
  }
});

test("MISSING: a file the reader cannot find is `missing`, for null and undefined alike", () => {
  // Mutation: skip a missing file silently (`continue` without pushing) -> red.
  for (const absent of [null, undefined]) {
    const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: absent }));
    assert.deepEqual(found, [{ path: STATE, kind: "missing", actual: null, limit: null }]);
  }
  const both = checkBudgets(BUDGETS, readerFor({}));
  assert.deepEqual(
    both.map((v) => [v.path, v.kind]),
    [
      [STATE, "missing"],
      [QUEUE, "missing"],
    ],
  );
});

// ---------------------------------------------------------------------------
// Required headings
// ---------------------------------------------------------------------------

test("each required heading is checked on its own", () => {
  // Mutation: drop the heading check, or stop after the first miss -> red.
  for (const missing of HEADINGS) {
    const text = HEADINGS.filter((h) => h !== missing)
      .map((h) => `${h}\n`)
      .join("");
    const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: text }));
    assert.deepEqual(found, [
      { path: STATE, kind: "heading", actual: 0, limit: 1, heading: missing },
    ]);
  }
});

test("a heading must be a WHOLE line: trailing comment, leading space, substring and case all fail", () => {
  // `grep -cxF` semantics. Mutation: `.equals` -> `.includes` -> red on every variant.
  const variants = [
    "## NEXT SESSION  <!-- ≤1,400 B -->",
    "## NEXT SESSION ",
    " ## NEXT SESSION",
    "see ## NEXT SESSION below",
    "## next session",
    "### NEXT SESSION",
  ];
  for (const variant of variants) {
    const text = HEAD.replace("## NEXT SESSION", variant);
    const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [STATE]: text }));
    assert.deepEqual(
      found.map((v) => v.heading),
      ["## NEXT SESSION"],
      JSON.stringify(variant),
    );
  }
});

test("headings may appear anywhere, in any order, and more than once", () => {
  const text = `intro\n${[...HEADINGS].reverse().join("\n\ntext\n")}\n${HEADINGS[0]}\n`;
  assert.deepEqual(kindsOf({ ...cleanFiles(), [STATE]: text }), []);
});

test("QUEUE: each required heading is checked on its own", () => {
  // Mutation: remove ANY ONE heading from QUEUE's requiredHeadings in BUDGETS -> that iteration is red.
  for (const missing of QUEUE_HEADINGS) {
    const text = QUEUE_HEADINGS.filter((h) => h !== missing)
      .map((h) => `${h}\n`)
      .join("");
    const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: text }));
    assert.deepEqual(found, [
      { path: QUEUE, kind: "heading", actual: 0, limit: 1, heading: missing },
    ]);
  }
});

test("QUEUE: a heading must be a WHOLE line — trailing text, leading space, substring, case and level all fail", () => {
  for (const [original, variants] of [
    [
      "## Active",
      [
        "## Active  <!-- x -->",
        "## Active ",
        " ## Active",
        "## Active items",
        "## active",
        "### Active",
      ],
    ],
    [
      "## Blocked",
      ["## Blocked (0)", "## Blocked ", " ## Blocked", "see ## Blocked below", "## BLOCKED"],
    ],
    [
      "## Recently done",
      ["## Recently done ", "## Recently Done", "## Recently done (5)", "#### Recently done"],
    ],
  ]) {
    for (const variant of variants) {
      const text = QUEUE_HEAD.replace(original, variant);
      const found = checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: text }));
      assert.deepEqual(
        found.map((v) => v.heading),
        [original],
        JSON.stringify(variant),
      );
    }
  }
});

test("CRLF: a heading whose line ends \\r\\n is not a whole-line match — STATE and QUEUE agree", () => {
  // The CR is part of the line's bytes (see the terminator test), so `## Active\r` is not `## Active`.
  // A CRLF-checked-out file therefore fails here, same as on STATE, instead of passing locally on one OS.
  // Mutation: strip a trailing \r before comparing -> every iteration goes red.
  for (const [path, headings, others] of [
    [STATE, HEADINGS, { [QUEUE]: cleanFiles()[QUEUE] }],
    [QUEUE, QUEUE_HEADINGS, { [STATE]: HEAD }],
  ]) {
    const crlf = headings.map((h) => `${h}\r\n`).join("");
    const found = checkBudgets(BUDGETS, readerFor({ ...others, [path]: crlf }));
    assert.deepEqual(
      found.map((v) => [v.path, v.kind, v.heading]),
      headings.map((h) => [path, "heading", h]),
      path,
    );
    for (const headingIndex of headings.keys()) {
      const mixed = headings.map((h, i) => (i === headingIndex ? `${h}\r\n` : `${h}\n`)).join("");
      const one = checkBudgets(BUDGETS, readerFor({ ...others, [path]: mixed }));
      assert.deepEqual(
        one.map((v) => v.heading),
        [headings[headingIndex]],
        `${path}: only line ${headingIndex} is CRLF`,
      );
    }
  }
});

test("QUEUE headings may appear anywhere, in any order, and more than once", () => {
  const text = `intro\n${[...QUEUE_HEADINGS].reverse().join("\n\n| row |\n")}\n${QUEUE_HEADINGS[0]}\n`;
  assert.deepEqual(kindsOf({ ...cleanFiles(), [QUEUE]: text }), []);
});

test("the I-2 template QUEUE (the live format the spec shows) passes both budgets", () => {
  // Mutation: reword a heading in the template or in BUDGETS, or tighten a cap under it -> red.
  assert.deepEqual(checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: I2_TEMPLATE })), []);
  const { code, warns } = runMain({ read: readerFor({ ...cleanFiles(), [QUEUE]: I2_TEMPLATE }) });
  assert.equal(code, 0);
  assert.match(warns[0], /docs\/QUEUE\.md \d+\/20480 B\.$/);
});

test("the I-2 template QUEUE with any one section heading removed fails on exactly that heading", () => {
  for (const heading of QUEUE_HEADINGS) {
    const text = I2_TEMPLATE.split("\n")
      .filter((line) => line !== heading)
      .join("\n");
    assert.notEqual(text, I2_TEMPLATE);
    assert.deepEqual(
      checkBudgets(BUDGETS, readerFor({ ...cleanFiles(), [QUEUE]: text })).map((v) => v.heading),
      [heading],
    );
  }
});

// ---------------------------------------------------------------------------
// Exit contract + annotations
// ---------------------------------------------------------------------------

test("main(): EXIT CONTRACT — 0 on a clean pair, with the OK line", () => {
  const { code, errors, warns } = runMain({ read: readerFor(cleanFiles()) });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(warns.length, 1);
  assert.match(
    warns[0],
    /^OK — plan-doc budgets: docs\/STATE\.md \d+\/6144 B, docs\/QUEUE\.md \d+\/20480 B\.$/,
  );
});

test("main(): the OK line reports measured/limit at the boundary", () => {
  const files = { [STATE]: stateOf(6144), [QUEUE]: queueOf(20480) };
  const { code, warns } = runMain({ read: readerFor(files) });
  assert.equal(code, 0);
  assert.deepEqual(warns, [
    "OK — plan-doc budgets: docs/STATE.md 6144/6144 B, docs/QUEUE.md 20480/20480 B.",
  ]);
});

test("main(): EXIT CONTRACT — 1 on any single violation, whichever kind", () => {
  // The only thing CI consumes. Mutation: `return 1` -> `return 0` -> every case red.
  const cases = {
    bytes: { [STATE]: stateOf(6145) },
    line: { [QUEUE]: QUEUE_HEAD + "x".repeat(401) },
    heading: { [STATE]: HEAD.replace("## NEXT SESSION\n", "") },
    queueHeading: { [QUEUE]: QUEUE_HEAD.replace("## Blocked\n", "") },
    missing: { [STATE]: undefined },
  };
  for (const [kind, patch] of Object.entries(cases)) {
    const { code, errors, warns } = runMain({ read: readerFor({ ...cleanFiles(), ...patch }) });
    assert.equal(code, 1, kind);
    assert.ok(errors.length >= 1, kind);
    assert.deepEqual(warns, [], `${kind}: no OK line on a failing run`);
  }
});

test("annotation text: bytes, line, heading and missing", () => {
  const text = (files) => runMain({ read: readerFor({ ...cleanFiles(), ...files }) }).errors;
  assert.match(
    text({ [STATE]: stateOf(7000) })[0],
    /^::error file=docs\/STATE\.md::7000 bytes > budget 6144 \(ADR-009\)\. .+/,
  );
  assert.match(
    text({ [QUEUE]: `${QUEUE_HEAD}a\nb\n${"x".repeat(401)}\n` })[0],
    /^::error file=docs\/QUEUE\.md,line=6::401 bytes > per-line cap 400 \(ADR-009\)\. /,
  );
  assert.match(
    text({ [QUEUE]: QUEUE_HEAD.replace("## Blocked\n", "") })[0],
    /^::error file=docs\/QUEUE\.md::missing required heading "## Blocked" \(ADR-009\)\./,
  );
  assert.match(
    text({ [STATE]: HEAD.replace("## NEXT SESSION\n", "") })[0],
    /^::error file=docs\/STATE\.md::missing required heading "## NEXT SESSION" \(ADR-009\)\./,
  );
  assert.match(
    text({ [STATE]: null })[0],
    /^::error file=docs\/STATE\.md::file is missing or not a regular file \(ADR-009\)\./,
  );
});

test("annotation cap: only 10 line errors per file are printed, the rest are summarised — exit stays 1", () => {
  // Mutation: delete the cap -> 25 annotations -> red.
  const rows = QUEUE_HEAD + Array.from({ length: 25 }, () => "x".repeat(401)).join("\n");
  const { code, errors } = runMain({ read: readerFor({ ...cleanFiles(), [QUEUE]: rows }) });
  assert.equal(code, 1);
  assert.equal(MAX_LINE_ANNOTATIONS, 10);
  const annotated = errors.filter((e) => e.startsWith("::error file=docs/QUEUE.md,line="));
  assert.equal(annotated.length, 10);
  assert.deepEqual(
    annotated.map((e) => Number(/line=(\d+)::/.exec(e)[1])),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => n + QL),
  );
  assert.equal(
    errors.at(-1),
    "... and 15 more line(s) over the per-line cap in docs/QUEUE.md (not annotated).",
  );
  assert.equal(errors.length, 11);
});

test("annotation cap: a size violation is never swallowed by the line cap", () => {
  const rows = QUEUE_HEAD + Array.from({ length: 60 }, () => "x".repeat(401)).join("\n");
  const { errors } = runMain({ read: readerFor({ ...cleanFiles(), [QUEUE]: rows }) });
  assert.ok(errors.some((e) => e.includes("bytes > budget 20480")));
});

test("safeAnnotationPath: a crafted path cannot emit its own workflow command", () => {
  const safe = safeAnnotationPath("docs/a\n::stop-commands::deadbeef\r\nb.md");
  assert.equal(safe, "docs/a __stop-commands__deadbeef b.md");
  assert.equal(safeAnnotationPath("docs/STATE.md"), "docs/STATE.md");
});

test("main(): a hostile budget path reaches the log sanitised (formatViolation uses safeAnnotationPath)", () => {
  // Mutation: print `violation.path` raw -> a second `::` pair and a newline appear -> red.
  const budgets = [{ path: "docs/a\n::stop-commands::x.md", maxBytes: 10 }];
  const { errors } = runMain({ budgets, read: () => "x".repeat(11) });
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes("\n"));
  assert.equal(errors[0].match(/::/g).length, 2, errors[0]);
});

test("formatViolation: every kind starts as a workflow error annotation", () => {
  for (const kind of ["missing", "bytes", "line", "heading"]) {
    const message = formatViolation({
      path: STATE,
      kind,
      actual: 1,
      limit: 1,
      line: 2,
      heading: "## X",
    });
    assert.ok(message.startsWith(`::error file=${STATE}`), message);
    assert.ok(message.includes("ADR-009"), message);
  }
});

test("fix hints: QUEUE names the full I-4 rotate invocation — a bare `rotate` exits 2", () => {
  // I-4: `rotate` needs --queue and --archive; with neither it is a usage error (exit 2).
  // Mutation: restore the bare `node scripts/queue-rows.mjs rotate` hint -> red.
  for (const kind of ["bytes", "line"]) {
    const message = formatViolation({ path: QUEUE, kind, actual: 20481, limit: 20480, line: 1 });
    if (kind === "bytes") {
      assert.ok(
        message.includes(
          "node scripts/queue-rows.mjs rotate --queue docs/QUEUE.md --archive docs/history/QUEUE-$(date -u +%F).md",
        ),
        message,
      );
      assert.doesNotMatch(message, /rotate`/, "no bare `rotate` (no arguments)");
      // /tidy-docs does not run the rotation, so the hint must not claim it does.
      // Mutation: restore "; /tidy-docs runs it" to the QUEUE hint -> red.
      assert.match(message, /--dry-run previews\) and keep detail/);
      assert.doesNotMatch(message, /tidy-docs/, "the QUEUE hint must not point at /tidy-docs");
    }
  }
});

test("fix hints: STATE is described as injected at INTERACTIVE session start, never 'every session'", () => {
  // O-QS8/O-QS10: hooks are off in loop sessions, which read STATE explicitly.
  // Mutation: restore "the injected session brief" / any 'every session' claim -> red.
  const message = formatViolation({ path: STATE, kind: "bytes", actual: 6145, limit: 6144 });
  assert.match(message, /interactive session start/);
  assert.doesNotMatch(message, /every session/i);
});

test("inspectBudgets: sizes list every file that exists, with its limit", () => {
  const files = { [STATE]: stateOf(100), [QUEUE]: undefined };
  const { sizes } = inspectBudgets(BUDGETS, readerFor(files));
  assert.deepEqual(sizes, [{ path: STATE, bytes: 100, maxBytes: 6144 }]);
});

// ---------------------------------------------------------------------------
// Real filesystem + CLI (prod-shaped: real reads, real process exit codes)
// ---------------------------------------------------------------------------

test("makeFsReader: file -> bytes; absent / not-a-directory / dir / device symlink / dangling -> null", () => {
  withRoot({ "docs/STATE.md": "héllo" }, (root) => {
    const read = makeFsReader(root);
    assert.equal(read("docs/STATE.md").byteLength, 6, "é is 2 bytes");
    assert.equal(read("docs/QUEUE.md"), null, "absent");
    assert.equal(read("docs/STATE.md/child.md"), null, "parent is a file (ENOTDIR)");
    assert.equal(read("docs"), null, "a directory is not a doc");
    symlinkSync("/dev/zero", join(root, "docs/ZERO.md"));
    assert.equal(read("docs/ZERO.md"), null, "a device must not be read (unbounded)");
    symlinkSync(join(root, "nope"), join(root, "docs/DANGLING.md"));
    assert.equal(read("docs/DANGLING.md"), null, "dangling symlink");
  });
});

test("main({ root }): a directory standing where STATE.md should be reads as missing, not a crash", () => {
  withRoot({ "docs/QUEUE.md": `${QUEUE_HEAD}| a |\n` }, (root) => {
    mkdirSync(join(root, "docs/STATE.md"));
    const { code, errors } = runMain({ root });
    assert.equal(code, 1);
    assert.match(errors[0], /^::error file=docs\/STATE\.md::file is missing or not a regular file/);
  });
});

test("CLI: the done-condition fixture — a 7000 B STATE exits 1 with the annotation on stderr", () => {
  const files = { "docs/STATE.md": "x".repeat(7000), "docs/QUEUE.md": `${QUEUE_HEAD}| a |\n` };
  withRoot(files, (root) => {
    const result = cli("--root", root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^::error file=docs\/STATE\.md::7000 bytes > budget 6144 \(ADR-009\)\./m,
    );
  });
});

test("CLI: a clean root exits 0 and prints the OK line; --root=<dir> works too", () => {
  const queue = `${QUEUE_HEAD}| a |\n`;
  withRoot({ "docs/STATE.md": HEAD, "docs/QUEUE.md": queue }, (root) => {
    for (const args of [["--root", root], [`--root=${root}`]]) {
      const result = cli(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stderr,
        new RegExp(
          `^OK — plan-doc budgets: docs/STATE\\.md ${Buffer.byteLength(HEAD)}/6144 B, docs/QUEUE\\.md ${Buffer.byteLength(queue)}/20480 B\\.$`,
          "m",
        ),
      );
    }
  });
});

test("CLI: files on disk are measured in BYTES (a multibyte STATE just over the cap fails)", () => {
  const over = HEAD + "①".repeat(2020); // 90 + 6,060 = 6,150 B (6 over), ~2,110 chars
  withRoot({ "docs/STATE.md": over, "docs/QUEUE.md": QUEUE_HEAD }, (root) => {
    const result = cli("--root", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${Buffer.byteLength(over)} bytes > budget 6144`));
  });
});

test("CLI: an empty root (both files absent) exits 1 with two `missing` errors", () => {
  withRoot({}, (root) => {
    const result = cli("--root", root);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.match(/file is missing or not a regular file/g).length, 2);
  });
});

test("CLI: a bad --root is a usage error (exit 2), never a silent run on the default root", () => {
  for (const args of [["--root"], ["--root="], ["--root", "--other"], ["--bogus"], ["stray"]]) {
    const result = cli(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /usage: node \.github\/scripts\/check-doc-budgets\.mjs/);
  }
});

test("parseArgs: no args -> default root; a relative --root is resolved", () => {
  assert.deepEqual(parseArgs([]), {});
  assert.equal(parseArgs(["--root", "."]).root, process.cwd());
  assert.throws(() => parseArgs(["--root"]), /needs a directory/);
  assert.throws(() => parseArgs(["-r", "x"]), /unknown argument/);
});

test("the default root is the repo root: no --root, run from another cwd, finds docs/ by script location", () => {
  // Only asserts WHERE it looks (the message names docs/STATE.md as measured or
  // over budget), never that the live docs pass — they are mid-shrink on this branch.
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: tmpdir() });
  assert.ok([0, 1].includes(result.status), `status ${result.status}: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /file is missing or not a regular file/);
});
