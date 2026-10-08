#!/usr/bin/env node
/**
 * scripts/queue-rows.mjs — QUEUE.md row tooling (plan-doc byte budgets, ADR-009).
 *
 * Zero dependencies. `docs/QUEUE.md` is a markdown table file whose rows grew to ~4.7 KB each
 * (prettier pads every cell to the widest cell in its column), so a plain `git diff` or `grep`
 * on it is useless and moving rows by hand is how history gets lost. This tool makes rotating
 * rows out of the live index mechanical and *checkable*:
 *
 *   normalize <file>                       padding-trimmed copy to stdout (whitespace-only change)
 *   verify --before <f> --after <f>... [--live <f>]
 *                                          prove nothing was lost: rows (multiset), IDs, live rows
 *                                          (--live: present AND their carried cells unchanged)
 *   rotate --queue <f> --archive <path> [--keep 5] [--dry-run]
 *                                          move closed rows into a NEW archive, then self-verify
 *   residual <file>                        closed rows whose text still mentions open work
 *
 * Exit codes: 0 ok · 1 a verification failed · 2 usage / unreadable input / refused (nothing touched).
 *
 * Row model, shared by every command:
 *   - A table row is a line whose first non-space/tab char is `|` and that has >= 1 cell.
 *     Cells split on a `|` NOT preceded by a backslash (GFM `\|`); the empty first/last
 *     segments are dropped; each cell loses leading/trailing spaces and tabs (nothing else:
 *     NBSP and inner runs of spaces are content).
 *   - Normalized row = "| " + cells.join(" | ") + " |". Separator rows (every cell `:?-+:?`)
 *     become `| --- | … |`. Every other line passes through byte-identical, with its own line
 *     ending (LF, CRLF, or none on the last line) preserved.
 *   - Fenced code blocks are not tracked: a `|`-leading line inside one is treated as a row. The
 *     queue never contains fences; if it ever does, add fence tracking here and in the tests.
 *   - Section = the nearest preceding `## ` heading; status is cell[2] lower-cased in
 *     `Active`/`Blocked`, always `done` in `Recently done`, `unknown` elsewhere (live).
 *     Closed = done|cancelled. A data row whose cell count differs from its header's (or that has
 *     no header) is malformed: an error in every section but Recently done (all of those are live),
 *     tolerated in Recently done.
 *   - A row's ID is its first cell unless that is empty or `—`; ID-less rows are identified by a
 *     handle: the first `**bold**` lead of the Title (else the whole Title), first 40 code points.
 *
 * Behaviours worth knowing before you rely on them:
 *   - `rotate` never overwrites: an existing archive (even on --dry-run) is exit 2, nothing touched.
 *     It writes the archive first (exclusive create), then the queue, re-reads both from disk and
 *     runs `verify`; on failure the queue is rewritten from its original bytes and the archive
 *     removed. The archive is always LF; the queue keeps each surviving line's own ending.
 *   - `verify --live` pairs every live `before` row one-to-one with an index row that is itself live:
 *     well-formed, outside `Recently done`, and not marked done/cancelled (live is defined by status,
 *     not by section). An ID row pairs by its ID *cell*; an ID-less row by an index row whose own handle
 *     equals its handle, else (with a `WARN`) by an index row whose Title *cell* contains the handle.
 *     A malformed row in any section but `Recently done`, in `before` or the index, is an `ERROR`
 *     and fails the run.
 *   - `verify --live` is also a SAME-MOMENT re-index check: for every before -> index pair it compares
 *     the section, the ID cell (`id`) and every cell after the Title (status, priority, depends/owner,
 *     ...), printing
 *     `CHANGED live <handle-or-ID> (before L<b> -> index L<i>) <column>: "<old>" -> "<new>"` for each
 *     difference and failing the run. The Title is exempt (the index shortens it by design). So
 *     "present" proves the row survived and "unchanged" proves its cells did; a deliberate status or
 *     priority change belongs in a separate sync commit made AFTER the rotation, never inside one.
 *   - `residual` is a substring match, so `pends` also fires on "depends" and `still` on "distilled".
 *     It over-reports on purpose: every hit is a prompt to check, not a verdict.
 */
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

// --- constants -------------------------------------------------------------------

/** The line after which an archive's body begins (`sed '1,/^MARKER$/d' archive` recovers it). */
export const MARKER = "<!-- verbatim snapshot below -->";
/** Keywords that suggest a closed row still carries open work (matched case-insensitively). */
export const RESIDUAL_SOURCE =
  "follow-?up|pending|pends|still|tracked|TODO|remaining|open question";

const CLOSED = new Set(["done", "cancelled"]);
const SEPARATOR_CELL = /^:?-+:?$/;
const HANDLE_CODE_POINTS = 40;
const MISSING_ROW_CHARS = 100;
const WARN_TITLE_CHARS = 60;
const CHANGED_CELL_CHARS = 100;

const USAGE = [
  "usage: node scripts/queue-rows.mjs <command> ...",
  "  normalize <file>",
  "  verify --before <file> --after <file>... [--live <file>]",
  "      --live: every live row is present AND its section, ID cell and every cell after the Title",
  "      are unchanged (a same-moment re-index check; a deliberate status change is a",
  "      separate sync commit, not part of a rotation)",
  "  rotate --queue <file> --archive <path> [--keep 5] [--dry-run]",
  "  residual <file>",
  "",
].join("\n");

// --- lines and cells ---------------------------------------------------------------

/** Spaces and tabs only: what prettier pads with. `String#trim` would also eat NBSP content. */
const trimPad = (s) => s.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * Split text into lines, each remembering its own terminator so output can be reassembled
 * byte-for-byte. `text` excludes the terminator; `eol` is "\n", "\r\n", or "" (last line only).
 */
export function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      lines.push({ text: text.slice(start), eol: "" });
      break;
    }
    const crlf = nl > start && text[nl - 1] === "\r";
    lines.push({ text: text.slice(start, crlf ? nl - 1 : nl), eol: crlf ? "\r\n" : "\n" });
    start = nl + 1;
  }
  return lines;
}

/** Cells of a pipe-delimited line (see header comment). Works on any line; callers gate on `cellsOf`. */
export function splitCells(line) {
  const segments = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") {
      segments.push(line.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(line.slice(start));
  if (trimPad(segments[0]) === "") segments.shift();
  if (segments.length > 0 && trimPad(segments[segments.length - 1]) === "") segments.pop();
  return segments.map(trimPad);
}

/** Cells if `line` is a table row (first non-space/tab char is `|`, at least one cell), else null. */
function cellsOf(line) {
  if (!/^[ \t]*\|/.test(line)) return null;
  const cells = splitCells(line);
  return cells.length > 0 ? cells : null;
}

const isSeparatorCells = (cells) => cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c));
const rowText = (cells) => "| " + cells.join(" | ") + " |";
const separatorText = (count) => rowText(Array.from({ length: count }, () => "---"));
const hasId = (cell) => cell !== undefined && cell !== "" && cell !== "—";

/** Copy of `text` with prettier padding stripped from every table row; all else byte-identical. */
export function normalize(text) {
  let out = "";
  for (const { text: line, eol } of splitLines(text)) {
    const cells = cellsOf(line);
    if (cells === null) out += line + eol;
    else out += (isSeparatorCells(cells) ? separatorText(cells.length) : rowText(cells)) + eol;
  }
  return out;
}

/** Identity of a row for ID-less items (see header comment). */
export function handleOf(cells) {
  if (hasId(cells[0])) return cells[0];
  const title = cells[1] ?? "";
  let lead = title;
  const open = title.indexOf("**");
  if (open !== -1) {
    const close = title.indexOf("**", open + 3); // >= 1 char of bold text
    if (close !== -1) lead = title.slice(open + 2, close);
  }
  // 40 code points live within the first 80 UTF-16 units; slicing first keeps huge cells cheap.
  return Array.from(lead.slice(0, HANDLE_CODE_POINTS * 2))
    .slice(0, HANDLE_CODE_POINTS)
    .join("")
    .trimEnd();
}

/** First `n` code points (never splits a surrogate pair). */
const firstChars = (s, n) =>
  Array.from(s.length > n * 2 ? s.slice(0, n * 2) : s)
    .slice(0, n)
    .join("");

// --- parsing --------------------------------------------------------------------------

/**
 * @typedef {object} Row
 * @property {number} line 1-based line number in the parsed text
 * @property {"header"|"separator"|"data"} kind
 * @property {string} section nearest preceding `## ` heading ("" before any)
 * @property {string[]} cells
 * @property {string} text normalized row
 * @property {Row|null} [header] data rows: the header row they sit under
 * @property {string|null} [id]
 * @property {string} [handle]
 * @property {string} [status]
 * @property {boolean} [closed]
 * @property {boolean} [malformed]
 */

/**
 * Classify every table row. Returns `{ rows, errors }`: `rows` holds header/separator/data rows in
 * file order; `errors` lists malformed rows in every section but Recently done (those are all live,
 * and a ragged row's status cannot be trusted). Recently done is tolerated: its status is fixed.
 */
export function parseQueue(text) {
  const lines = splitLines(text);
  const rows = [];
  const errors = [];
  let section = "";
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      header = null;
      continue;
    }
    const cells = cellsOf(line);
    if (cells === null) continue;
    const lineNo = i + 1;
    if (isSeparatorCells(cells)) {
      rows.push({
        line: lineNo,
        kind: "separator",
        section,
        cells,
        text: separatorText(cells.length),
      });
      continue;
    }
    const next = i + 1 < lines.length ? cellsOf(lines[i + 1].text) : null;
    if (next !== null && isSeparatorCells(next)) {
      header = { line: lineNo, kind: "header", section, cells, text: rowText(cells) };
      rows.push(header);
      continue;
    }
    const malformed = header === null || cells.length !== header.cells.length;
    const inLiveTables = section === "Active" || section === "Blocked";
    const error = malformed && section !== "Recently done";
    let status = "unknown";
    if (section === "Recently done") status = "done";
    else if (inLiveTables) status = (cells[2] ?? "").toLowerCase() || "unknown";
    rows.push({
      line: lineNo,
      kind: "data",
      section,
      cells,
      text: rowText(cells),
      header,
      id: hasId(cells[0]) ? cells[0] : null,
      handle: handleOf(cells),
      status,
      closed: !error && CLOSED.has(status),
      malformed,
    });
    if (error) {
      errors.push({
        line: lineNo,
        message:
          header === null
            ? "no table header above it"
            : `${cells.length} cells, header has ${header.cells.length}`,
      });
    }
  }
  return { rows, errors };
}

/** Data rows (not header/separator) of a parse result. */
export const dataRows = (parsed) => parsed.rows.filter((r) => r.kind === "data");

/** Lower-cased distinct residual keywords in `text`, in order of first appearance. */
export function residualKeywords(text) {
  const found = [];
  for (const m of text.matchAll(new RegExp(RESIDUAL_SOURCE, "gi"))) {
    const kw = m[0].toLowerCase();
    if (!found.includes(kw)) found.push(kw);
  }
  return found;
}

/** `residual` output lines for a queue text: one per closed row that still mentions open work. */
export function residualLines(text) {
  const out = [];
  for (const r of dataRows(parseQueue(text))) {
    if (!r.closed) continue;
    const keywords = residualKeywords(r.text);
    if (keywords.length > 0) {
      out.push(`L${r.line}\t${r.handle.replace(/[\t\r\n]+/g, " ")}\t${keywords.join(",")}`);
    }
  }
  return out;
}

// --- verify ------------------------------------------------------------------------------

const titleOf = (row) => row.cells[1] ?? "";

/**
 * May this index row stand in for a required live row? Live is defined by STATUS (I-3): well-formed,
 * outside `Recently done`, and not `closed`. `closed` is read from the parsed status, so it is only ever
 * true for a done/cancelled row in Active/Blocked: a live row re-marked `done` but left in Active is
 * rejected. A row under an unknown section (`## Parked`) has status `unknown`, is live whatever its
 * cell says, and is judged the same way on the `before` and the index side. `rotate` never moves rows
 * out of unknown sections, so counting them cannot drop a row.
 */
const isOpenIndexRow = (r) => r.section !== "Recently done" && !r.malformed && !r.closed;

/**
 * Pair every required live row with its own row in the live index (one-to-one: an index row
 * satisfies at most one required row). Three passes, so an exact match is never stolen by a looser
 * one: (1) ID cell, (2) the index row's own handle equals the required handle, (3) the handle is a
 * substring of the index row's Title — reported as a fallback, since it can pair a dropped row with
 * a different row whose Title merely starts the same way.
 * @param {Row[]} required live `before` rows
 * @param {Row[]} candidates index data rows that are live (`isOpenIndexRow`)
 * @returns {{missingLive: Row[], fallbacks: {required: Row, found: Row}[], pairs: {required: Row, found: Row}[]}}
 *   `pairs` is every before-row -> index-row pairing (fallback ones included), in before-file order.
 */
function matchLive(required, candidates) {
  const taken = new Set();
  const pairs = [];
  const claim = (r, match) => {
    const hit = candidates.find((c) => !taken.has(c) && match(c));
    if (hit !== undefined) {
      taken.add(hit);
      pairs.push({ required: r, found: hit });
    }
    return hit;
  };
  const byId = required.filter((r) => r.id !== null);
  const byHandle = required.filter((r) => r.id === null && r.handle !== "");
  const missingLive = required.filter((r) => r.id === null && r.handle === "");
  for (const r of byId) if (claim(r, (c) => c.id === r.id) === undefined) missingLive.push(r);
  const loose = byHandle.filter((r) => claim(r, (c) => c.handle === r.handle) === undefined);
  const fallbacks = [];
  for (const r of loose) {
    const found = claim(r, (c) => titleOf(c).includes(r.handle));
    if (found === undefined) missingLive.push(r);
    else fallbacks.push({ required: r, found });
  }
  missingLive.sort((a, b) => a.line - b.line);
  pairs.sort((a, b) => a.required.line - b.required.line);
  return { missingLive, fallbacks, pairs };
}

/**
 * `--live` is a same-moment re-index check: a paired row must still carry the cells it had. Compares the
 * section, the ID cell and every cell after the Title (status, priority, depends/owner, ...); the Title is
 * exempt because the index shortens it by design. Differences come back in before-file order, section
 * first, then the ID cell (`id`), then by column. A missing cell (a dropped or shorter column) reads as
 * the empty string.
 * @param {{required: Row, found: Row}[]} pairs
 * @returns {string[]} `CHANGED live ...` lines
 */
function changedCellLines(pairs) {
  const clip = (s) =>
    Array.from(s).length > CHANGED_CELL_CHARS ? firstChars(s, CHANGED_CELL_CHARS) + "…" : s;
  const out = [];
  for (const { required: b, found: i } of pairs) {
    const diffs = [];
    if (b.section !== i.section) diffs.push(["section", b.section, i.section]);
    // An ID-less (`—`) row pairs by handle, so its ID cell can differ: `—` -> `B-999` is a real change.
    if ((b.cells[0] ?? "") !== (i.cells[0] ?? "")) {
      diffs.push(["id", b.cells[0] ?? "", i.cells[0] ?? ""]);
    }
    for (let k = 2; k < Math.max(b.cells.length, i.cells.length); k++) {
      const was = b.cells[k] ?? "";
      const now = i.cells[k] ?? "";
      if (was !== now) {
        const column = b.header?.cells[k] ?? i.header?.cells[k] ?? `column ${k + 1}`;
        diffs.push([column, was, now]);
      }
    }
    for (const [column, was, now] of diffs) {
      out.push(
        `CHANGED live ${b.handle} (before L${b.line} -> index L${i.line}) ${column}: "${clip(was)}" -> "${clip(now)}"`,
      );
    }
  }
  return out;
}

/**
 * Prove a rewrite lost nothing. `before` is the original text; `afters` the texts that should now
 * hold every row between them (new index + archive); `live` (optional) the new live index.
 * @returns {{ ok: boolean, lines: string[] }} `lines` is exactly what the CLI prints.
 */
export function verifyLossless({ before, afters, live }) {
  const beforeParsed = parseQueue(before);
  const beforeRows = dataRows(beforeParsed);

  // (1) rows: before ⊆ ⋃ afters, as a multiset (a row twice before needs two homes after).
  const pool = new Map();
  const afterIds = new Set();
  for (const text of afters) {
    for (const r of dataRows(parseQueue(text))) {
      pool.set(r.text, (pool.get(r.text) ?? 0) + 1);
      if (r.id !== null) afterIds.add(r.id);
    }
  }
  const missingRows = [];
  for (const r of beforeRows) {
    const left = pool.get(r.text) ?? 0;
    if (left > 0) pool.set(r.text, left - 1);
    else missingRows.push(r);
  }

  // (2) IDs: every distinct non-`—` ID cell of before is an ID cell somewhere in after.
  const beforeIds = [...new Set(beforeRows.filter((r) => r.id !== null).map((r) => r.id))];
  const missingIds = beforeIds.filter((id) => !afterIds.has(id));

  const summary = [
    `rows: before=${beforeRows.length} matched=${beforeRows.length - missingRows.length}`,
    `ids: before=${beforeIds.length} matched=${beforeIds.length - missingIds.length}`,
  ];
  const errors = [];
  const missing = [
    ...missingRows.map((r) => `MISSING row L${r.line}: ${firstChars(r.text, MISSING_ROW_CHARS)}`),
    ...missingIds.map((id) => `MISSING id ${id}`),
  ];
  const warnings = [];
  const changes = [];
  let ok = missingRows.length === 0 && missingIds.length === 0;

  // (3) live: every live before row is still in the live index.
  if (live !== undefined) {
    const liveRows = beforeRows.filter((r) => !r.closed);
    const liveParsed = parseQueue(live);
    const liveData = dataRows(liveParsed);
    const { missingLive, fallbacks, pairs } = matchLive(liveRows, liveData.filter(isOpenIndexRow));
    changes.push(...changedCellLines(pairs));
    summary.push(
      `live: required=${liveRows.length} present=${liveRows.length - missingLive.length}`,
    );
    // A malformed row (any section but Recently done) makes its status, hence "is it live?", unreliable.
    for (const e of beforeParsed.errors) {
      const row = beforeRows.find((r) => r.line === e.line);
      errors.push(
        `ERROR malformed row L${e.line} (${e.message}): ${firstChars(row.text, MISSING_ROW_CHARS)}`,
      );
    }
    // The index is checked too: a malformed row there makes its status (hence "is it live?") unreliable.
    for (const e of liveParsed.errors) {
      const row = liveData.find((r) => r.line === e.line);
      errors.push(
        `ERROR malformed --live row L${e.line} (${e.message}): ${firstChars(row.text, MISSING_ROW_CHARS)}`,
      );
    }
    for (const r of missingLive) {
      missing.push(
        r.handle === "" ? `MISSING live (empty handle, L${r.line})` : `MISSING live ${r.handle}`,
      );
    }
    for (const { required, found } of fallbacks) {
      warnings.push(
        `WARN live handle "${required.handle}" (before L${required.line}) matched only by substring: ` +
          `index L${found.line} "${firstChars(titleOf(found), WARN_TITLE_CHARS)}"`,
      );
    }
    const seen = new Map();
    for (const r of liveRows)
      if (r.handle !== "") seen.set(r.handle, (seen.get(r.handle) ?? 0) + 1);
    for (const [handle, n] of seen) if (n > 1) warnings.push(`WARN duplicate handle ${handle}`);
    ok = ok && missingLive.length === 0 && changes.length === 0 && errors.length === 0;
  }
  return { ok, lines: [...summary, ...errors, ...missing, ...changes, ...warnings] };
}

// --- rotate -------------------------------------------------------------------------------

const todayUtc = () => new Date().toISOString().slice(0, 10);

function renderArchive(moved, { date, keep }) {
  const groups = [];
  for (const r of moved) {
    let g = groups.find((x) => x.section === r.section && x.header === r.header);
    if (g === undefined) {
      g = { section: r.section, header: r.header, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }
  let body = "";
  let previousSection = null;
  for (const g of groups) {
    if (g.section !== previousSection) {
      if (body !== "") body += "\n";
      body += `## ${g.section}\n\n`;
      previousSection = g.section;
    } else {
      body += "\n";
    }
    if (g.header !== null)
      body += g.header.text + "\n" + separatorText(g.header.cells.length) + "\n";
    for (const r of g.rows) body += r.text + "\n";
  }
  const head = [
    `# QUEUE snapshot — ${date}`,
    "",
    `> Rows rotated out of \`docs/QUEUE.md\` on ${date} (status done/cancelled, and Recently done beyond the newest ${keep}).`,
    "> Append-only archive ([ADR-009](../decisions/ADR-009-plan-doc-byte-budgets.md)), prettier cell padding stripped",
    "> (whitespace-only: `node scripts/queue-rows.mjs normalize`). Live status is in `docs/QUEUE.md`, not here.",
    "> **Never read this file whole.** Grep by ID: `grep -nE '^\\| B-30 +\\|' docs/history/QUEUE-*.md`;",
    "> ID-less rows: `grep -nF '<handle>' docs/history/QUEUE-*.md`.",
    "",
    MARKER,
  ];
  return head.join("\n") + "\n" + body;
}

/**
 * Decide what a rotation would do. Closed rows leave Active/Blocked; Recently-done rows after the
 * first `keep` leave too. Every other line of the queue is kept byte-for-byte.
 * @returns {{errors: object[]} | {errors: [], counts: object, queueText: string, archiveText: string}}
 */
export function planRotation(text, { keep = 5, date = todayUtc() } = {}) {
  const parsed = parseQueue(text);
  if (parsed.errors.length > 0) return { errors: parsed.errors };
  const moved = [];
  const counts = { active: 0, blocked: 0, done: 0, total: 0 };
  let doneSeen = 0;
  for (const r of dataRows(parsed)) {
    if (r.section === "Recently done") {
      doneSeen++;
      if (doneSeen > keep) {
        moved.push(r);
        counts.done++;
      }
    } else if (r.closed && r.section === "Active") {
      moved.push(r);
      counts.active++;
    } else if (r.closed && r.section === "Blocked") {
      moved.push(r);
      counts.blocked++;
    }
  }
  counts.total = moved.length;
  const drop = new Set(moved.map((r) => r.line));
  const queueText = splitLines(text)
    .filter((_, i) => !drop.has(i + 1))
    .map((l) => l.text + l.eol)
    .join("");
  return { errors: [], counts, queueText, archiveText: renderArchive(moved, { date, keep }) };
}

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class CliError extends Error {
  constructor(message, { usage = false } = {}) {
    super(message);
    this.usage = usage;
  }
}

/** Read a file as strict UTF-8 (a BOM is kept as U+FEFF so it round-trips). */
function readText(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new CliError(`cannot read ${path}: ${e.code ?? e.message}`);
  }
  try {
    return DECODER.decode(bytes);
  } catch {
    throw new CliError(`cannot read ${path}: not valid UTF-8`);
  }
}

function pathExists(path) {
  try {
    lstatSync(path); // lstat: a dangling symlink at the archive path still counts as "exists"
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotate closed rows into a NEW archive file, then prove it lossless; restore on failure.
 * `afterWrite` / `beforeArchiveWrite` are test seams (corrupt a file, simulate a racing creator).
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function rotateFiles({
  queue,
  archive,
  keep = 5,
  dryRun = false,
  date = todayUtc(),
  afterWrite,
  beforeArchiveWrite,
}) {
  const result = (code, stdout = "", stderr = "") => ({ code, stdout, stderr });
  const refuse = () =>
    result(
      2,
      "",
      `refusing: archive ${archive} already exists (archives are append-only; use a new name, e.g. -2)\n`,
    );

  if (pathExists(archive)) return refuse();
  let original;
  let text;
  try {
    original = readFileSync(queue);
  } catch (e) {
    return result(2, "", `cannot read ${queue}: ${e.code ?? e.message}\n`);
  }
  try {
    text = DECODER.decode(original);
  } catch {
    return result(2, "", `cannot read ${queue}: not valid UTF-8\n`);
  }
  let archiveDirOk = false;
  try {
    archiveDirOk = statSync(dirname(archive)).isDirectory();
  } catch {
    // falls through to the refusal below
  }
  if (!archiveDirOk) return result(2, "", `archive directory ${dirname(archive)} does not exist\n`);

  const plan = planRotation(text, { keep, date });
  if (plan.errors.length > 0) {
    const where = plan.errors.map((e) => `L${e.line} (${e.message})`).join(", ");
    return result(
      2,
      "",
      `refusing: malformed row(s) outside Recently done, status unreliable: ${where}\n`,
    );
  }
  const { counts } = plan;
  const summary = `(${counts.active} active, ${counts.blocked} blocked, ${counts.done} done)`;
  if (dryRun) return result(0, `would move ${counts.total} rows ${summary}\n`);
  if (counts.total === 0) {
    return result(0, `moved 0 rows ${summary}; nothing to rotate, archive not created\n`);
  }

  // Undo our writes: the queue goes back to its original bytes, the archive we created is removed.
  // Returns what could NOT be undone (empty = fully restored).
  const restore = () => {
    const problems = [];
    try {
      writeFileSync(queue, original);
    } catch (e) {
      problems.push(`could not rewrite ${queue} (${e.code ?? e.message}); recover it with git`);
    }
    try {
      unlinkSync(archive);
    } catch (e) {
      if (e.code !== "ENOENT")
        problems.push(`could not remove ${archive} (${e.code ?? e.message})`);
    }
    return problems;
  };
  beforeArchiveWrite?.();
  try {
    writeFileSync(archive, plan.archiveText, { flag: "wx" }); // exclusive: never overwrite history
  } catch (e) {
    return e.code === "EEXIST"
      ? refuse()
      : result(2, "", `cannot write ${archive}: ${e.code ?? e.message}\n`);
  }
  try {
    writeFileSync(queue, plan.queueText);
  } catch (e) {
    const problems = restore();
    const state =
      problems.length === 0 ? "files restored" : `restore incomplete: ${problems.join("; ")}`;
    return result(1, "", `cannot write ${queue}: ${e.code ?? e.message}; ${state}\n`);
  }
  afterWrite?.({ queue, archive });

  // Then prove it again from what is actually on disk.
  let post;
  try {
    post = verifyLossless({ before: text, afters: [readText(queue), readText(archive)] });
  } catch (e) {
    post = { ok: false, lines: [e.message] };
  }
  if (!post.ok) {
    const problems = restore();
    const state =
      problems.length === 0
        ? "files restored (queue rewritten from its original bytes, archive removed)"
        : `restore incomplete: ${problems.join("; ")}`;
    return result(1, post.lines.join("\n") + "\n", `verify failed after writing; ${state}\n`);
  }
  return result(
    0,
    `moved ${counts.total} rows ${summary} -> ${archive}\n` + post.lines.join("\n") + "\n",
  );
}

// --- CLI ----------------------------------------------------------------------------------

/** @param {Record<string, "one"|"many"|"bool">} spec */
function parseFlags(args, spec) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const kind = spec[arg];
    if (kind === undefined) throw new CliError(`error: unknown option ${arg}`, { usage: true });
    if (kind === "bool") {
      flags[arg] = true;
    } else if (kind === "one") {
      if (arg in flags) throw new CliError(`error: ${arg} given twice`, { usage: true });
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`error: ${arg} needs a value`, { usage: true });
      }
      flags[arg] = value;
      i++;
    } else {
      const values = [];
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) values.push(args[++i]);
      if (values.length === 0)
        throw new CliError(`error: ${arg} needs at least one file`, { usage: true });
      flags[arg] = [...(flags[arg] ?? []), ...values];
    }
  }
  return { flags, positional };
}

function onePositional(args) {
  const { positional } = parseFlags(args, {});
  if (positional.length !== 1)
    throw new CliError("error: expected exactly one <file>", { usage: true });
  return positional[0];
}

function dispatch(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "normalize":
      return { code: 0, stdout: normalize(readText(onePositional(args))), stderr: "" };
    case "residual": {
      const lines = residualLines(readText(onePositional(args)));
      return { code: 0, stdout: lines.map((l) => l + "\n").join(""), stderr: "" };
    }
    case "verify": {
      const { flags, positional } = parseFlags(args, {
        "--before": "one",
        "--after": "many",
        "--live": "one",
      });
      if (positional.length > 0)
        throw new CliError(`error: unexpected argument ${positional[0]}`, { usage: true });
      if (flags["--before"] === undefined)
        throw new CliError("error: --before is required", { usage: true });
      if (flags["--after"] === undefined)
        throw new CliError("error: --after is required", { usage: true });
      const report = verifyLossless({
        before: readText(flags["--before"]),
        afters: flags["--after"].map(readText),
        live: flags["--live"] === undefined ? undefined : readText(flags["--live"]),
      });
      return { code: report.ok ? 0 : 1, stdout: report.lines.join("\n") + "\n", stderr: "" };
    }
    case "rotate": {
      const { flags, positional } = parseFlags(args, {
        "--queue": "one",
        "--archive": "one",
        "--keep": "one",
        "--dry-run": "bool",
      });
      if (positional.length > 0)
        throw new CliError(`error: unexpected argument ${positional[0]}`, { usage: true });
      if (flags["--queue"] === undefined)
        throw new CliError("error: --queue is required", { usage: true });
      if (flags["--archive"] === undefined)
        throw new CliError("error: --archive is required", { usage: true });
      if (flags["--keep"] !== undefined && !/^\d+$/.test(flags["--keep"])) {
        throw new CliError("error: --keep must be a non-negative integer", { usage: true });
      }
      return rotateFiles({
        queue: flags["--queue"],
        archive: flags["--archive"],
        keep: flags["--keep"] === undefined ? 5 : Number(flags["--keep"]),
        dryRun: flags["--dry-run"] === true,
      });
    }
    default:
      throw new CliError(
        command === undefined ? "error: no command given" : `error: unknown command ${command}`,
        {
          usage: true,
        },
      );
  }
}

/**
 * Run the CLI in-process. Returns what would be printed and the exit code; touches only the files
 * the command names. (`node scripts/queue-rows.mjs …` is a thin wrapper around this.)
 * @param {string[]} argv arguments after the script name
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function run(argv) {
  try {
    return dispatch(argv);
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    return { code: 2, stdout: "", stderr: e.message + "\n" + (e.usage ? USAGE : "") };
  }
}

const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // `| head` closes our stdout early; that is the reader's choice, not an error.
  process.stdout.on("error", (e) => {
    if (e.code !== "EPIPE") throw e;
  });
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  // exitCode, not process.exit(): lets a large stdout (the 200 KB normalize) drain through a pipe.
  process.exitCode = code;
}
