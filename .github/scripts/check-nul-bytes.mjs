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
import { lstatSync, readFileSync } from "node:fs";

/** Text formats tracked in this repo. Extend deliberately, never by accident. */
export const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "md",
  "mdx",
  "yml",
  "yaml",
  "toml",
  "sh",
  "sql",
  "svg",
  "css",
  "html",
  "txt",
  "snap",
  // `.env.example` — the one tracked file whose whole purpose is being read
  // by a human setting the project up, and the blind spot round 2 found.
  "example",
]);

/**
 * Binary asset formats this repo may legitimately track, i.e. the files the
 * scan is EXPECTED to skip.
 *
 * This lives in the script, not in the test, on purpose. The test asserts
 * `skipped ⊆ KNOWN_BINARY_EXTENSIONS`, so the first tracked file matching
 * neither set fails the guard job and forces a decision: is it text (add it to
 * SOURCE_EXTENSIONS and scan it) or an asset (add it here)? Both are one-line
 * edits HERE.
 *
 * The alternative — the test carrying its own regex of known-binary types —
 * puts the widening in the wrong file: the obvious way back to green becomes
 * "loosen the test", which silently reopens the blind spot the guard exists to
 * close. `expo-font` is already a dependency and an `app.json` plugin with no
 * font files tracked yet, so a `.ttf` landing on an unrelated PR was the
 * near-term trigger.
 */
export const KNOWN_BINARY_EXTENSIONS = new Set([
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "icns",
  // fonts (expo-font is a dep + app.json plugin; a .ttf is the likeliest next asset)
  "ttf",
  "otf",
  "woff",
  "woff2",
  // media
  "mp3",
  "mp4",
  "mov",
  "wav",
  // data / archives / signing
  "parquet",
  "zip",
  "gz",
  "pdf",
  "keystore",
  "jks",
  "mobileprovision",
]);

/** Extension of `file`, lowercased; "" for an extensionless name or dotfile. */
export function extensionOf(file) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** True when `file` is one of the text formats this guard is responsible for. */
export function isSourceFile(file) {
  // Dotfiles (`.gitignore`, `.prettierignore`) have no extension to speak of
  // but are plain text — scan them.
  const ext = extensionOf(file);
  return ext === "" || SOURCE_EXTENSIONS.has(ext);
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
export function readIfRegularFile(file) {
  // `lstat`, not `stat`: a tracked entry can be a submodule gitlink (a
  // directory — `readFileSync` throws EISDIR), a committed symlink whose
  // target no longer exists (ENOENT), or a symlink to a character device such
  // as /dev/zero, which `readFileSync` will read UNBOUNDED — presenting as a
  // mystery CI stall rather than a failure. `lstat` describes the link itself,
  // so every one of those is a non-regular entry and is skipped. A symlink to
  // a real tracked file is skipped too, correctly: the target is scanned under
  // its own path.
  let stats;
  try {
    stats = lstatSync(file);
  } catch {
    // Vanished between `git ls-files` and here. Not our problem to report.
    return null;
  }
  return stats.isFile() ? readFileSync(file) : null;
}

export function findNulBytes(files, read = readIfRegularFile) {
  const hits = [];
  for (const file of files) {
    if (!isSourceFile(file)) continue;
    const buffer = read(file);
    // `null` = deliberately not read (non-regular entry).
    if (buffer === null || buffer === undefined) continue;
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

/**
 * A path is untrusted input (anyone who can land a file names it), and it goes
 * into a GitHub workflow-command line. A newline would let a crafted filename
 * emit its own `::` command — `::stop-commands::…` was reproduced on this
 * script's stdout. It cannot flip the gate (the exit code is the gate), but it
 * is annotation forgery in a world-readable log, so newlines and `::` are
 * neutralised before printing.
 */
export function safeAnnotationPath(file) {
  return file.replace(/[\r\n]+/g, " ").replaceAll("::", "__");
}

/**
 * Returns the process exit code: 0 clean, 1 when any tracked source file
 * carries a raw NUL.
 *
 * `files`/`read` are injectable ONLY so the exit contract itself is testable.
 * That contract is the entire thing CI consumes, and it was uncovered: round 2
 * flipped this `return 1` to `return 0` and the guard's own suite stayed green
 * while `node check-nul-bytes.mjs` printed the error and exited 0 — a green
 * `guard` job with a binary source file in the tree.
 */
export function main({ files, read } = {}) {
  const hits = findNulBytes(files ?? trackedFiles(), ...(read === undefined ? [] : [read]));
  if (hits.length === 0) {
    // `warn` not `log` — the root eslint config allows warn/error only.
    console.warn("OK — no raw NUL bytes in tracked source files.");
    return 0;
  }
  for (const { file, offset } of hits) {
    console.error(
      `::error file=${safeAnnotationPath(file)}::Raw NUL byte at offset ${offset}. ` +
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
