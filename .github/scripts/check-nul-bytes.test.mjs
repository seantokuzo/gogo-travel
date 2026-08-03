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

import {
  findNulBytes,
  isSourceFile,
  main,
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

test("isSourceFile: EVERY tracked file that is not a known binary asset is in scope", () => {
  // Derived from the repo, not from a hardcoded list. The previous version of
  // this test asserted the same claim against a list it wrote itself, and so
  // missed that `.env.example` — the one tracked file whose entire purpose is
  // being read by a human — was being skipped. An allowlist only stays honest
  // if something checks it against reality.
  const skipped = trackedFiles().filter((f) => !isSourceFile(f));
  const unexpected = skipped.filter((f) => !/\.(png|parquet)$/i.test(f));
  assert.deepEqual(unexpected, [], `unscanned tracked text files: ${unexpected.join(", ")}`);
  // …and the binary assets really are being skipped, so the filter above is
  // not vacuously empty.
  assert.ok(skipped.length > 0, "expected the repo to track some binary assets");
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
