/**
 * Two invariants that keep the token system honest:
 *
 * 1. PURE-DATA (R-ds-5): theme data modules (src/themes/*, src/ramps.ts)
 *    export plain serializable data — no functions anywhere, however deep.
 *    Adding a palette must stay a data-only operation.
 *
 * 2. PLATFORM-AGNOSTIC (R-shared-9 discipline): no react-native / expo /
 *    node builtins / I-O clients anywhere in shipped sources; `react` is
 *    allowed ONLY under src/react/ (the peer-dep subpath). The root entry
 *    must stay importable from anything.
 *
 * (The test file itself runs under node and may use node builtins — tests
 * are not shipped.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as ramps from "./ramps.js";
import { themes } from "./themes.js";

// ------------------------------------------------------- 1. pure data

function assertPlainData(value: unknown, path: string): void {
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || value === null) {
    return;
  }
  expect(t, `${path} must not be a ${t}`).not.toBe("function");
  expect(t, `${path} has non-data type ${t}`).toBe("object");
  const proto: unknown = Object.getPrototypeOf(value);
  expect(
    proto === Object.prototype || proto === Array.prototype || proto === null,
    `${path} must be a plain object/array`,
  ).toBe(true);
  // Walk OWN property descriptors, not Object.entries: entries invokes
  // accessors and only sees the returned value, so a sneaky getter
  // (`get solid() { ... }`) would pass as "plain data". Symbol keys are
  // rejected outright — data has string keys.
  expect(
    Object.getOwnPropertySymbols(value).length,
    `${path} must not have symbol-keyed properties`,
  ).toBe(0);
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    expect(
      desc.get === undefined && desc.set === undefined,
      `${path}.${key} must be a value property, not a getter/setter`,
    ).toBe(true);
    assertPlainData(desc.value, `${path}.${key}`);
  }
}

describe("pure-data invariant (R-ds-5)", () => {
  // Iterate the REGISTRY (plus ramps): registering a palette auto-enrolls it
  // here — no hand-maintained module list to forget.
  const dataModules: Array<[string, Record<string, unknown>]> = [
    ...Object.entries(themes).map(([name, palette]): [string, Record<string, unknown>] => [
      `themes/${name}`,
      { [name]: palette },
    ]),
    ["ramps", { ...ramps }],
  ];

  it("covers every registered palette", () => {
    expect(dataModules.length).toBe(Object.keys(themes).length + 1);
  });

  for (const [name, mod] of dataModules) {
    it(`${name} exports only plain data (no functions)`, () => {
      const entries = Object.entries(mod);
      expect(entries.length).toBeGreaterThan(0);
      for (const [exportName, value] of entries) {
        assertPlainData(value, `${name}.${exportName}`);
      }
    });
  }

  it("assertPlainData rejects functions (self-test)", () => {
    expect(() => assertPlainData({ sneaky: () => "#FFF" }, "self-test")).toThrow();
  });

  it("assertPlainData rejects getters and symbol keys (self-test)", () => {
    expect(() =>
      assertPlainData(
        {
          get sneaky() {
            return "#FFF";
          },
        },
        "self-test",
      ),
    ).toThrow();
    expect(() => assertPlainData({ [Symbol("sneaky")]: "#FFF" }, "self-test")).toThrow();
  });
});

// ------------------------------------------------------- 2. platform scan

const SRC_ROOT = join(import.meta.dirname, ".");

const FORBIDDEN_EVERYWHERE: Array<[string, RegExp]> = [
  ["react-native", /^react-native(-|\/|$)/],
  ["expo-*", /^expo(-|\/|$)/],
  ["node: builtins", /^node:/],
  [
    "bare node builtins",
    /^(fs|path|os|crypto|http|https|net|child_process|stream|util|url|buffer|worker_threads)(\/|$)/,
  ],
  ["fetch/axios clients", /^(axios|node-fetch|undici|got)(\/|$)/],
  [
    "storage/db clients",
    /^(@react-native-async-storage|react-native-mmkv|expo-sqlite|drizzle-orm|postgres|pg)(\/|$)/,
  ],
];

const REACT_PATTERN = /^react(-dom)?(\/|$)/;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

/** Static/side-effect/dynamic import + require — one capture group per hit. */
const IMPORT_REGEX =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

const specifierOf = (match: RegExpMatchArray): string | undefined =>
  match[1] ?? match[2] ?? match[3] ?? match[4];

describe("platform-agnostic package", () => {
  const sources = walk(SRC_ROOT);

  it("finds the package sources", () => {
    expect(sources.length).toBeGreaterThan(8);
  });

  it("no shipped module imports react-native/expo/node builtins/I-O clients", () => {
    const violations: string[] = [];
    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(IMPORT_REGEX)) {
        const specifier = specifierOf(match);
        if (!specifier || specifier.startsWith(".")) continue;
        for (const [label, pattern] of FORBIDDEN_EVERYWHERE) {
          if (pattern.test(specifier)) {
            violations.push(`${file}: '${specifier}' (${label})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("react appears ONLY under src/react/ (root entry stays React-free)", () => {
    const violations: string[] = [];
    for (const file of sources) {
      const inReactSubpath = file.includes(`${join(SRC_ROOT, "react")}/`);
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(IMPORT_REGEX)) {
        const specifier = specifierOf(match);
        if (!specifier || specifier.startsWith(".")) continue;
        if (REACT_PATTERN.test(specifier) && !inReactSubpath) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the only external import anywhere is react (in the subpath)", () => {
    const external = new Set<string>();
    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(IMPORT_REGEX)) {
        const specifier = specifierOf(match);
        if (specifier && !specifier.startsWith(".")) external.add(specifier);
      }
    }
    expect([...external]).toEqual(["react"]);
  });
});
