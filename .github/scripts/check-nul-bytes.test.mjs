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

import { findNulBytes, isSourceFile, SOURCE_EXTENSIONS } from "./check-nul-bytes.mjs";

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

test("isSourceFile: every text format the repo tracks is in scope", () => {
  for (const ext of ["ts", "tsx", "mjs", "js", "json", "md", "yml", "yaml", "sh", "sql", "svg"]) {
    assert.equal(isSourceFile(`x.${ext}`), true, ext);
  }
  // Extensionless dotfiles are plain text and ARE scanned.
  assert.equal(isSourceFile(".gitignore"), true);
  assert.equal(isSourceFile("path/to/.prettierignore"), true);
  // Known-binary assets are not.
  assert.equal(isSourceFile("a/b/icon.png"), false);
  assert.equal(isSourceFile("a/b/data.parquet"), false);
  // Case-insensitive on the extension.
  assert.equal(isSourceFile("README.MD"), true);
});

test("the allowlist is an allowlist — an unknown binary format is out of scope", () => {
  assert.equal(SOURCE_EXTENSIONS.has("png"), false);
  assert.equal(isSourceFile("x.wasm"), false);
});
