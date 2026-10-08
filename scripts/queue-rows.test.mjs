#!/usr/bin/env node
/**
 * scripts/queue-rows.test.mjs — QS-T2
 *
 * Tests for `scripts/queue-rows.mjs` (normalize / verify / rotate / residual), the tool that
 * makes the QUEUE.md rotation lossless and checkable. Runs under the existing root `pnpm test`
 * glob (`node --test scripts/*.test.mjs`); zero deps, no build.
 *
 *   node --test scripts/queue-rows.test.mjs
 *
 * Fixtures are built in memory or in a per-test `mkdtemp` dir. Where a pin's falsification is not
 * obvious from its name, the comment next to it says what change makes it red.
 *
 * The "prod-shaped" block runs against the REAL `docs/QUEUE.md`. It asserts only invariants that
 * hold for the 750 KB padded file AND for the unpadded ≤20 KB index QS-T4 replaces it with, so
 * this suite stays green across that rewrite.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  dataRows,
  handleOf,
  normalize,
  parseQueue,
  planRotation,
  residualKeywords,
  rotateFiles,
  run,
  splitCells,
  splitLines,
  verifyLossless,
} from "./queue-rows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "queue-rows.mjs");
const REAL_QUEUE = join(HERE, "..", "docs", "QUEUE.md");
const MARKER = "<!-- verbatim snapshot below -->";
const DATE = "2026-10-06";

// --- fixtures ----------------------------------------------------------------

const tmpRoots = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "queue-rows-"));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const join$ = (...l) => l.join("\n") + "\n";

/** A prettier-padded queue in the repo's real shape (padding, `—` rows, three sections). */
const BASE = join$(
  "# GoGo Travel — Work Queue",
  "",
  "> Live pulse. A | pipe in prose stays | as is.",
  "",
  "## Active",
  "",
  "| ID    | Title                      | Status      | Priority | Depends on |",
  "| ----- | -------------------------- | ----------- | -------- | ---------- |",
  "| T-1.1 | **Alpha** live thing       | queued      | P1       | —          |",
  "| B-2   | **Bravo** finished thing   | done        | P2       | —          |",
  "| —     | **Charlie handle** unlabeled | in-progress | P3       | —          |",
  "| B-3   | **Delta** cancelled thing  | cancelled   | P3       | —          |",
  "| B-5   | **Echo** parked            | DEFERRED    | P4       | —          |",
  "",
  "## Blocked",
  "",
  "| ID  | Title              | Status  | Priority | Blocker |",
  "| --- | ------------------ | ------- | -------- | ------- |",
  "| B-4 | **Foxtrot** stuck  | blocked | P1       | Sean    |",
  "| —   | **Golf done**      | done    | P2       | —       |",
  "",
  "## Recently done",
  "",
  "| ID  | Title         | Done       |",
  "| --- | ------------- | ---------- |",
  "| T-9 | **Nine** one  | 2026-01-09 |",
  "| T-8 | **Eight** two | 2026-01-08 |",
  "| T-7 | **Seven** 3   | 2026-01-07 |",
  "| —   | **Six** four  | 2026-01-06 |",
);

const lineNo = (text, needle) => {
  const i = splitLines(text).findIndex((l) => l.text.includes(needle));
  assert.notEqual(i, -1, `fixture has no line containing ${needle}`);
  return i + 1;
};
const without = (text, needles) => {
  const drop = new Set(needles.map((n) => lineNo(text, n)));
  return splitLines(text)
    .filter((_, i) => !drop.has(i + 1))
    .map((l) => l.text + l.eol)
    .join("");
};
/** In-process CLI: same dispatch the script uses, minus a node startup per call. */
const cli = (args) => {
  const r = run(args);
  return { status: r.code, stdout: r.stdout, stderr: r.stderr };
};
/** Real process: `node scripts/queue-rows.mjs …` (exit codes, stdout/stderr streams, entry guard). */
const proc = (args, script = SCRIPT) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

/** A queue + archive path in a fresh dir. */
function sandbox(queueText = BASE) {
  const dir = tmp();
  const queue = join(dir, "QUEUE.md");
  const archive = join(dir, "QUEUE-2026-10-06.md");
  writeFileSync(queue, queueText);
  return { dir, queue, archive };
}
const bytes = (p) => readFileSync(p);

// --- splitLines / splitCells ---------------------------------------------------

describe("splitLines", () => {
  it("keeps each line's own terminator (LF, CRLF, none)", () => {
    assert.deepEqual(splitLines("a\nb\r\nc"), [
      { text: "a", eol: "\n" },
      { text: "b", eol: "\r\n" },
      { text: "c", eol: "" },
    ]);
  });
  it("empty text has no lines; a lone newline is one empty line", () => {
    assert.deepEqual(splitLines(""), []);
    assert.deepEqual(splitLines("\n"), [{ text: "", eol: "\n" }]);
  });
  it("a trailing newline does not invent a final empty line", () => {
    assert.equal(splitLines("a\n").length, 1);
    assert.equal(splitLines("a\n\n").length, 2);
  });
});

describe("splitCells", () => {
  it("splits and trims spaces/tabs only", () => {
    assert.deepEqual(splitCells("|  a  |\tb\t|c|"), ["a", "b", "c"]);
  });
  it("a pipe preceded by a backslash is cell content, not a separator", () => {
    assert.deepEqual(splitCells("| a \\| b | c |"), ["a \\| b", "c"]);
  });
  it("spec-literal: `\\\\|` is also escaped (matches cmark-gfm: the second backslash escapes)", () => {
    assert.deepEqual(splitCells("| a \\\\| b |"), ["a \\\\| b"]);
  });
  it("empty cells are kept; only the empty first/last segments are dropped", () => {
    assert.deepEqual(splitCells("| a |  | c |  |"), ["a", "", "c", ""]);
    assert.deepEqual(splitCells("||"), [""]);
  });
  it("tolerates leading indent, trailing spaces and a missing closing pipe", () => {
    assert.deepEqual(splitCells("  | a | b |   "), ["a", "b"]);
    assert.deepEqual(splitCells("| a | b"), ["a", "b"]);
  });
  it("does not treat NBSP as padding (content, not prettier padding)", () => {
    assert.deepEqual(splitCells("| \u00a0a\u00a0 |"), ["\u00a0a\u00a0"]);
  });
});

// --- normalize -------------------------------------------------------------------

describe("normalize", () => {
  it("strips cell padding", () => {
    assert.equal(normalize("| a   | b  |\n"), "| a | b |\n");
  });
  it("keeps escaped pipes inside cells", () => {
    assert.equal(normalize("| a \\| b   | c |\n"), "| a \\| b | c |\n");
  });
  it("normalizes separator rows to `---` (alignment colons dropped, same cell count)", () => {
    assert.equal(normalize("| :---: | ------ | -: |\n"), "| --- | --- | --- |\n");
  });
  it("a data row that merely contains dashes is still data, not a separator", () => {
    assert.equal(normalize("| --- | x |\n"), "| --- | x |\n");
    assert.equal(parseQueue("## Active\n| --- | x |\n").rows[0].kind, "data");
  });
  it("non-table lines pass through byte-identical", () => {
    for (const l of [
      "",
      "# H",
      "> | quoted | row |",
      "text | with | pipes",
      "   indented text   ",
      "```",
      "- | bullet",
      "|", // a lone pipe has zero cells: not a row
      "|   ",
    ]) {
      assert.equal(normalize(l + "\n"), l + "\n", JSON.stringify(l));
    }
  });
  it("is idempotent", () => {
    for (const t of [
      BASE,
      "| a | b \\|\n",
      "| a | b\n",
      "|\ta\t|  b  |  \n",
      "| :--: |\n",
      "||\n",
      "| a |\r\n| b |",
    ]) {
      const once = normalize(t);
      assert.equal(normalize(once), once, JSON.stringify(t));
    }
  });
  it("empty cells survive (and stay empty cells)", () => {
    assert.equal(normalize("| a |  | c |\n"), "| a |  | c |\n");
    assert.equal(normalize("|  | x |\n"), "|  | x |\n");
    assert.equal(normalize("| a |   |\n"), "| a |  |\n");
  });
  it("trims tabs but never NBSP, and keeps internal runs of spaces", () => {
    assert.equal(normalize("|\ta\t|  b  |\n"), "| a | b |\n");
    assert.equal(normalize("| \u00a0a |\n"), "| \u00a0a |\n");
    assert.equal(normalize("| a    b |   c |\n"), "| a    b | c |\n");
  });
  it("preserves CRLF per line instead of treating \\r as a cell", () => {
    const out = normalize("| a  | b |\r\n| --- | --- |\r\ntext\r\n| c | d |\n");
    assert.equal(out, "| a | b |\r\n| --- | --- |\r\ntext\r\n| c | d |\n");
    assert.equal(parseQueue("## Active\r\n| a | b |\r\n").rows[0].cells.length, 2);
  });
  it("preserves a missing trailing newline", () => {
    assert.equal(normalize("| a  | b |"), "| a | b |");
    assert.equal(normalize("text"), "text");
    assert.equal(normalize(""), "");
    assert.equal(normalize("\n"), "\n");
  });
  it("closes a row with no closing pipe and drops trailing space after the closing pipe", () => {
    assert.equal(normalize("| a | b\n"), "| a | b |\n");
    assert.equal(normalize("| a | b |   \n"), "| a | b |\n");
  });
  it("a row ending in an escaped pipe has no closing pipe (last cell keeps the `\\|`)", () => {
    assert.equal(normalize("| a | b \\|\n"), "| a | b \\| |\n");
  });
  it("B-29 shape: a 4,618-char Title cell with pipes, backticks and double spaces is reproduced exactly", () => {
    // Amendment 7: the archived B-29 row must equal the live row minus padding, byte-for-byte.
    const lead = "**B-29 — secrets-read gap: ⚠️ env deny rules `miss` \\| unnamed reads ①**  ";
    // ends in a non-space so "trailing padding" cannot be confused with content
    const title = (lead + "x  y `a \\| b` — ".repeat(400)).slice(0, 4617) + "z";
    assert.equal(title.length, 4618);
    const tail = " | queued | P1 | — |";
    const padded = "| B-29   | " + title + " ".repeat(72) + tail + "\n";
    const unpadded = "| B-29 | " + title + tail + "\n";
    assert.equal(normalize(padded), unpadded);
    assert.equal(normalize(unpadded), unpadded);
    const cells = splitCells(normalize(padded).trimEnd());
    assert.equal(cells[1], title);
    assert.equal(cells.length, 5);
  });
  it("a megabyte-scale cell normalizes without blowing up", () => {
    const big = "z".repeat(1_500_000);
    assert.equal(normalize(`| a  | ${big}   |\n`), `| a | ${big} |\n`);
  });
});

// --- parse -------------------------------------------------------------------

describe("parseQueue", () => {
  const parsed = parseQueue(BASE);
  const data = dataRows(parsed);
  const byId = (needle) => data.find((r) => r.text.includes(needle));

  it("excludes header and separator rows from the data rows", () => {
    const kinds = parsed.rows.map((r) => r.kind);
    assert.equal(kinds.filter((k) => k === "header").length, 3);
    assert.equal(kinds.filter((k) => k === "separator").length, 3);
    assert.equal(data.length, 5 + 2 + 4);
  });
  it("sections come from the nearest preceding `## ` heading; status from cell[2], lower-cased", () => {
    assert.equal(byId("T-1.1").section, "Active");
    assert.equal(byId("B-4").section, "Blocked");
    assert.equal(byId("T-9").section, "Recently done");
    assert.equal(byId("B-5").status, "deferred");
    assert.equal(byId("B-4").status, "blocked");
  });
  it("Recently done is always `done`, whatever cell[2] says", () => {
    const p = parseQueue(
      "## Recently done\n\n| ID | T | Done |\n| - | - | - |\n| X-1 | t | queued |\n",
    );
    assert.equal(dataRows(p)[0].status, "done");
    assert.equal(dataRows(p)[0].closed, true);
  });
  it("closed = done|cancelled; deferred and unknown statuses are live", () => {
    assert.equal(byId("B-2").closed, true);
    assert.equal(byId("B-3").closed, true);
    assert.equal(byId("B-5").closed, false);
    assert.equal(byId("T-1.1").closed, false);
    const odd = parseQueue("## Active\n\n| ID | T | Status |\n| - | - | - |\n| X | t | wip |\n");
    assert.equal(dataRows(odd)[0].closed, false);
  });
  it("an unknown section is `unknown` and live", () => {
    const p = parseQueue("## Notes\n\n| ID | T | Status |\n| - | - | - |\n| X | t | done |\n");
    assert.equal(dataRows(p)[0].status, "unknown");
    assert.equal(dataRows(p)[0].closed, false);
  });
  it("a malformed row in Active/Blocked is an error; in Recently done it is tolerated", () => {
    const a = parseQueue(
      "## Active\n\n| ID | T | Status |\n| - | - | - |\n| X | t | queued | extra |\n",
    );
    assert.equal(a.errors.length, 1);
    assert.equal(a.errors[0].line, 5);
    const b = parseQueue("## Blocked\n\n| ID | T | Status |\n| - | - | - |\n| X | t |\n");
    assert.equal(b.errors.length, 1);
    const d = parseQueue(
      "## Recently done\n\n| ID | T | Done |\n| - | - | - |\n| X | t | d | e | f |\n",
    );
    assert.equal(d.errors.length, 0);
    assert.equal(dataRows(d)[0].malformed, true);
    assert.equal(dataRows(d)[0].closed, true);
  });
  it("a data row with no header at all is malformed", () => {
    assert.equal(parseQueue("## Active\n| X | t | queued |\n").errors.length, 1);
    assert.equal(parseQueue("## Recently done\n| X | t |\n").errors.length, 0);
  });
  it("a malformed row is an error in EVERY section except Recently done (I-3: those are all live)", () => {
    // Falsification: gate the error on `section === "Active" || section === "Blocked"` (the old rule)
    // and the Parked / before-any-heading / header-less cases come back with no errors.
    const parked = parseQueue(
      "## Parked\n\n| ID | T | Status |\n| - | - | - |\n| X | t | queued | extra |\n",
    );
    assert.deepEqual(
      parked.errors.map((e) => [e.line, e.message]),
      [[5, "4 cells, header has 3"]],
    );
    assert.deepEqual(
      parseQueue("## Parked\n| X | t | queued |\n").errors.map((e) => e.message),
      ["no table header above it"],
    );
    assert.equal(parseQueue("| X | t | queued |\n").errors.length, 1, "before any `## ` heading");
    // A well-formed row there is no error, and Recently done stays tolerant.
    assert.equal(
      parseQueue("## Parked\n\n| ID | T | Status |\n| - | - | - |\n| X | t | queued |\n").errors
        .length,
      0,
    );
    assert.equal(parseQueue("## Recently done\n| X | t | d | e |\n").errors.length, 0);
  });
  it("rows after a blank line still belong to the section's table (the real QUEUE.md shape)", () => {
    const p = parseQueue(
      "## Active\n\n| ID | T | Status |\n| - | - | - |\n| A | t | queued |\n\n| B | t | done |\n\n| C | t | queued |\n",
    );
    assert.equal(p.errors.length, 0);
    assert.deepEqual(
      dataRows(p).map((r) => r.status),
      ["queued", "done", "queued"],
    );
  });
  it("each section is checked against its own header (a 5-column Blocked under a 3-column Active)", () => {
    const p = parseQueue(
      "## Active\n\n| ID | T | S |\n| - | - | - |\n| A | t | queued |\n\n## Blocked\n\n| ID | T | S | P | B |\n| - | - | - | - | - |\n| B | t | blocked | P1 | x |\n",
    );
    assert.equal(p.errors.length, 0);
  });
  it("a `## ` heading drops the previous header: rows under a header-less section are malformed", () => {
    // Falsification: if a heading did not reset the header, B's 3 cells would be judged against
    // Active's 3-cell header and this would wrongly pass clean.
    const p = parseQueue(
      "## Active\n\n| ID | T | S |\n| - | - | - |\n| A | t | queued |\n\n## Blocked\n\n| B | t | blocked |\n",
    );
    assert.deepEqual(
      p.errors.map((e) => e.line),
      [9],
    );
  });
  it("records 1-based line numbers", () => {
    assert.equal(byId("T-1.1").line, lineNo(BASE, "T-1.1"));
  });
  it("an empty or `—` ID cell is no ID", () => {
    assert.equal(byId("Charlie").id, null);
    const p = parseQueue("## Active\n\n| ID | T | S |\n| - | - | - |\n|  | t | queued |\n");
    assert.equal(dataRows(p)[0].id, null);
    assert.equal(byId("T-1.1").id, "T-1.1");
  });
});

describe("handleOf", () => {
  it("is the ID cell when there is one", () => {
    assert.equal(handleOf(["B-30", "**x**", "queued"]), "B-30");
  });
  it("for a `—` row: the first **bold** lead, first 40 chars, trailing whitespace trimmed", () => {
    assert.equal(
      handleOf(["—", "**E2E gate evidence (P2):** more **bold**"]),
      "E2E gate evidence (P2):",
    );
    assert.equal(handleOf(["—", "**" + "a".repeat(39) + " bbbbbb** rest"]), "a".repeat(39));
    assert.equal(handleOf(["—", "**" + "a".repeat(60) + "**"]), "a".repeat(40));
  });
  it("falls back to the whole Title when there is no (closed, non-empty) bold lead", () => {
    assert.equal(handleOf(["—", "plain title text"]), "plain title text");
    assert.equal(handleOf(["—", "**never closed"]), "**never closed");
    assert.equal(handleOf(["—", "**** empty bold"]), "**** empty bold".slice(0, 40));
    assert.equal(handleOf(["—", ""]), "");
    assert.equal(handleOf(["—"]), "");
  });
  it("counts code points, never splitting a surrogate pair", () => {
    const h = handleOf(["—", "**" + "x".repeat(39) + "🔴🔴** tail"]);
    assert.equal(h, "x".repeat(39) + "🔴");
    assert.doesNotMatch(h, /[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

// --- verify -----------------------------------------------------------------------

describe("verifyLossless", () => {
  const live = join$(
    "## Active",
    "",
    "| ID | Title | Status | Priority | Depends on |",
    "| --- | --- | --- | --- | --- |",
    "| T-1.1 | **Alpha** live thing | queued | P1 | — |",
    "| — | **Charlie handle** unlabeled | in-progress | P3 | — |",
    "| B-5 | **Echo** parked | DEFERRED | P4 | — |",
    "",
    "## Blocked",
    "",
    "| ID | Title | Status | Priority | Blocker |",
    "| --- | --- | --- | --- | --- |",
    "| B-4 | **Foxtrot** stuck | blocked | P1 | Sean |",
  );

  it("identical before/after: exit-0 verdict and exactly the two summary lines", () => {
    const r = verifyLossless({ before: BASE, afters: [BASE] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.lines, ["rows: before=11 matched=11", "ids: before=8 matched=8"]);
  });
  it("padding differences are irrelevant (rows compare normalized)", () => {
    assert.equal(verifyLossless({ before: BASE, afters: [normalize(BASE)] }).ok, true);
  });
  it("a before-row split across several after files is matched (union)", () => {
    const first = without(BASE, ["| T-9 ", "| T-8 ", "| T-7 ", "**Six**"]);
    const second = join$(
      "## Recently done",
      "",
      "| T-9 | **Nine** one | 2026-01-09 |",
      "| T-8 | **Eight** two | 2026-01-08 |",
      "| T-7 | **Seven** 3 | 2026-01-07 |",
      "| — | **Six** four | 2026-01-06 |",
    );
    assert.equal(verifyLossless({ before: BASE, afters: [first, second] }).ok, true);
  });
  it("extra rows in after are fine (before ⊆ after)", () => {
    assert.equal(
      verifyLossless({ before: BASE, afters: [BASE, "| Z-1 | extra | x |\n"] }).ok,
      true,
    );
  });
  it("one dropped row: fails, names the row with its before-file line number", () => {
    const after = without(BASE, ["| B-3 "]);
    const r = verifyLossless({ before: BASE, afters: [after] });
    assert.equal(r.ok, false);
    assert.equal(r.lines[0], "rows: before=11 matched=10");
    assert.equal(r.lines[1], "ids: before=8 matched=7");
    const want = `MISSING row L${lineNo(BASE, "| B-3 ")}: | B-3 | **Delta** cancelled thing | cancelled | P3 | — |`;
    assert.ok(r.lines.includes(want), r.lines.join("\n"));
    assert.ok(r.lines.includes("MISSING id B-3"));
  });
  it("MISSING row prints at most the first 100 chars of the row", () => {
    const long = "| X-1 | " + "y".repeat(300) + " | z |\n";
    const r = verifyLossless({ before: long, afters: ["\n"] });
    const missing = r.lines.find((l) => l.startsWith("MISSING row"));
    assert.equal(missing, "MISSING row L1: " + long.slice(0, 100));
  });
  it("multiplicity: a row twice in before but once in after fails", () => {
    const row = "| T-1 | **dup** | queued |\n";
    const r = verifyLossless({ before: row + row, afters: [row] });
    assert.equal(r.ok, false);
    assert.equal(r.lines[0], "rows: before=2 matched=1");
    assert.equal(r.lines.filter((l) => l.startsWith("MISSING row")).length, 1);
    // ...and the union of two afters is a multiset sum, so one copy in each is enough.
    assert.equal(verifyLossless({ before: row + row, afters: [row, row] }).ok, true);
    assert.equal(verifyLossless({ before: row + row, afters: [row + row] }).ok, true);
  });
  it("an ID removed while the rest of the row's content is present fails the ID check", () => {
    const before = "| B-1 | **Title** | queued |\n";
    const after = "| — | **Title** | queued |\n";
    const r = verifyLossless({ before, afters: [after] });
    assert.equal(r.ok, false);
    assert.equal(r.lines[1], "ids: before=1 matched=0");
    assert.ok(r.lines.includes("MISSING id B-1"));
  });
  it("the ID check is by distinct ID (a repeated ID counts once)", () => {
    const rows = "| B-7 | a | x |\n| B-7 | b | y |\n";
    assert.deepEqual(verifyLossless({ before: rows, afters: [rows] }).lines.slice(0, 2), [
      "rows: before=2 matched=2",
      "ids: before=1 matched=1",
    ]);
  });
  it("an empty before is trivially lossless", () => {
    const r = verifyLossless({ before: "", afters: [""] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.lines, ["rows: before=0 matched=0", "ids: before=0 matched=0"]);
  });

  describe("--live", () => {
    it("passes when every live before row is in live by ID cell or handle (closed rows not required)", () => {
      const r = verifyLossless({ before: BASE, afters: [BASE], live });
      assert.equal(r.ok, true);
      assert.deepEqual(r.lines, [
        "rows: before=11 matched=11",
        "ids: before=8 matched=8",
        "live: required=4 present=4",
      ]);
    });
    it("a live ID missing from live fails and is named", () => {
      const r = verifyLossless({ before: BASE, afters: [BASE], live: without(live, ["| B-4 "]) });
      assert.equal(r.ok, false);
      assert.equal(r.lines[2], "live: required=4 present=3");
      assert.ok(r.lines.includes("MISSING live B-4"));
    });
    it("a live ID is matched by ID cell only, not by appearing in some other cell", () => {
      const sneaky = live.replace("| B-4 | **Foxtrot** stuck", "| X-9 | **Foxtrot** stuck B-4");
      const r = verifyLossless({ before: BASE, afters: [BASE], live: sneaky });
      assert.equal(r.ok, false);
      assert.ok(r.lines.includes("MISSING live B-4"));
    });
    it("a `—` row whose handle is missing from live fails; the handle present passes", () => {
      const gone = verifyLossless({
        before: BASE,
        afters: [BASE],
        live: without(live, ["Charlie handle"]),
      });
      assert.equal(gone.ok, false);
      assert.ok(gone.lines.includes("MISSING live Charlie handle"), gone.lines.join("\n"));
      const there = live.replace("**Charlie handle** unlabeled", "Charlie handle, abbreviated");
      assert.equal(verifyLossless({ before: BASE, afters: [BASE], live: there }).ok, true);
    });
    it("the handle must be in a live row's Title cell, not merely somewhere in the file", () => {
      const elsewhere = without(live, ["Charlie handle"]) + "> Charlie handle is mentioned here\n";
      assert.equal(verifyLossless({ before: BASE, afters: [BASE], live: elsewhere }).ok, false);
    });
    it("a duplicate handle among live rows warns but does not fail", () => {
      const before = join$(
        "## Active",
        "",
        "| ID | T | S |",
        "| - | - | - |",
        "| — | **Same lead** one | queued |",
        "| — | **Same lead** two | queued |",
      );
      const r = verifyLossless({ before, afters: [before], live: before });
      assert.equal(r.ok, true);
      assert.ok(r.lines.includes("WARN duplicate handle Same lead"));
      assert.equal(r.lines.filter((l) => l.startsWith("WARN")).length, 1);
    });
    it("a live row with an empty handle cannot be verified, so it counts as missing", () => {
      const before = join$("## Active", "", "| ID | T | S |", "| - | - | - |", "| — |  | queued |");
      const r = verifyLossless({ before, afters: [before], live: before });
      assert.equal(r.ok, false);
      assert.ok(r.lines.some((l) => l.startsWith("MISSING live") && l.includes("empty handle")));
    });
    it("a malformed Active/Blocked row in before is an error under --live (its status is unreliable)", () => {
      const before = join$(
        "## Active",
        "",
        "| ID | T | S |",
        "| - | - | - |",
        "| X | t | queued | extra |",
      );
      const r = verifyLossless({ before, afters: [before], live: before });
      assert.equal(r.ok, false);
      assert.ok(r.lines.some((l) => l.startsWith("ERROR malformed row L5")));
      // ...but the lossless row/ID checks alone don't depend on status.
      assert.equal(verifyLossless({ before, afters: [before] }).ok, true);
    });

    // --- matching is one-to-one, exact-handle first, live sections only (verifier findings) ---
    // What turns each pin red (each was checked against a scratch copy of the module, never the repo file):
    //   - skip the exact-handle pass            -> "preferred, whatever the order", "no WARN", the duplicate-handle test
    //   - an index row can be claimed twice     -> "false live match", "one index row cannot stand in",
    //                                              "same handle", "same ID" (one mutation per claim site)
    //   - count Recently done rows as live      -> the two "Recently done" tests
    //   - match the handle in any cell          -> "must be in the Title cell" (needs the spare rows: a claimed row hides it)
    //   - drop the substring-fallback WARN, or its before/index line or title -> "prints a WARN naming ..."
    //   - skip the --live index's parse errors, or report Recently-done ones, or not fail on them
    //                                           -> the two malformed --live tests
    //   - leave MISSING lines unsorted          -> "MISSING lines follow the order of the before file"
    //   - pick candidates by section only (not status)   -> the four "re-marked ... is not present" cases
    //   - drop `!r.closed` from the candidate filter     -> the same four cases
    //   - read the raw status cell in EVERY section (the pre-I-3 filter) -> the `## Parked` identity test
    //     and "live whatever its status cell says"
    //   - let a malformed row be a candidate    -> "a malformed row never satisfies a required live row"
    //   - gate the ERROR on Active/Blocked      -> the `## Parked` ERROR / before-side / rotate / parseQueue pins
    const ACTIVE_HEAD = [
      "## Active",
      "",
      "| ID | Title | Status | Priority | Depends on |",
      "| --- | --- | --- | --- | --- |",
    ];
    const DONE_HEAD = ["", "## Recently done", "", "| ID | Title | Done |", "| --- | --- | --- |"];
    const index = (activeRows, doneRows = []) =>
      join$(
        ...ACTIVE_HEAD,
        ...activeRows,
        ...(doneRows.length > 0 ? [...DONE_HEAD, ...doneRows] : []),
      );
    const row = (id, title, status = "queued", dep = "—") =>
      `| ${id} | ${title} | ${status} | P1 | ${dep} |`;

    it("a dropped row's handle does not hide behind another row's longer Title (false live match)", () => {
      const before = index([
        row("—", "**Fix the widget** a"),
        row("—", "**Fix the widget cache invalidation path** b"),
      ]);
      const kept = index([row("—", "**Fix the widget cache invalidation path** b")]);
      const r = verifyLossless({ before, afters: [before], live: kept });
      assert.equal(r.ok, false, r.lines.join("\n"));
      assert.ok(r.lines.includes("live: required=2 present=1"), r.lines.join("\n"));
      assert.ok(r.lines.includes("MISSING live Fix the widget"), r.lines.join("\n"));
    });
    it("an index row whose own handle equals the required one is preferred, whatever the order", () => {
      const before = index([
        row("—", "**Fix the widget** a"),
        row("—", "**Fix the widget cache** b"),
      ]);
      // The longer Title comes first: a greedy substring match would let `Fix the widget` take it.
      const swapped = index([
        row("—", "**Fix the widget cache** b"),
        row("—", "**Fix the widget** a"),
      ]);
      const r = verifyLossless({ before, afters: [before], live: swapped });
      assert.equal(r.ok, true, r.lines.join("\n"));
      assert.deepEqual(r.lines, [
        "rows: before=2 matched=2",
        "ids: before=0 matched=0",
        "live: required=2 present=2",
      ]);
    });
    it("a substring-only match still passes, but prints a WARN naming the required and the index row", () => {
      const there = live.replace("**Charlie handle** unlabeled", "Charlie handle, abbreviated");
      const r = verifyLossless({ before: BASE, afters: [BASE], live: there });
      assert.equal(r.ok, true, r.lines.join("\n"));
      const warns = r.lines.filter((l) => l.startsWith("WARN"));
      assert.equal(warns.length, 1, r.lines.join("\n"));
      assert.ok(warns[0].includes('"Charlie handle"'), warns[0]);
      assert.ok(warns[0].includes(`(before L${lineNo(BASE, "Charlie handle")})`), warns[0]);
      assert.ok(warns[0].includes(`index L${lineNo(there, "Charlie handle")} `), warns[0]);
      assert.ok(warns[0].includes("Charlie handle, abbreviated"), warns[0]);
    });
    it("MISSING lines follow the order of the before file, ID rows and handle rows interleaved", () => {
      const r = verifyLossless({
        before: BASE,
        afters: [BASE],
        live: without(live, ["Charlie handle", "| B-5 ", "| B-4 "]),
      });
      assert.deepEqual(
        r.lines.filter((l) => l.startsWith("MISSING live")),
        ["MISSING live Charlie handle", "MISSING live B-5", "MISSING live B-4"],
      );
    });
    it("an exact-handle match prints no WARN", () => {
      const r = verifyLossless({ before: BASE, afters: [BASE], live });
      assert.equal(r.lines.filter((l) => l.startsWith("WARN")).length, 0, r.lines.join("\n"));
    });
    it("one index row cannot stand in for two required rows (substring fallback)", () => {
      const before = index([row("—", "**Alpha** one"), row("—", "**Beta** two")]);
      const merged = index([row("—", "Alpha and Beta together")]);
      const r = verifyLossless({ before, afters: [before], live: merged });
      assert.equal(r.ok, false, r.lines.join("\n"));
      assert.ok(r.lines.includes("live: required=2 present=1"), r.lines.join("\n"));
    });
    it("two required rows with the same handle need two index rows (exact matches are used up)", () => {
      const before = index([row("—", "**Same lead** one"), row("—", "**Same lead** two")]);
      const one = index([row("—", "**Same lead** one")]);
      const r = verifyLossless({ before, afters: [before], live: one });
      assert.equal(r.ok, false, r.lines.join("\n"));
      assert.ok(r.lines.includes("live: required=2 present=1"), r.lines.join("\n"));
    });
    it("two live rows with the same ID need two index rows carrying it", () => {
      const before = index([row("T-1", "first"), row("T-1", "second")]);
      const one = index([row("T-1", "first")]);
      const r = verifyLossless({ before, afters: [before], live: one });
      assert.equal(r.ok, false, r.lines.join("\n"));
      assert.ok(r.lines.includes("live: required=2 present=1"), r.lines.join("\n"));
    });
    it("a live ID that now sits in Recently done is not present", () => {
      const moved = index(
        [row("—", "**Charlie handle** unlabeled", "in-progress")],
        ["| B-4 | **Foxtrot** stuck | 2026-10-06 |"],
      );
      const r = verifyLossless({ before: BASE, afters: [BASE], live: moved });
      assert.ok(r.lines.includes("MISSING live B-4"), r.lines.join("\n"));
      assert.equal(r.ok, false);
    });
    it("a live handle that now appears only in Recently done is not present", () => {
      const moved = index(
        [row("B-4", "**Foxtrot** stuck", "blocked")],
        ["| — | **Charlie handle** unlabeled | 2026-10-06 |"],
      );
      const r = verifyLossless({ before: BASE, afters: [BASE], live: moved });
      assert.ok(r.lines.includes("MISSING live Charlie handle"), r.lines.join("\n"));
      assert.equal(r.ok, false);
    });
    // --- live is defined by STATUS (I-3), not by section: an index row marked done/cancelled is not live ---
    // Falsification: pick candidates by `section !== "Recently done"` alone (the pre-fix filter) and
    // every case below passes with rc 0 and `present=4` — the false pass that lets the next `rotate`
    // silently drop a live row (T4's flow: B-30 flipped to `done` but left in Active).
    const PARKED_HEAD = [
      "",
      "## Parked",
      "",
      "| ID | Title | Status | Priority | Depends on |",
      "| --- | --- | --- | --- | --- |",
    ];
    const parked = (...rows) => join$(...PARKED_HEAD, ...rows);
    const ECHO = "| B-5 | **Echo** parked | DEFERRED | P4 | — |";
    /** `verify --before BASE --after BASE --live <liveText>` through the CLI (what T4 runs). */
    const verifyLive = (liveText) => {
      const s = sandbox(BASE);
      const file = join(s.dir, "index.md");
      writeFileSync(file, liveText);
      return cli(["verify", "--before", s.queue, "--after", s.queue, "--live", file]);
    };
    const reMarked = [
      [
        "a live ID re-marked done in Active",
        live.replace(
          "| T-1.1 | **Alpha** live thing | queued |",
          "| T-1.1 | **Alpha** live thing | done |",
        ),
        "MISSING live T-1.1",
      ],
      [
        "a live ID re-marked cancelled in Blocked",
        live.replace(
          "| B-4 | **Foxtrot** stuck | blocked |",
          "| B-4 | **Foxtrot** stuck | cancelled |",
        ),
        "MISSING live B-4",
      ],
      [
        "a live ID-less row re-marked done in Active (matched by handle)",
        live.replace(
          "**Charlie handle** unlabeled | in-progress |",
          "**Charlie handle** unlabeled | done |",
        ),
        "MISSING live Charlie handle",
      ],
      [
        "the status test ignores case (`DONE`)",
        live.replace(
          "| T-1.1 | **Alpha** live thing | queued |",
          "| T-1.1 | **Alpha** live thing | DONE |",
        ),
        "MISSING live T-1.1",
      ],
    ];
    for (const [name, text, missing] of reMarked) {
      it(`${name} is not present (CLI rc 1)`, () => {
        assert.notEqual(text, live, "fixture edit must apply");
        const r = verifyLive(text);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /^live: required=4 present=3$/m);
        assert.ok(r.stdout.split("\n").includes(missing), r.stdout);
        assert.doesNotMatch(r.stdout, /^ERROR/m, "the row is well-formed, only not live");
      });
    }
    // I-3: only Active/Blocked rows have a status; any other section gives `unknown`, which is live. So a
    // row under `## Parked` is live whatever its cell says, on the `before` side AND in the index. The
    // pre-I-3 filter read the raw cell in every section: it required such a row on the `before` side
    // (status `unknown`) but refused it in the index, so even `verify X X --live X` failed.
    /** `verify --before T --after T --live T` through the CLI: the identity run. */
    const verifyIdentity = (text) => {
      const s = sandbox(text);
      return cli(["verify", "--before", s.queue, "--after", s.queue, "--live", s.queue]);
    };
    it("identity: a row under ## Parked whose status cell says done is live and present (CLI rc 0)", () => {
      const text = BASE + parked("| T-7.10 | **Hotel** parked | done | P4 | — |");
      const r = verifyIdentity(text);
      assert.equal(r.status, 0, r.stdout);
      assert.match(r.stdout, /^live: required=5 present=5$/m);
      assert.doesNotMatch(r.stdout, /^(MISSING|ERROR)/m);
    });
    // A row MOVED into an unknown section is still live (present), whatever its status cell says; the move
    // itself is reported as a CHANGED `section` (and `Status`, when the cell differs), hence rc 1.
    it("a row moved to an unknown section is live whatever its status cell says (present; the move is a CHANGED)", () => {
      for (const status of ["deferred", "queued", "blocked", "done", "cancelled", "DONE"]) {
        const r = verifyLive(
          live.replace(ECHO, "") + parked(`| B-5 | **Echo** parked | ${status} | P4 | — |`),
        );
        assert.match(r.stdout, /^live: required=4 present=4$/m, `${status}: ${r.stdout}`);
        assert.doesNotMatch(r.stdout, /^(MISSING|ERROR)/m, status);
        assert.match(r.stdout, /^CHANGED live B-5 .* section: "Active" -> "Parked"$/m, status);
        assert.equal(r.status, 1, `${status}: ${r.stdout}`);
      }
    });
    it("the section, not the cell, decides: the same done row in Active is closed (MISSING), under ## Parked it is live", () => {
      const cell = "| B-5 | **Echo** parked | done | P4 | — |";
      const inActive = verifyLive(live.replace(ECHO, cell));
      assert.equal(inActive.status, 1, inActive.stdout);
      assert.match(inActive.stdout, /^MISSING live B-5$/m);
      const underParked = verifyLive(live.replace(ECHO, "") + parked(cell));
      assert.match(underParked.stdout, /^live: required=4 present=4$/m, underParked.stdout);
      assert.doesNotMatch(underParked.stdout, /^(MISSING|ERROR)/m, underParked.stdout);
    });

    // --- a malformed row cannot be trusted: ERROR in every section but Recently done, and never a match ---
    // Falsification: gate the ERROR on Active/Blocked (the old rule) and the Parked / header-less cases
    // lose their ERROR line; let a malformed row be a candidate and the MISSING cases come back present.
    it("a malformed row in ANY non-Recently-done section of the --live index is an ERROR (CLI rc 1), e.g. ## Parked", () => {
      const badParked = live + parked("| P-1 | **Park** | queued | P3 | — | extra |");
      const r = verifyLive(badParked);
      assert.equal(r.status, 1, r.stdout);
      const errors = r.stdout.split("\n").filter((l) => l.startsWith("ERROR"));
      assert.equal(errors.length, 1, r.stdout);
      assert.ok(errors[0].includes("--live"), errors[0]);
      assert.ok(errors[0].includes(`L${lineNo(badParked, "**Park**")} `), errors[0]);
      assert.ok(errors[0].includes("6 cells, header has 5"), errors[0]);
      assert.match(
        r.stdout,
        /^live: required=4 present=4$/m,
        "the stray row is not needed for a match",
      );
      // No header at all under the unknown section: also an ERROR.
      const headerless = verifyLive(live + "\n## Parked\n\n| P-1 | **Park** | queued | P3 | — |\n");
      assert.equal(headerless.status, 1, headerless.stdout);
      assert.match(
        headerless.stdout,
        /^ERROR malformed --live row L\d+ \(no table header above it\)/m,
      );
      // The same section, well-formed: clean.
      const ok = verifyLive(live + parked("| P-1 | **Park** | queued | P3 | — |"));
      assert.equal(ok.status, 0, ok.stdout);
      assert.doesNotMatch(ok.stdout, /^ERROR/m);
    });
    it("a malformed row never satisfies a required live row: its ERROR comes with a MISSING (Parked and Active)", () => {
      const extra = "| B-5 | **Echo** parked | DEFERRED | P4 | — | extra |";
      for (const text of [
        live.replace(ECHO, "") + parked(extra), // 6 cells under the 5-cell Parked header
        live.replace(ECHO, extra), // 6 cells under the 5-cell Active header
      ]) {
        const r = verifyLive(text);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /^ERROR malformed --live row L\d+ \(6 cells, header has 5\)/m);
        assert.match(r.stdout, /^live: required=4 present=3$/m);
        assert.match(r.stdout, /^MISSING live B-5$/m);
      }
    });
    it("a malformed row in a non-Recently-done section of BEFORE is an ERROR under --live too (Parked)", () => {
      const before = BASE + parked("| P-1 | **Park** | queued | P3 | — | extra |");
      const r = verifyLossless({ before, afters: [before], live: before });
      assert.equal(r.ok, false, r.lines.join("\n"));
      assert.ok(
        r.lines.some((l) => l.startsWith(`ERROR malformed row L${lineNo(before, "**Park**")} `)),
        r.lines.join("\n"),
      );
    });

    it("the handle must be in the Title cell: Depends-on or Blocker mentions do not count (CLI rc 1)", () => {
      const s = sandbox(BASE);
      const dropped = without(live, ["Charlie handle"]);
      const echo = "| B-5 | **Echo** parked | DEFERRED | P4 | — |";
      const foxtrot = "| B-4 | **Foxtrot** stuck | blocked | P1 | Sean |";
      const bad = [
        // Charlie dropped; its handle survives only in another row's Depends-on cell...
        dropped.replace(echo, echo.replace("| — |", "| Charlie handle |")),
        // ...or in a Blocked row's Blocker cell...
        dropped.replace(foxtrot, foxtrot.replace("| Sean |", "| Charlie handle |")),
        // ...or in rows nothing else claims (a rule that only lets a claimed row be "used up" would
        // otherwise hide a handle-in-any-cell match behind the ID matches).
        dropped.replace(echo, echo + "\n| T-77 | **Spare** new | queued | P2 | Charlie handle |"),
        dropped.replace(
          foxtrot,
          foxtrot + "\n| T-78 | **Spare2** new | blocked | P2 | Charlie handle |",
        ),
      ];
      for (const text of bad) {
        const file = join(s.dir, "index.md");
        writeFileSync(file, text);
        const r = cli(["verify", "--before", s.queue, "--after", s.queue, "--live", file]);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /^MISSING live Charlie handle$/m);
      }
    });

    // --- the --live index is itself checked ---
    it("a malformed Active/Blocked row in the --live index is an ERROR and fails (CLI rc 1)", () => {
      const sixCells = live.replace(
        "| B-5 | **Echo** parked | DEFERRED | P4 | — |",
        "| B-5 | **Echo** parked | DEFERRED | P4 | — | extra |",
      );
      const r = verifyLossless({ before: BASE, afters: [BASE], live: sixCells });
      assert.equal(r.ok, false, r.lines.join("\n"));
      const errors = r.lines.filter((l) => l.startsWith("ERROR"));
      assert.equal(errors.length, 1, r.lines.join("\n"));
      assert.ok(errors[0].includes("--live"), errors[0]);
      assert.ok(errors[0].includes(`L${lineNo(sixCells, "**Echo**")} `), errors[0]);
      assert.ok(errors[0].includes("6 cells, header has 5"), errors[0]);
      const s = sandbox(BASE);
      const file = join(s.dir, "index.md");
      writeFileSync(file, sixCells);
      assert.equal(
        cli(["verify", "--before", s.queue, "--after", s.queue, "--live", file]).status,
        1,
      );
    });
    it("a malformed row in the --live index's Recently done is tolerated (status is fixed by section)", () => {
      const tolerant = live + join$(...DONE_HEAD, "| T-9 | **Nine** one | 2026-01-09 | extra |");
      const r = verifyLossless({ before: BASE, afters: [BASE], live: tolerant });
      assert.equal(r.ok, true, r.lines.join("\n"));
      assert.equal(r.lines.filter((l) => l.startsWith("ERROR")).length, 0);
    });

    // --- carried cells: `--live` is a SAME-MOMENT re-index check (round-1 finding) ---
    // A reviewer edited a copy of the real index ("P-6 phase QA" blocked -> queued, P-13 P1 -> P0, P-13's
    // dependency changed) and `verify --live` still said 102/102, rc 0: pairing proved the row EXISTS, not
    // that its cells survived. Every cell after the Title (and the section) of each paired row must be
    // identical; the Title is exempt because the index shortens it by design.
    // Falsification: delete the comparison in `verifyLossless` (or pair without returning the pairs) and
    // every test here that expects a CHANGED line goes red, while the identity and title-only ones stay green.
    describe("carried cells", () => {
      const HEAD = [
        "## Active",
        "",
        "| ID | Title | Status | Priority | Depends on |",
        "| --- | --- | --- | --- | --- |",
      ];
      const beforeText = join$(
        ...HEAD,
        "| P-13 | **Phase 13** polish, wire the settings screen and ship it | queued | P1 | P-12 |",
        "| — | **P-6 phase QA** run the simulator pass on a device | blocked | P2 | P-5 |",
        "| T-1.1 | **Alpha** untouched | queued | P3 | — |",
      );
      const P13 = "| P-13 | **Phase 13** polish | queued | P1 | P-12 |";
      const P6 = "| — | **P-6 phase QA** simulator | blocked | P2 | P-5 |";
      const T11 = "| T-1.1 | **Alpha** | queued | P3 | — |";
      // Shortened Titles, every other cell as it was: what a faithful re-index looks like.
      const faithful = join$(...HEAD, P13, P6, T11);
      /** `verify --before B --after B --live <indexText>` through the CLI. */
      const verifyIndex = (indexText, before = beforeText) => {
        const s = sandbox(before);
        const file = join(s.dir, "index.md");
        writeFileSync(file, indexText);
        return cli(["verify", "--before", s.queue, "--after", s.queue, "--live", file]);
      };
      const changed = (stdout) => stdout.split("\n").filter((l) => l.startsWith("CHANGED"));

      it("identity: a faithful re-index (Titles shortened, every other cell kept) has no CHANGED, rc 0", () => {
        const r = verifyIndex(faithful);
        assert.equal(r.status, 0, r.stdout);
        assert.deepEqual(changed(r.stdout), []);
        assert.match(r.stdout, /^live: required=3 present=3$/m);
        // And before = after = live, the literal identity run.
        const same = verifyIndex(beforeText, beforeText);
        assert.equal(same.status, 0, same.stdout);
        assert.deepEqual(changed(same.stdout), []);
      });
      it("three edited cells (status, priority, depends) are three CHANGED lines and rc 1, though every row is present", () => {
        const edited = faithful
          .replace(P6, P6.replace("| blocked |", "| queued |"))
          .replace(P13, P13.replace("| P1 |", "| P0 |").replace("| P-12 |", "| — |"));
        assert.notEqual(edited, faithful, "fixture edits must apply");
        const r = verifyIndex(edited);
        assert.equal(r.status, 1, r.stdout);
        assert.match(
          r.stdout,
          /^live: required=3 present=3$/m,
          "the rows are all there: only cells moved",
        );
        assert.deepEqual(changed(r.stdout), [
          'CHANGED live P-13 (before L5 -> index L5) Priority: "P1" -> "P0"',
          'CHANGED live P-13 (before L5 -> index L5) Depends on: "P-12" -> "—"',
          'CHANGED live P-6 phase QA (before L6 -> index L6) Status: "blocked" -> "queued"',
        ]);
        assert.doesNotMatch(r.stdout, /^(MISSING|ERROR)/m);
      });
      it("the library verdict agrees: ok is false and the CHANGED lines come after MISSING and before WARN", () => {
        const edited = faithful.replace(T11, T11.replace("| P3 |", "| P0 |"));
        const r = verifyLossless({ before: beforeText, afters: [beforeText], live: edited });
        assert.equal(r.ok, false, r.lines.join("\n"));
        assert.deepEqual(r.lines.slice(2), [
          "live: required=3 present=3",
          'CHANGED live T-1.1 (before L7 -> index L7) Priority: "P3" -> "P0"',
        ]);
      });
      it("the Title alone changing is never a CHANGED (the index shortens Titles by design)", () => {
        const r = verifyIndex(
          faithful.replace("**Phase 13** polish", "**Phase 13** a different, shorter"),
        );
        assert.equal(r.status, 0, r.stdout);
        assert.deepEqual(changed(r.stdout), []);
      });
      it("an ID-less row paired by its exact handle is compared too", () => {
        const r = verifyIndex(faithful.replace(P6, P6.replace("| P2 |", "| P1 |")));
        assert.equal(r.status, 1, r.stdout);
        assert.deepEqual(changed(r.stdout), [
          'CHANGED live P-6 phase QA (before L6 -> index L6) Priority: "P2" -> "P1"',
        ]);
      });
      // Round-1b finding: an ID-less (`—`) row that gains an ID in the index (`| B-999 | **...`) paired by the
      // substring fallback, printed only a WARN and exited 0, because cell 0 was never compared. The ID cell
      // is compared too, labelled `id`. Falsification: drop the cell-0 compare in `changedCellLines` and
      // both tests below go red (rc 0 / no CHANGED line) while every other carried-cells test stays green.
      it("an ID-less row that gains an ID in the index is a CHANGED on `id`, rc 1 (not just a WARN)", () => {
        const gained = faithful.replace(P6, P6.replace("| — |", "| B-999 |"));
        assert.notEqual(gained, faithful, "fixture edit must apply");
        const r = verifyIndex(gained);
        assert.equal(r.status, 1, r.stdout);
        assert.match(
          r.stdout,
          /^live: required=3 present=3$/m,
          "the row is there: only its ID moved",
        );
        assert.match(
          r.stdout,
          /^WARN live handle "P-6 phase QA"/m,
          "paired by the substring fallback",
        );
        assert.deepEqual(changed(r.stdout), [
          'CHANGED live P-6 phase QA (before L6 -> index L6) id: "—" -> "B-999"',
        ]);
        assert.doesNotMatch(r.stdout, /^(MISSING|ERROR)/m);
      });
      it("the ID cell is reported before the later columns, and the library verdict is not ok", () => {
        const gained = faithful.replace(
          P6,
          P6.replace("| — |", "| B-999 |").replace("| P2 |", "| P1 |"),
        );
        const r = verifyLossless({ before: beforeText, afters: [beforeText], live: gained });
        assert.equal(r.ok, false, r.lines.join("\n"));
        assert.deepEqual(
          r.lines.filter((l) => l.startsWith("CHANGED")),
          [
            'CHANGED live P-6 phase QA (before L6 -> index L6) id: "—" -> "B-999"',
            'CHANGED live P-6 phase QA (before L6 -> index L6) Priority: "P2" -> "P1"',
          ],
        );
      });
      it("a row paired only by the substring fallback is compared too (WARN and CHANGED both print)", () => {
        const abbreviated = P6.replace(
          "**P-6 phase QA** simulator",
          "P-6 phase QA, abbreviated",
        ).replace("| blocked |", "| queued |");
        const r = verifyIndex(faithful.replace(P6, abbreviated));
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /^WARN live handle "P-6 phase QA"/m);
        assert.deepEqual(changed(r.stdout), [
          'CHANGED live P-6 phase QA (before L6 -> index L6) Status: "blocked" -> "queued"',
        ]);
      });
      it("moving a live row to another section is a CHANGED on `section`, even with every cell kept", () => {
        const parked = [
          "",
          "## Parked",
          "",
          "| ID | Title | Status | Priority | Depends on |",
          "| --- | --- | --- | --- | --- |",
          T11,
        ];
        const moved = join$(...HEAD, P13, P6, ...parked);
        const r = verifyIndex(moved);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /^live: required=3 present=3$/m);
        assert.deepEqual(changed(r.stdout), [
          'CHANGED live T-1.1 (before L7 -> index L12) section: "Active" -> "Parked"',
        ]);
      });
      it("an index table that dropped a column shows the lost cell as the empty string", () => {
        const slim = join$(
          "## Active",
          "",
          "| ID | Title | Status | Priority |",
          "| --- | --- | --- | --- |",
          "| P-13 | **Phase 13** polish | queued | P1 |",
          "| — | **P-6 phase QA** simulator | blocked | P2 |",
          "| T-1.1 | **Alpha** | queued | P3 |",
        );
        const r = verifyIndex(slim);
        assert.equal(r.status, 1, r.stdout);
        assert.deepEqual(changed(r.stdout), [
          'CHANGED live P-13 (before L5 -> index L5) Depends on: "P-12" -> ""',
          'CHANGED live P-6 phase QA (before L6 -> index L6) Depends on: "P-5" -> ""',
          'CHANGED live T-1.1 (before L7 -> index L7) Depends on: "—" -> ""',
        ]);
      });
      it("a long cell is clipped to 100 characters with an ellipsis, so one line stays readable", () => {
        const long = "x".repeat(250);
        const r = verifyIndex(faithful.replace(P13, P13.replace("| P-12 |", `| ${long} |`)));
        assert.equal(r.status, 1, r.stdout);
        const [line] = changed(r.stdout);
        assert.ok(line.includes(`"${"x".repeat(100)}…"`), line);
        assert.ok(!line.includes("x".repeat(101)), line);
      });
      it("a row that is gone is MISSING, not CHANGED (nothing was paired)", () => {
        const r = verifyIndex(without(faithful, ["| T-1.1 "]));
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /^MISSING live T-1.1$/m);
        assert.deepEqual(changed(r.stdout), []);
      });
      it("without --live, edited cells are not this check's business (rows and IDs only)", () => {
        const s = sandbox(beforeText);
        const after = join(s.dir, "after.md");
        writeFileSync(after, faithful.replace(P13, P13.replace("| P1 |", "| P0 |")));
        const r = cli(["verify", "--before", s.queue, "--after", after]);
        // The edited P-13 row is not byte-equal, so the row multiset check (not CHANGED) reports it.
        assert.doesNotMatch(r.stdout, /^CHANGED/m);
      });
    });
  });
});

// --- rotate -------------------------------------------------------------------------

describe("planRotation / rotateFiles", () => {
  it("moves closed rows from Active/Blocked plus Recently-done rows beyond --keep", () => {
    const plan = planRotation(BASE, { keep: 2, date: DATE });
    assert.deepEqual(plan.counts, { active: 2, blocked: 1, done: 2, total: 5 });
    const expectQueue = without(BASE, ["| B-2 ", "| B-3 ", "**Golf done**", "| T-7 ", "**Six**"]);
    assert.equal(plan.queueText, expectQueue);
  });

  it("writes the archive (I-5 rotation header, marker, per-section tables) and rewrites the queue", () => {
    const s = sandbox();
    const r = rotateFiles({ queue: s.queue, archive: s.archive, keep: 2, date: DATE });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^moved 5 rows \(2 active, 1 blocked, 2 done\)/m);
    const archive = readFileSync(s.archive, "utf8");
    assert.ok(
      archive.startsWith(
        `# QUEUE snapshot — ${DATE}\n\n> Rows rotated out of \`docs/QUEUE.md\` on ${DATE} (status done/cancelled, and Recently done beyond the newest 2)`,
      ),
    );
    assert.equal(archive.split("\n").filter((l) => l === MARKER).length, 1);
    const body = archive.split(MARKER + "\n")[1];
    assert.equal(
      body,
      join$(
        "## Active",
        "",
        "| ID | Title | Status | Priority | Depends on |",
        "| --- | --- | --- | --- | --- |",
        "| B-2 | **Bravo** finished thing | done | P2 | — |",
        "| B-3 | **Delta** cancelled thing | cancelled | P3 | — |",
        "",
        "## Blocked",
        "",
        "| ID | Title | Status | Priority | Blocker |",
        "| --- | --- | --- | --- | --- |",
        "| — | **Golf done** | done | P2 | — |",
        "",
        "## Recently done",
        "",
        "| ID | Title | Done |",
        "| --- | --- | --- |",
        "| T-7 | **Seven** 3 | 2026-01-07 |",
        "| — | **Six** four | 2026-01-06 |",
      ),
    );
    // every non-moved line is byte-identical (padding and all)
    assert.equal(
      readFileSync(s.queue, "utf8"),
      without(BASE, ["| B-2 ", "| B-3 ", "**Golf done**", "| T-7 ", "**Six**"]),
    );
  });

  it("self-verify is real: an independent CLI verify of original vs new queue + archive passes", () => {
    const s = sandbox();
    const before = join(s.dir, "before.md");
    writeFileSync(before, BASE);
    assert.equal(rotateFiles({ queue: s.queue, archive: s.archive, keep: 1, date: DATE }).code, 0);
    const v = cli(["verify", "--before", before, "--after", s.queue, s.archive]);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /^rows: before=11 matched=11\nids: before=8 matched=8\n/);
  });

  it("refuses an existing archive: exit 2, queue and archive byte-unchanged", () => {
    const s = sandbox();
    writeFileSync(s.archive, "PRECIOUS HISTORY\n");
    const q0 = bytes(s.queue);
    const a0 = bytes(s.archive);
    const r = rotateFiles({ queue: s.queue, archive: s.archive, keep: 1, date: DATE });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /already exists/);
    assert.deepEqual(bytes(s.queue), q0);
    assert.deepEqual(bytes(s.archive), a0);
  });
  it("refuses an existing archive on --dry-run too, and when the archive IS the queue", () => {
    const s = sandbox();
    writeFileSync(s.archive, "x\n");
    assert.equal(
      rotateFiles({ queue: s.queue, archive: s.archive, dryRun: true, date: DATE }).code,
      2,
    );
    const q0 = bytes(s.queue);
    assert.equal(rotateFiles({ queue: s.queue, archive: s.queue, date: DATE }).code, 2);
    assert.deepEqual(bytes(s.queue), q0);
  });

  it("--dry-run reports the counts and writes nothing", () => {
    const s = sandbox();
    const q0 = bytes(s.queue);
    const r = rotateFiles({
      queue: s.queue,
      archive: s.archive,
      keep: 2,
      dryRun: true,
      date: DATE,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "would move 5 rows (2 active, 1 blocked, 2 done)\n");
    assert.equal(existsSync(s.archive), false);
    assert.deepEqual(bytes(s.queue), q0);
    assert.deepEqual(readdirSync(s.dir), ["QUEUE.md"]);
  });

  it("a failed self-verify restores the queue byte-for-byte and removes the new archive", () => {
    const s = sandbox();
    const q0 = bytes(s.queue);
    const r = rotateFiles({
      queue: s.queue,
      archive: s.archive,
      keep: 1,
      date: DATE,
      // test seam: corrupt the archive on disk after the writes, before the on-disk verify
      afterWrite: ({ archive }) => writeFileSync(archive, "garbage\n"),
    });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /MISSING row/);
    assert.match(r.stderr, /restored/);
    assert.deepEqual(bytes(s.queue), q0);
    assert.equal(existsSync(s.archive), false);
  });
  it("a corrupted rewritten queue is caught and restored too", () => {
    const s = sandbox();
    const q0 = bytes(s.queue);
    const r = rotateFiles({
      queue: s.queue,
      archive: s.archive,
      keep: 1,
      date: DATE,
      afterWrite: ({ queue }) => writeFileSync(queue, without(BASE, ["| T-1.1 "])),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(bytes(s.queue), q0);
    assert.equal(existsSync(s.archive), false);
  });

  it(
    "a queue write failure removes the archive it just made and exits 1",
    { skip: process.getuid?.() === 0 ? "root ignores file modes" : false },
    () => {
      const s = sandbox();
      chmodSync(s.queue, 0o444);
      const q0 = bytes(s.queue);
      const r = rotateFiles({ queue: s.queue, archive: s.archive, keep: 1, date: DATE });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /cannot write/);
      assert.equal(existsSync(s.archive), false);
      assert.deepEqual(bytes(s.queue), q0);
    },
  );

  it("nothing to move: exit 0 and no (empty) archive is created", () => {
    const s = sandbox(without(BASE, ["| B-2 ", "| B-3 ", "**Golf done**"]));
    const r = rotateFiles({ queue: s.queue, archive: s.archive, keep: 5, date: DATE });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^moved 0 rows \(0 active, 0 blocked, 0 done\)/);
    assert.equal(existsSync(s.archive), false);
  });

  it("--keep boundaries: 0 moves every done row, N >= rows moves none", () => {
    const all = planRotation(BASE, { keep: 0, date: DATE }).counts;
    assert.equal(all.done, 4);
    const none = planRotation(BASE, { keep: 4, date: DATE }).counts;
    assert.equal(none.done, 0);
    assert.equal(planRotation(BASE, { keep: 999, date: DATE }).counts.done, 0);
    assert.equal(planRotation(BASE, { keep: 3, date: DATE }).counts.done, 1);
  });
  it("the default --keep is 5", () => {
    const rows = Array.from({ length: 8 }, (_, i) => `| T-${i} | t${i} | d |`);
    const q = join$("## Recently done", "", "| ID | T | Done |", "| - | - | - |", ...rows);
    const s = sandbox(q);
    const r = run(["rotate", "--queue", s.queue, "--archive", s.archive, "--dry-run"]);
    assert.equal(r.stdout, "would move 3 rows (0 active, 0 blocked, 3 done)\n");
  });

  it("a malformed Active/Blocked row stops the rotation: exit 2, nothing touched", () => {
    const bad = BASE.replace(/\| queued +\| P1/, "| queued | extra | P1");
    assert.notEqual(bad, BASE, "fixture edit must apply");
    const s = sandbox(bad);
    const q0 = bytes(s.queue);
    const r = rotateFiles({ queue: s.queue, archive: s.archive, keep: 1, date: DATE });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /malformed/);
    assert.match(r.stderr, new RegExp(`L${lineNo(bad, "T-1.1")}\\b`));
    assert.deepEqual(bytes(s.queue), q0);
    assert.equal(existsSync(s.archive), false);
  });
  it("a malformed row in ANY section but Recently done stops the rotation too (## Parked): exit 2, nothing touched", () => {
    const bad =
      BASE + "\n## Parked\n\n| ID | T | S |\n| --- | --- | --- |\n| P-1 | t | queued | extra |\n";
    const s = sandbox(bad);
    const q0 = bytes(s.queue);
    const r = rotateFiles({ queue: s.queue, archive: s.archive, keep: 1, date: DATE });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /malformed/);
    assert.match(r.stderr, new RegExp(`L${lineNo(bad, "P-1")}\\b`));
    assert.deepEqual(bytes(s.queue), q0);
    assert.equal(existsSync(s.archive), false);
  });
  it("a missing archive directory or queue file is exit 2 with the queue untouched", () => {
    const s = sandbox();
    const q0 = bytes(s.queue);
    const r = rotateFiles({ queue: s.queue, archive: join(s.dir, "nope", "A.md"), date: DATE });
    assert.equal(r.code, 2);
    assert.deepEqual(bytes(s.queue), q0);
    // ...and a dry run must not promise a rotation the real run cannot do
    const dry = rotateFiles({
      queue: s.queue,
      archive: join(s.dir, "nope", "A.md"),
      dryRun: true,
      date: DATE,
    });
    assert.equal(dry.code, 2);
    assert.match(dry.stderr, /does not exist/);
    assert.equal(
      rotateFiles({ queue: join(s.dir, "absent.md"), archive: s.archive, date: DATE }).code,
      2,
    );
  });

  // Falsification (each checked on a scratch copy of the module): decode the queue in rotateFiles with a
  // NON-strict TextDecoder (`new TextDecoder("utf-8")`, or `fatal: false` on the shared DECODER) and a kept
  // live row's lone 0xE9 byte silently becomes U+FFFD in the rewritten queue. rotate still returns 0,
  // because its self-verify compares DECODED text on both sides, so the corruption is invisible to it.
  it("a lone non-UTF-8 byte (0xE9) in a KEPT live row is refused: exit 2, queue bytes unchanged, no archive", () => {
    const [head, tail] = BASE.split("**Alpha** live thing");
    const poisoned = Buffer.concat([
      Buffer.from(head + "**Alpha** caf"),
      Buffer.from([0xe9]),
      Buffer.from(" live thing" + tail),
    ]);
    assert.throws(
      () => new TextDecoder("utf-8", { fatal: true }).decode(poisoned),
      "the fixture must really be invalid UTF-8",
    );
    const sha = (buf) => createHash("sha256").update(buf).digest("hex");
    for (const dryRun of [false, true]) {
      const s = sandbox();
      writeFileSync(s.queue, poisoned);
      const r = rotateFiles({ queue: s.queue, archive: s.archive, dryRun, date: DATE });
      assert.equal(r.code, 2, `dryRun=${dryRun}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /not valid UTF-8/);
      assert.equal(sha(bytes(s.queue)), sha(poisoned), "queue bytes must be untouched");
      assert.equal(existsSync(s.archive), false, "no archive may be created");
    }
    // The same through the CLI entry point.
    const s = sandbox();
    writeFileSync(s.queue, poisoned);
    const r = cli(["rotate", "--queue", s.queue, "--archive", s.archive]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(sha(bytes(s.queue)), sha(poisoned));
    assert.equal(existsSync(s.archive), false);
  });

  it("CRLF queue: non-moved lines keep their CRLF, the archive is LF, verify passes", () => {
    const crlf = BASE.replaceAll("\n", "\r\n");
    const s = sandbox(crlf);
    const r = rotateFiles({ queue: s.queue, archive: s.archive, keep: 1, date: DATE });
    assert.equal(r.code, 0, r.stderr);
    const out = readFileSync(s.queue, "utf8");
    assert.doesNotMatch(out, /[^\r]\n/);
    assert.equal(
      out,
      without(crlf, ["| B-2 ", "| B-3 ", "**Golf done**", "| T-8 ", "| T-7 ", "**Six**"]),
    );
    assert.equal(readFileSync(s.archive, "utf8").includes("\r"), false);
  });
  it("no trailing newline: kept rows stay as they were; a moved final row is still lossless", () => {
    const noNl = BASE.slice(0, -1);
    const kept = sandbox(noNl);
    assert.equal(
      rotateFiles({ queue: kept.queue, archive: kept.archive, keep: 4, date: DATE }).code,
      0,
    );
    assert.equal(readFileSync(kept.queue, "utf8").endsWith("**Six** four  | 2026-01-06 |"), true);
    const moved = sandbox(noNl);
    assert.equal(
      rotateFiles({ queue: moved.queue, archive: moved.archive, keep: 0, date: DATE }).code,
      0,
    );
    assert.equal(existsSync(moved.archive), true);
  });
  it("rows after blank lines inside a section rotate with that section's header", () => {
    const q = join$(
      "## Active",
      "",
      "| ID | T | Status |",
      "| - | - | - |",
      "| A | t | queued |",
      "",
      "| B | t | done |",
      "",
      "| C | t | cancelled |",
    );
    const s = sandbox(q);
    assert.equal(rotateFiles({ queue: s.queue, archive: s.archive, date: DATE }).code, 0);
    const archive = readFileSync(s.archive, "utf8");
    assert.match(
      archive,
      /## Active\n\n\| ID \| T \| Status \|\n\| --- \| --- \| --- \|\n\| B \| t \| done \|\n\| C \| t \| cancelled \|\n/,
    );
  });
  it("the archive is written with exclusive create, so a racing creator cannot be clobbered", () => {
    const s = sandbox();
    const r = rotateFiles({
      queue: s.queue,
      archive: s.archive,
      keep: 1,
      date: DATE,
      beforeArchiveWrite: () => writeFileSync(s.archive, "RACER\n"),
    });
    assert.equal(r.code, 2);
    assert.equal(readFileSync(s.archive, "utf8"), "RACER\n");
    assert.deepEqual(bytes(s.queue), Buffer.from(BASE));
  });
});

// --- residual -------------------------------------------------------------------------

describe("residual", () => {
  it("residualKeywords: case-insensitive, de-duplicated, in order of appearance", () => {
    assert.deepEqual(residualKeywords("Follow-up still PENDING; Still tracked, followup, TODO"), [
      "follow-up",
      "still",
      "pending",
      "tracked",
      "followup",
      "todo",
    ]);
    assert.deepEqual(residualKeywords("one open question remaining; pends"), [
      "open question",
      "remaining",
      "pends",
    ]);
    assert.deepEqual(residualKeywords("all clean"), []);
    assert.deepEqual(residualKeywords(""), []);
  });
  it("flags keyword rows among CLOSED rows only, as `L<line>\\t<handle>\\t<keywords>`", () => {
    const q = join$(
      "## Active",
      "",
      "| ID | T | Status |",
      "| - | - | - |",
      "| A-1 | live row, still pending | queued |",
      "| A-2 | closed, follow-up filed | done |",
      "| — | **Closed no handle id** TODO later | cancelled |",
      "| A-4 | closed and clean | done |",
      "",
      "## Recently done",
      "",
      "| ID | T | Done |",
      "| - | - | - |",
      "| R-1 | merged; remaining nit | d |",
      "| R-2 | merged | d |",
    );
    const s = sandbox(q);
    const r = cli(["residual", s.queue]);
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      [
        `L${lineNo(q, "A-2 |")}\tA-2\tfollow-up`,
        `L${lineNo(q, "TODO later")}\tClosed no handle id\ttodo`,
        `L${lineNo(q, "R-1 |")}\tR-1\tremaining`,
        "",
      ].join("\n"),
    );
  });
  it("no matches prints nothing and exits 0", () => {
    const s = sandbox("## Active\n\n| ID | T | S |\n| - | - | - |\n| A | clean | done |\n");
    const r = cli(["residual", s.queue]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

// --- CLI contract -----------------------------------------------------------------------

describe("CLI (real process)", () => {
  it("normalize <file> writes the normalized file to stdout, exit 0", () => {
    const s = sandbox();
    const r = proc(["normalize", s.queue]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, normalize(BASE));
    assert.equal(r.stderr, "");
  });
  it("normalize on an unreadable file is exit 2 with a message on stderr", () => {
    const r = proc(["normalize", join(tmp(), "absent.md")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read/);
    assert.equal(r.stdout, "");
  });
  it("invalid UTF-8 is refused (exit 2) rather than silently rewritten", () => {
    const dir = tmp();
    const p = join(dir, "bad.md");
    writeFileSync(p, Buffer.from([0x7c, 0x20, 0xff, 0xfe, 0x20, 0x7c, 0x0a]));
    const r = proc(["normalize", p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /UTF-8/);
  });
  it("keeps a leading BOM byte-for-byte", () => {
    const dir = tmp();
    const p = join(dir, "bom.md");
    writeFileSync(p, "\uFEFF# T\n| a  | b |\n");
    assert.equal(proc(["normalize", p]).stdout, "\uFEFF# T\n| a | b |\n");
  });
  it("a usage error is exit 2 with the usage text on stderr and nothing on stdout", () => {
    const r = proc(["frobnicate"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node scripts\/queue-rows\.mjs/);
    assert.equal(r.stdout, "");
  });
  it("importing the module (as this suite does) never runs the CLI", () => {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import ${JSON.stringify(pathToFileURL(SCRIPT).href)};`],
      { encoding: "utf8" },
    );
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  });
  it("runs when launched through a symlink (entry guard compares real paths)", () => {
    const dir = tmp();
    const link = join(dir, "link.mjs");
    symlinkSync(SCRIPT, link);
    const p = join(dir, "q.md");
    writeFileSync(p, "| a  | b |\n");
    const r = proc(["normalize", p], link);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "| a | b |\n");
  });
  it("verify: exit 1 on a lossy rewrite, exit 2 for an unreadable input", () => {
    const s = sandbox();
    const lossy = join(s.dir, "lossy.md");
    writeFileSync(lossy, without(BASE, ["| B-3 "]));
    const bad = proc(["verify", "--before", s.queue, "--after", lossy]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^MISSING id B-3$/m);
    const unreadable = proc(["verify", "--before", s.queue, "--after", join(s.dir, "absent.md")]);
    assert.equal(unreadable.status, 2);
  });
  it("T4's invocation: verify --before <old> --after <archive> --live <index> with L live rows", () => {
    const s = sandbox();
    const idx = join(s.dir, "index.md");
    writeFileSync(
      idx,
      join$(
        "## Active",
        "",
        "| ID | Title | Status | Priority | Depends on |",
        "| --- | --- | --- | --- | --- |",
        "| T-1.1 | Alpha | queued | P1 | \u2014 |",
        "| \u2014 | **Charlie handle** unlabeled | in-progress | P3 | \u2014 |",
        "| B-5 | Echo | DEFERRED | P4 | \u2014 |",
        "",
        "## Blocked",
        "",
        "| ID | Title | Status | Priority | Blocker |",
        "| --- | --- | --- | --- | --- |",
        "| B-4 | Foxtrot | blocked | P1 | Sean |",
      ),
    );
    const archive = join(s.dir, "archive.md");
    writeFileSync(
      archive,
      `# QUEUE snapshot \u2014 ${DATE}\n\n> header\n\n${MARKER}\n${normalize(BASE)}`,
    );
    const r = proc(["verify", "--before", s.queue, "--after", archive, "--live", idx]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(
      r.stdout,
      "rows: before=11 matched=11\nids: before=8 matched=8\nlive: required=4 present=4\n",
    );
    // the snapshot is lossless by the spec's own sed|cmp recipe: everything after the marker == normalize()
    const body = readFileSync(archive, "utf8").split(MARKER + "\n")[1];
    assert.equal(body, normalize(BASE));
  });
});

describe("CLI (in-process)", () => {
  it("the usage text says --live also checks that carried cells are unchanged (a same-moment re-index check)", () => {
    // Falsification: drop the `--live` explanation from USAGE and this goes red.
    const { stderr } = cli(["verify"]);
    assert.match(stderr, /--live[^\n]*\n[^\n]*unchanged/, stderr);
    assert.match(stderr, /same-moment/, stderr);
  });
  it("usage errors are exit 2, name the problem, and print the usage text", () => {
    const base = ["rotate", "--queue", "q", "--archive", "a"];
    for (const [args, why] of [
      [[], /no command/],
      [["frobnicate"], /unknown command frobnicate/],
      [["normalize"], /exactly one <file>/],
      [["normalize", "a", "b"], /exactly one <file>/],
      [["normalize", "--bogus"], /unknown option --bogus/],
      [["residual"], /exactly one <file>/],
      [["verify"], /--before is required/],
      [["verify", "--before", "x"], /--after is required/],
      [["verify", "--after", "x"], /--before is required/],
      [["verify", "--before", "x", "--after"], /--after needs at least one file/],
      [["verify", "--before"], /--before needs a value/],
      [["verify", "--before", "--after", "y"], /--before needs a value/],
      [["verify", "--before", "x", "--after", "y", "--bogus", "z"], /unknown option --bogus/],
      [["verify", "--before", "x", "--before", "y", "--after", "z"], /--before given twice/],
      [
        ["verify", "--before", "x", "--after", "y", "--live", "a", "--live", "b"],
        /--live given twice/,
      ],
      [["rotate", "--queue", "q"], /--archive is required/],
      [["rotate", "--archive", "a"], /--queue is required/],
      [
        ["verify", "--before", "x", "--after", "y", "--live", "a", "stray"],
        /unexpected argument stray/,
      ],
      [[...base, "stray"], /unexpected argument stray/],
      [[...base, "--keep", "abc"], /--keep must be a non-negative integer/],
      [[...base, "--keep", "-1"], /--keep must be a non-negative integer/],
      [[...base, "--keep", "1.5"], /--keep must be a non-negative integer/],
      [[...base, "--keep", ""], /--keep must be a non-negative integer/],
      [[...base, "--keep"], /--keep needs a value/],
    ]) {
      const r = cli(args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, why, JSON.stringify(args));
      assert.match(r.stderr, /usage: node scripts\/queue-rows\.mjs/, JSON.stringify(args));
      assert.equal(r.stdout, "");
    }
  });
  it("verify: --after takes several files (a shell glob), and the flag may repeat", () => {
    const s = sandbox();
    const a = join(s.dir, "a.md");
    const b = join(s.dir, "b.md");
    writeFileSync(a, without(BASE, ["| T-9 ", "| T-8 "]));
    writeFileSync(b, "| T-9 | **Nine** one | 2026-01-09 |\n| T-8 | **Eight** two | 2026-01-08 |\n");
    const one = cli(["verify", "--before", s.queue, "--after", a, b]);
    assert.equal(one.status, 0, one.stdout);
    const two = cli(["verify", "--before", s.queue, "--after", a, "--after", b, "--live", s.queue]);
    assert.equal(two.status, 0, two.stdout);
    assert.match(two.stdout, /^live: required=4 present=4$/m);
  });
});

// --- prod-shaped: the real docs/QUEUE.md -------------------------------------------------------

describe("prod-shaped: the real docs/QUEUE.md", () => {
  const real = readFileSync(REAL_QUEUE, "utf8");
  const parsed = parseQueue(real);

  it("parses with zero errors (Recently-done malformed rows are tolerated)", () => {
    assert.deepEqual(parsed.errors, []);
    assert.ok(dataRows(parsed).length > 0);
  });
  it("normalize is idempotent and leaves every non-table line byte-identical", () => {
    const once = normalize(real);
    assert.equal(normalize(once), once);
    const a = splitLines(real);
    const b = splitLines(once);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      if (!a[i].text.trimStart().startsWith("|")) assert.equal(b[i].text, a[i].text);
      assert.equal(b[i].eol, a[i].eol);
    }
  });
  it("normalize changes only whitespace (and separator dashes): same cells row-for-row", () => {
    const once = normalize(real);
    const strip = (t) => dataRows(parseQueue(t)).map((r) => r.cells);
    assert.deepEqual(strip(once), strip(real));
  });
  it("real process: normalize <real> streams the whole result through a pipe, untruncated", () => {
    const r = proc(["normalize", REAL_QUEUE]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, normalize(real));
  });
  it("real process: a multi-megabyte normalize also arrives whole (the pre-shrink file was 750 KB)", () => {
    const rows = Array.from(
      { length: 600 },
      (_, i) => `| T-${i}    | **row ${i}** ${"w".repeat(4000)}     | queued | P1 | — |`,
    );
    const big = join(tmp(), "big.md");
    writeFileSync(
      big,
      join$("## Active", "", "| ID | T | S | P | D |", "| - | - | - | - | - |", ...rows),
    );
    const r = proc(["normalize", big]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length > 2_400_000);
    assert.equal(r.stdout, normalize(readFileSync(big, "utf8")));
  });
  it("verify --before X --after X exits 0 with N == M (CLI, real file)", () => {
    const r = cli(["verify", "--before", REAL_QUEUE, "--after", REAL_QUEUE]);
    assert.equal(r.status, 0, r.stdout.slice(0, 500));
    const m = /^rows: before=(\d+) matched=(\d+)\nids: before=(\d+) matched=(\d+)\n$/.exec(
      r.stdout,
    );
    assert.ok(m, r.stdout);
    assert.equal(m[1], m[2]);
    assert.equal(m[3], m[4]);
  });
  it("verify --live against itself: every live row present (L == P)", () => {
    const r = cli(["verify", "--before", REAL_QUEUE, "--after", REAL_QUEUE, "--live", REAL_QUEUE]);
    assert.equal(r.status, 0, r.stdout.slice(0, 500));
    const m = /^live: required=(\d+) present=(\d+)$/m.exec(r.stdout);
    assert.ok(m, r.stdout);
    assert.equal(m[1], m[2]);
    // Against itself every row matches by ID or exact handle: the substring fallback never fires.
    assert.doesNotMatch(r.stdout, /^WARN live /m);
  });
  it("verify --live against itself plus one new live row: required grows by exactly one", () => {
    const base = cli([
      "verify",
      "--before",
      REAL_QUEUE,
      "--after",
      REAL_QUEUE,
      "--live",
      REAL_QUEUE,
    ]);
    const required = Number(/^live: required=(\d+)/m.exec(base.stdout)?.[1]);
    assert.ok(required > 0, base.stdout.slice(0, 300));
    // A new ID-bearing row (the shape of a task added to the queue) right under the Active table's
    // separator, with the same cell count as that table's header.
    const header = parsed.rows.find((r) => r.kind === "header" && r.section === "Active");
    const separator = parsed.rows.find((r) => r.kind === "separator" && r.section === "Active");
    const cells = ["MG-T6", "**Simulated** new row", "queued", "P2", "—"];
    while (cells.length < header.cells.length) cells.push("—");
    const lines = splitLines(real).map((l) => l.text + l.eol);
    lines.splice(
      separator.line,
      0,
      "| " + cells.slice(0, header.cells.length).join(" | ") + " |\n",
    );
    const file = join(tmp(), "grown.md");
    writeFileSync(file, lines.join(""));
    const r = cli(["verify", "--before", file, "--after", file, "--live", file]);
    assert.equal(r.status, 0, r.stdout.slice(0, 500));
    assert.match(
      r.stdout,
      new RegExp(`^live: required=${required + 1} present=${required + 1}$`, "m"),
    );
  });
  it("rotate --dry-run reports counts that add up and writes nothing", () => {
    const dir = tmp();
    const archive = join(dir, "A.md");
    const r = cli([
      "rotate",
      "--queue",
      REAL_QUEUE,
      "--archive",
      archive,
      "--keep",
      "5",
      "--dry-run",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const m = /^would move (\d+) rows \((\d+) active, (\d+) blocked, (\d+) done\)\n$/.exec(
      r.stdout,
    );
    assert.ok(m, r.stdout);
    assert.equal(Number(m[1]), Number(m[2]) + Number(m[3]) + Number(m[4]));
    assert.equal(existsSync(archive), false);
  });
  it("a real rotation of a COPY is lossless: new queue + archive verify against the original", () => {
    const dir = tmp();
    const copy = join(dir, "QUEUE.md");
    const original = join(dir, "original.md");
    const archive = join(dir, "ARCHIVE.md");
    writeFileSync(copy, real);
    writeFileSync(original, real);
    const rot = cli(["rotate", "--queue", copy, "--archive", archive, "--keep", "5"]);
    assert.equal(rot.status, 0, rot.stdout.slice(0, 500) + rot.stderr);
    const moved = Number(/^moved (\d+) rows/.exec(rot.stdout)?.[1]);
    if (moved > 0) {
      const v = cli(["verify", "--before", original, "--after", copy, archive, "--live", copy]);
      assert.equal(v.status, 0, v.stdout.slice(0, 500));
    } else {
      assert.equal(existsSync(archive), false);
    }
  });
  it("residual lines are `L<n>\\t<handle>\\t<keywords>` and every flagged row is closed", () => {
    const r = cli(["residual", REAL_QUEUE]);
    assert.equal(r.status, 0);
    const closedLines = new Set(
      dataRows(parsed)
        .filter((x) => x.closed)
        .map((x) => x.line),
    );
    for (const l of r.stdout.split("\n").filter(Boolean)) {
      const m = /^L(\d+)\t[^\t]*\t[^\t]+$/.exec(l);
      assert.ok(m, l);
      assert.ok(closedLines.has(Number(m[1])), l);
    }
  });
});
