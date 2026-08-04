/**
 * Unit tests for the no-raw-NUL guard.
 *
 * The offending fixture is BUILT AT RUNTIME (`Buffer.from([...])`) and handed
 * to `findNulBytes` through its injected reader — deliberately never written
 * to a committed file. A checked-in NUL-bearing fixture would be classified
 * binary by git and would trip the very guard it is meant to exercise, which
 * is how a "test fixture" becomes the next undiffable file.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extensionOf,
  findNulBytes,
  isSourceFile,
  KNOWN_BINARY_EXTENSIONS,
  main,
  readIfRegularFile,
  safeAnnotationPath,
  SOURCE_EXTENSIONS,
  trackedFiles,
} from "./check-nul-bytes.mjs";

const NUL = 0x00;

/** A reader over an in-memory `{ path: Buffer }` map. */
const readerFor = (files) => (file) => files[file];

test("flags a source file containing a raw NUL, and reports its offset", () => {
  const withNul = Buffer.concat([
    Buffer.from("export const k = `a"),
    Buffer.from([NUL]),
    Buffer.from("b`;\n"),
  ]);
  const hits = findNulBytes(["src/legs.ts"], readerFor({ "src/legs.ts": withNul }));
  assert.deepEqual(hits, [{ file: "src/legs.ts", offset: 19 }]);
});

test("CONTROL: the same file written with the ESCAPE is clean", () => {
  // The literal six characters backslash-u-0-0-0-0 — what the fix looks like.
  const escaped = Buffer.from("export const k = `a\\u0000b`;\n");
  assert.equal(escaped.indexOf(NUL), -1, "fixture must not contain a raw NUL");
  assert.deepEqual(findNulBytes(["src/legs.ts"], readerFor({ "src/legs.ts": escaped })), []);
});

test("reports every offending file, not just the first", () => {
  const bad = Buffer.from([0x61, NUL]);
  const files = { "a.ts": bad, "b.tsx": bad, "c.ts": Buffer.from("ok") };
  const hits = findNulBytes(Object.keys(files), readerFor(files));
  assert.deepEqual(
    hits.map((h) => h.file),
    ["a.ts", "b.tsx"],
  );
});

test("skips legitimately-binary tracked assets", () => {
  const png = Buffer.from([0x89, 0x50, NUL, 0x0d]);
  const files = { "assets/icon.png": png, "data/x.parquet": png };
  assert.deepEqual(findNulBytes(Object.keys(files), readerFor(files)), []);
});

test("every tracked file is EITHER scanned or a declared binary asset", () => {
  // Derived from the repo, and checked against the SCRIPT's own declaration —
  // never against a list this test writes itself. Two earlier shapes of this
  // assertion were wrong in opposite directions: a hardcoded format list
  // missed that `.env.example` was silently skipped, and a hardcoded
  // known-binary regex would have turned the guard job RED on the first
  // tracked font (`AssertionError: unscanned tracked text files:
  // SpaceMono.ttf` — a font called a text file), whose obvious fix is to
  // loosen THIS file and reopen the blind spot.
  //
  // So the only question asked here is: does anything fall through both sets?
  // If so, the guard fails and someone decides which set it belongs in — both
  // are one-line edits in check-nul-bytes.mjs.
  const skipped = trackedFiles().filter((f) => !isSourceFile(f));
  const undeclared = skipped.filter((f) => !KNOWN_BINARY_EXTENSIONS.has(extensionOf(f)));
  assert.deepEqual(
    undeclared,
    [],
    `tracked files matching neither SOURCE_EXTENSIONS nor KNOWN_BINARY_EXTENSIONS: ` +
      `${undeclared.join(", ")} — add each to whichever set it belongs in`,
  );
  // …and the binary assets really are being skipped, so the filter above is
  // not vacuously empty.
  assert.ok(skipped.length > 0, "expected the repo to track some binary assets");
});

test("a NEW binary asset type does not red the job; an UNDECLARED one does", () => {
  // The near-term trigger: expo-font is a dependency and an app.json plugin
  // with no font files tracked yet.
  assert.equal(isSourceFile("apps/mobile/assets/fonts/SpaceMono.ttf"), false);
  assert.ok(KNOWN_BINARY_EXTENSIONS.has("ttf"), "fonts are declared, so a .ttf drop is quiet");

  // …while a format in neither set is the deliberate decision point.
  assert.equal(isSourceFile("apps/mobile/assets/model.usdz"), false);
  assert.equal(KNOWN_BINARY_EXTENSIONS.has("usdz"), false);
});

test("the two sets are disjoint — no format is both scanned and declared binary", () => {
  const both = [...SOURCE_EXTENSIONS].filter((ext) => KNOWN_BINARY_EXTENSIONS.has(ext));
  assert.deepEqual(both, []);
});

test("extensionOf: dotfiles and extensionless names have no extension", () => {
  assert.equal(extensionOf("a/b/icon.PNG"), "png");
  assert.equal(extensionOf(".gitignore"), "");
  assert.equal(extensionOf("path/to/.prettierignore"), "");
  assert.equal(extensionOf("Makefile"), "");
  assert.equal(extensionOf("a.b/c"), "");
});

test("isSourceFile: the formats round 2 found missing are now in scope", () => {
  for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "json", "md", "yml", "toml"]) {
    assert.equal(isSourceFile(`x.${ext}`), true, ext);
  }
  assert.equal(isSourceFile(".env.example"), true);
  // Extensionless dotfiles are plain text and ARE scanned.
  assert.equal(isSourceFile(".gitignore"), true);
  assert.equal(isSourceFile("path/to/.prettierignore"), true);
  // Known-binary assets are not.
  assert.equal(isSourceFile("a/b/icon.png"), false);
  assert.equal(isSourceFile("a/b/data.parquet"), false);
  // Case-insensitive on the extension.
  assert.equal(isSourceFile("README.MD"), true);
});

test("main(): EXIT CONTRACT — 1 when a source file carries a NUL", () => {
  // The only thing CI consumes. Flipping this `return 1` to `return 0` left
  // the rest of this suite green while the guard exited 0 on a binary tree.
  const files = { "src/bad.ts": Buffer.from([0x61, NUL]) };
  assert.equal(main({ files: Object.keys(files), read: readerFor(files) }), 1);
});

test("main(): EXIT CONTRACT — 0 on a clean tree", () => {
  const files = { "src/ok.ts": Buffer.from("export const k = 1;\n") };
  assert.equal(main({ files: Object.keys(files), read: readerFor(files) }), 0);
});

test("main(): a binary asset carrying a NUL does not fail the build", () => {
  const files = { "assets/icon.png": Buffer.from([0x89, NUL]) };
  assert.equal(main({ files: Object.keys(files), read: readerFor(files) }), 0);
});

test("trackedFiles(): enumerates the real repo, NUL-delimited", () => {
  const files = trackedFiles();
  assert.ok(files.length > 100, `expected a populated repo, got ${files.length}`);
  // `-z` output must not leave empty entries or embedded newlines behind.
  assert.equal(
    files.filter((f) => f === "" || f.includes("\n")).length,
    0,
  );
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes(".github/scripts/check-nul-bytes.mjs"));
});

test("main() over the REAL tree is clean — the guard guards itself", () => {
  assert.equal(main(), 0);
});

test("the allowlist is an allowlist — an unknown binary format is out of scope", () => {
  assert.equal(SOURCE_EXTENSIONS.has("png"), false);
  assert.equal(isSourceFile("x.wasm"), false);
});

test("readIfRegularFile: non-regular entries are skipped, not crashed on", () => {
  // Reproduces the three shapes a tracked path can take that are not a plain
  // file. Before the lstat check these were EISDIR, ENOENT, and — worst — an
  // unbounded read that presents as a mystery CI stall.
  const dir = mkdtempSync(join(tmpdir(), "nul-guard-"));
  try {
    const real = join(dir, "real.ts");
    writeFileSync(real, "export const k = 1;\n");
    assert.ok(readIfRegularFile(real) !== null, "a real file is still read");

    // A directory, as a submodule gitlink presents.
    assert.equal(readIfRegularFile(dir), null);

    // A committed symlink whose target does not exist.
    const broken = join(dir, "broken.ts");
    symlinkSync(join(dir, "nope.ts"), broken);
    assert.equal(readIfRegularFile(broken), null);

    // A symlink to a character device — the unbounded-read case.
    const zero = join(dir, "zero.ts");
    symlinkSync("/dev/zero", zero);
    assert.equal(readIfRegularFile(zero), null);

    // A path that simply is not there.
    assert.equal(readIfRegularFile(join(dir, "absent.ts")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findNulBytes/main survive a tree containing non-regular entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "nul-guard-"));
  try {
    const zero = join(dir, "zero.ts");
    symlinkSync("/dev/zero", zero);
    const clean = join(dir, "clean.ts");
    writeFileSync(clean, "export const k = 1;\n");
    // Completes, reports nothing, exits 0 — rather than hanging.
    assert.deepEqual(findNulBytes([dir, zero, clean]), []);
    assert.equal(main({ files: [dir, zero, clean] }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeAnnotationPath: a crafted filename cannot emit its own workflow command", () => {
  // A path is untrusted input and lands in a `::error file=…::` line. A
  // newline in it would start a NEW workflow command on the runner's stdout.
  const attack = "src/a\n::stop-commands::deadbeef\nb.ts";
  const safe = safeAnnotationPath(attack);
  assert.ok(!safe.includes("\n"), "no newline survives");
  assert.ok(!safe.includes("\r"), "no carriage return survives");
  assert.ok(!safe.includes("::"), "no command delimiter survives");
  assert.equal(safe, "src/a __stop-commands__deadbeef b.ts");

  // Ordinary paths are untouched.
  assert.equal(safeAnnotationPath("apps/mobile/src/x.ts"), "apps/mobile/src/x.ts");
});
