/**
 * R-shared-9 guard: @gogo/shared imports nothing platform-bound.
 * The test itself runs under node (tests aren't shipped); it scans the
 * package SOURCE for forbidden import specifiers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(import.meta.dirname, ".");

const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ["react", /^react(\/|$)/],
  ["react-native", /^react-native(\/|$)/],
  ["expo-*", /^expo(-|\/|$)/],
  ["node: builtins", /^node:/],
  [
    "bare node builtins",
    /^(fs|path|os|crypto|http|https|net|child_process|stream|util|url|buffer|worker_threads)(\/|$)/,
  ],
  ["fetch/axios clients", /^(axios|node-fetch|undici|got)(\/|$)/],
  [
    "storage/db clients",
    /^(@react-native-async-storage|expo-sqlite|drizzle-orm|postgres|pg)(\/|$)/,
  ],
];

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

const IMPORT_REGEX =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

describe("platform-agnostic package (R-shared-9)", () => {
  const sources = walk(SRC_ROOT);

  it("finds the package sources", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("no shipped module imports react/react-native/expo/node builtins/I-O clients", () => {
    const violations: string[] = [];
    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(IMPORT_REGEX)) {
        const specifier = match[1] ?? match[2];
        if (!specifier || specifier.startsWith(".")) continue;
        for (const [label, pattern] of FORBIDDEN_PATTERNS) {
          if (pattern.test(specifier)) {
            violations.push(`${file}: '${specifier}' (${label})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the only external runtime dependency is zod", () => {
    const external = new Set<string>();
    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(IMPORT_REGEX)) {
        const specifier = match[1] ?? match[2];
        if (specifier && !specifier.startsWith(".")) external.add(specifier);
      }
    }
    expect([...external]).toEqual(["zod"]);
  });
});
