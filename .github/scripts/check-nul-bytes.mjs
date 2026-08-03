#!/usr/bin/env node
/**
 * Guard: no raw NUL (U+0000) bytes in tracked SOURCE files.
 *
 * WHY THIS EXISTS. Git classifies any blob with a NUL in its first 8000 bytes
 * as binary. A single stray NUL in a `.ts` file therefore:
 *   - strips the file from `gh pr diff` (`Binary files … differ`, zero content
 *     lines) and from GitHub's Files-changed tab, so reviewers review a hole;
 *   - makes BSD `grep -n <symbol> <file>` print nothing and exit 1 SILENTLY,
 *     so an agent grepping the codebase concludes the symbol does not exist;
 *   - kills `git blame -L`, `git add -p` and line-level review on that file
 *     permanently.
 *
 * `tsc`, `eslint` and `expo lint` all pass with a raw NUL in place — nothing
 * else in the toolchain catches it. `.claude/rules/server.md` has carried this
 * as a written rule since T-5.1, but it is path-scoped to `apps/server/**`, so
 * it never loads for anyone working in `apps/mobile`. It recurred there in
 * PR #18 (a 6641-byte production module reviewed by five lanes, none of which
 * could see a line of it). A rule that only fires in one directory is not a
 * guard; this is.
 *
 * The fix at any call site is always the same: write the escape — backslash,
 * `u`, `0000` — never the raw byte. Identical runtime value, plain-text file.
 * (This comment cannot show the character it is about, for the same reason.)
 *
 * Scope: an explicit SOURCE-extension allowlist. `.png` / `.parquet` fixtures
 * are legitimately binary and are not scanned — an allowlist (rather than a
 * binary-file denylist) means a newly added binary format cannot silently
 * widen the guard's blind spot.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Text formats tracked in this repo. Extend deliberately, never by accident. */
export const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "json",
  "md",
  "yml",
  "yaml",
  "sh",
  "sql",
  "svg",
  "css",
  "html",
  "txt",
]);

/** True when `file` is one of the text formats this guard is responsible for. */
export function isSourceFile(file) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // Dotfiles (`.gitignore`, `.prettierignore`) have no extension to speak of
  // but are plain text — scan them.
  if (dot <= 0) return true;
  return SOURCE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Scan `files` for raw NUL bytes.
 *
 * `read` is injected so the unit test can drive this without touching the
 * working tree (and, importantly, without committing a NUL-bearing fixture —
 * which would itself trip the guard).
 *
 * Returns `[{ file, offset }]`, one entry per offending file (first offset).
 */
export function findNulBytes(files, read = (f) => readFileSync(f)) {
  const hits = [];
  for (const file of files) {
    if (!isSourceFile(file)) continue;
    const buffer = read(file);
    const offset = buffer.indexOf(0);
    if (offset !== -1) hits.push({ file, offset });
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

export function main() {
  const hits = findNulBytes(trackedFiles());
  if (hits.length === 0) {
    // `warn` not `log` — the root eslint config allows warn/error only.
    console.warn("OK — no raw NUL bytes in tracked source files.");
    return 0;
  }
  for (const { file, offset } of hits) {
    console.error(
      `::error file=${file}::Raw NUL byte at offset ${offset}. ` +
        "Git treats this file as BINARY: it vanishes from `gh pr diff` and " +
        "`grep` exits 1 in silence. Write the escape \\u0000 instead.",
    );
  }
  return 1;
}

// `node check-nul-bytes.mjs` runs the check; importing it (the test) does not.
if (process.argv[1] && process.argv[1].endsWith("check-nul-bytes.mjs")) {
  process.exit(main());
}
