#!/usr/bin/env node
/**
 * Guard: the plan docs stay inside their BYTE budgets (ADR-009).
 *
 * WHY THIS EXISTS. `docs/STATE.md` is injected at interactive session start
 * (ADR-009); loop sessions read it explicitly. `docs/QUEUE.md` is read to pick
 * the next task. Both had grown without bound (STATE 64 KB / 997 lines, QUEUE
 * 756 KB, lines up to 4,754 chars): sessions paid for them in context, and the
 * hook's output cap silently truncated the part that mattered. Nothing in the
 * toolchain noticed. A written "keep it short" rule is not a guard; this is.
 *
 * WHY BYTES. A line cap is gamed by one very long line; a character cap is
 * gamed by multibyte text (`①` is 3 bytes, an emoji 4). What reaches the model
 * and what `grep` prints is bytes, so the caps are UTF-8 BYTES: `wc -c`, never
 * lines, never chars. Bytes >= chars, so a byte cap is also conservative against
 * the hook's 10,000-CHARACTER output cap.
 *
 * WHAT IS CHECKED (see BUDGETS, the single source; ADR-009 records the numbers):
 *   - file size in bytes                      (every budgeted file)
 *   - longest line in bytes                   (QUEUE only: rows stay index entries)
 *   - required headings, exact whole-line     (STATE and QUEUE: `grep -cxF` semantics, so
 *     `## NEXT SESSION  <!-- x -->` does NOT count, nor does a CRLF line ending)
 *   - the file exists and is a regular file   (so renaming STATE.md cannot pass
 *     silently by leaving nothing to measure)
 *
 * There is no lower bound on SIZE, but both files carry required headings, so
 * an empty STATE.md or QUEUE.md fails. QUEUE's three are the section headings
 * of the live format (I-2): `## Active`, `## Blocked`, `## Recently done`.
 * This is a cap plus a skeleton check, not a quality check.
 *
 * A line's bytes exclude its `\n` terminator; a `\r` before it DOES count.
 *
 * The fix is never to raise a number here. Raise one only by amending ADR-009
 * in the same change. The test pins the literals so that cannot happen quietly.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, from this file's location (cwd-independent). */
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * ADR-009 / spec I-1. `maxBytes` is on the whole file; `maxLineBytes` on each
 * line; `requiredHeadings` are exact whole-line matches.
 */
export const BUDGETS = [
  {
    path: "docs/STATE.md",
    maxBytes: 6144,
    requiredHeadings: [
      "## CURRENT DIRECTION",
      "## NEXT SESSION",
      "## In-flight decisions",
      "## Blockers / Waiting on Sean",
    ],
  },
  {
    path: "docs/QUEUE.md",
    maxBytes: 20480,
    maxLineBytes: 400,
    requiredHeadings: ["## Active", "## Blocked", "## Recently done"],
  },
];

/** One fix hint per file; the per-kind text is in `formatViolation`. */
const FIX_HINTS = {
  "docs/STATE.md":
    "STATE.md is the session brief (injected at interactive session start): replace, do not " +
    "append. Move narrative and resolved items to docs/history/STATE-<date>.md (run /tidy-docs).",
  "docs/QUEUE.md":
    "QUEUE.md is a live index: rotate closed rows with `node scripts/queue-rows.mjs rotate " +
    "--queue docs/QUEUE.md --archive docs/history/QUEUE-$(date -u +%F).md` (add -2 to the date " +
    "if that file exists; --dry-run previews) and keep detail in the PR " +
    "body, spec or ADR.",
};
const GENERIC_HINT = "Shrink the file, or amend ADR-009 and BUDGETS together.";

/** GitHub shows 10 annotations per step; the rest would only bury the log. */
export const MAX_LINE_ANNOTATIONS = 10;

/**
 * A path is untrusted-by-construction input to a workflow-command line (a
 * newline would start its own `::` command). Same neutralisation as
 * check-nul-bytes.mjs. BUDGETS paths are constants today; this keeps it so.
 */
export function safeAnnotationPath(file) {
  return file.replace(/[\r\n]+/g, " ").replaceAll("::", "__");
}

/**
 * Reader over a repo root. Returns the file's bytes, or `null` when the path
 * is absent or is not a REGULAR file (a directory would EISDIR; a symlink to
 * /dev/zero would read unbounded). Any other error (EACCES, EIO) is a real
 * fault and propagates rather than masquerading as "missing".
 */
export function makeFsReader(root) {
  return (path) => {
    const abs = join(root, path);
    let stats;
    try {
      stats = statSync(abs);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    return stats.isFile() ? readFileSync(abs) : null;
  };
}

/**
 * Measure every budgeted file once.
 *
 * `read(path)` returns a Buffer (or a string, taken as UTF-8), or
 * null/undefined for "no such file". Lines are split on the BYTE 0x0a in the
 * raw buffer, never on a decoded string, so invalid UTF-8 cannot inflate a
 * count through U+FFFD replacement.
 *
 * Returns `{ violations, sizes }`. A violation is
 * `{ path, kind: "missing"|"bytes"|"line"|"heading", actual, limit, line?, heading? }`:
 * `bytes`/`line` carry the measured and allowed byte counts, `heading` carries
 * the absent heading (actual 0, limit 1), `missing` has null for both.
 */
export function inspectBudgets(budgets, read) {
  const violations = [];
  const sizes = [];
  for (const budget of budgets) {
    const raw = read(budget.path);
    if (raw === null || raw === undefined) {
      violations.push({ path: budget.path, kind: "missing", actual: null, limit: null });
      continue;
    }
    const buffer = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const total = buffer.byteLength;
    sizes.push({ path: budget.path, bytes: total, maxBytes: budget.maxBytes });
    if (total > budget.maxBytes) {
      violations.push({ path: budget.path, kind: "bytes", actual: total, limit: budget.maxBytes });
    }

    const pending = (budget.requiredHeadings ?? []).map((heading) => ({
      heading,
      bytes: Buffer.from(heading, "utf8"),
    }));
    let start = 0;
    let line = 1;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      const end = newline === -1 ? buffer.length : newline;
      const lineBytes = end - start;
      if (budget.maxLineBytes !== undefined && lineBytes > budget.maxLineBytes) {
        violations.push({
          path: budget.path,
          kind: "line",
          actual: lineBytes,
          limit: budget.maxLineBytes,
          line,
        });
      }
      const slice = pending.length > 0 ? buffer.subarray(start, end) : null;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (slice.equals(pending[i].bytes)) pending.splice(i, 1);
      }
      if (newline === -1) break;
      start = newline + 1;
      line += 1;
    }
    for (const { heading } of pending) {
      violations.push({ path: budget.path, kind: "heading", actual: 0, limit: 1, heading });
    }
  }
  return { violations, sizes };
}

/** `[{ path, kind, actual, limit, line? }]`, empty when every budget holds. */
export function checkBudgets(budgets, read) {
  return inspectBudgets(budgets, read).violations;
}

/** The GitHub `::error` annotation for one violation. */
export function formatViolation(violation) {
  const file = safeAnnotationPath(violation.path);
  const hint = FIX_HINTS[violation.path] ?? GENERIC_HINT;
  switch (violation.kind) {
    case "missing":
      return (
        `::error file=${file}::file is missing or not a regular file (ADR-009). ` +
        "If it was renamed on purpose, update BUDGETS in this script and ADR-009 together."
      );
    case "bytes":
      return `::error file=${file}::${violation.actual} bytes > budget ${violation.limit} (ADR-009). ${hint}`;
    case "line":
      return (
        `::error file=${file},line=${violation.line}::${violation.actual} bytes > per-line cap ` +
        `${violation.limit} (ADR-009). A QUEUE row is an index entry: shorten the Title ` +
        "(160 chars recommended) and move the detail to the PR body, spec or ADR."
      );
    default:
      return (
        `::error file=${file}::missing required heading "${safeAnnotationPath(violation.heading)}" ` +
        "(ADR-009). It must be a whole line, exactly: no trailing text, no leading space, " +
        "no CRLF line ending."
      );
  }
}

/**
 * Returns the process exit code: 0 when every budget holds, 1 otherwise.
 *
 * `budgets`/`read`/`root` are injectable so the exit contract and the byte
 * arithmetic are testable without touching the working tree.
 */
export function main({ budgets = BUDGETS, read, root = DEFAULT_ROOT } = {}) {
  const { violations, sizes } = inspectBudgets(budgets, read ?? makeFsReader(root));
  if (violations.length === 0) {
    const parts = sizes.map(({ path, bytes, maxBytes }) => `${path} ${bytes}/${maxBytes} B`);
    // `warn` not `log` — the root eslint config allows warn/error only.
    console.warn(`OK — plan-doc budgets: ${parts.join(", ")}.`);
    return 0;
  }
  const shown = new Map();
  const omitted = new Map();
  for (const violation of violations) {
    if (violation.kind === "line") {
      const count = shown.get(violation.path) ?? 0;
      if (count >= MAX_LINE_ANNOTATIONS) {
        omitted.set(violation.path, (omitted.get(violation.path) ?? 0) + 1);
        continue;
      }
      shown.set(violation.path, count + 1);
    }
    console.error(formatViolation(violation));
  }
  for (const [path, count] of omitted) {
    console.error(
      `... and ${count} more line(s) over the per-line cap in ${safeAnnotationPath(path)} (not annotated).`,
    );
  }
  return 1;
}

const USAGE = "usage: node .github/scripts/check-doc-budgets.mjs [--root <dir>]";

/** `--root <dir>` / `--root=<dir>`; anything else is a usage error. */
export function parseArgs(argv) {
  let root;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value;
    if (arg === "--root") {
      value = argv[++i];
    } else if (arg.startsWith("--root=")) {
      value = arg.slice("--root=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error("--root needs a directory");
    }
    root = resolve(value);
  }
  return root === undefined ? {} : { root };
}

/**
 * Was this file the process entry point (run, not imported)? Compares the REAL paths of this module and
 * `argv[1]`: node resolves symlinks for `import.meta.url` but leaves `argv[1]` as typed, so a plain URL
 * compare misses a symlinked launcher and macOS's `/var` -> `/private/var` alias, and a filename match
 * (`endsWith("check-doc-budgets.mjs")`) misses a renamed copy. Each of those would exit 0 with no output,
 * which reads as "all budgets hold". Same form as scripts/queue-rows.mjs.
 */
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

// `node check-doc-budgets.mjs` runs the check; importing it (the test) does not.
if (invokedDirectly) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  process.exit(main(options));
}
