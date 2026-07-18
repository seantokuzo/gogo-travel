/**
 * ESLint testID-guard self-test (T-4.4 R1) — the R-nav-22 `no-restricted-syntax`
 * rule in eslint.config.js is the ONLY automated enforcement for raw RN
 * primitives; a selector/glob typo would silently disable it. This suite runs
 * the REAL config through ESLint's Node API against in-scope virtual
 * filenames (nothing written to disk) so the guard's liveness is itself
 * gated. Known limits (aliased imports evade; testID-carrying spreads still
 * error, fail-closed) are documented in the config comment.
 */
import { join } from "node:path";

import { ESLint } from "eslint";

// Loading the expo flat-config graph takes a few seconds on cold start.
jest.setTimeout(30_000);

const APP_ROOT = join(__dirname, "..", "..");

// ESLint 9 loads config FILES via dynamic import(), which jest's CJS VM
// forbids — so require the real (CJS) config ourselves and hand the very
// object `expo lint` ships to ESLint directly. `overrideConfigFile: true`
// skips the file loader; cwd keeps the config's `files` globs anchored to
// the app root so scope matching behaves exactly as in a real lint run.
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const realConfig = require(join(APP_ROOT, "eslint.config.js")) as object[];

// One instance — the config graph loads lazily on first lint and is reused.
const eslint = new ESLint({
  cwd: APP_ROOT,
  overrideConfigFile: true,
  baseConfig: realConfig as never,
});

const BARE_PRESSABLE = `import { Pressable, Text } from "react-native";

export default function Probe() {
  return (
    <Pressable onPress={() => undefined}>
      <Text>x</Text>
    </Pressable>
  );
}
`;

const PRESSABLE_WITH_TESTID = `import { Pressable, Text } from "react-native";

export default function Probe() {
  return (
    <Pressable onPress={() => undefined} testID="probe-button-go">
      <Text>x</Text>
    </Pressable>
  );
}
`;

async function restrictedFindings(code: string, virtualPath: string, marker: string) {
  const [result] = await eslint.lintText(code, {
    filePath: join(APP_ROOT, virtualPath),
  });
  return result.messages.filter(
    (m) => m.ruleId === "no-restricted-syntax" && m.message.includes(marker),
  );
}

const guardFindings = (code: string, virtualPath: string) =>
  restrictedFindings(code, virtualPath, "R-nav-22");

describe("R-nav-22 ESLint guard (eslint.config.js) is alive", () => {
  it("errors on a bare Pressable without testID in src/app/**", async () => {
    const findings = await guardFindings(BARE_PRESSABLE, "src/app/__guard-probe__.tsx");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(2); // error, not warning
    expect(findings[0].message).toContain("testID");
  });

  it("passes the same Pressable once it carries a testID", async () => {
    const findings = await guardFindings(PRESSABLE_WITH_TESTID, "src/app/__guard-probe__.tsx");
    expect(findings).toEqual([]);
  });
});

const HEX_LITERAL = `export const oops = { color: "#FF0000" };\n`;

const RGB_LITERAL = `export const oops = { color: "rgba(255, 0, 0, 0.5)" };\n`;

const BARE_STYLESHEET = `import { StyleSheet } from "react-native";

export const s = StyleSheet.create({ screen: { flex: 1 } });
`;

const WRAPPED_STYLESHEET = `import { StyleSheet } from "react-native";
import { createStyles } from "@gogo/tokens/react";

export const useStyles = createStyles((t) =>
  StyleSheet.create({ screen: { flex: 1, backgroundColor: t.color.bg.screen } }),
);
`;

describe("R-ds-7 token-only lint (DS-4) is alive", () => {
  it("errors on a literal hex color in src/components/**", async () => {
    const findings = await restrictedFindings(HEX_LITERAL, "src/components/__probe__.ts", "R-ds-7");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(2);
  });

  it("errors on a literal rgba() color in src/components/**", async () => {
    const findings = await restrictedFindings(RGB_LITERAL, "src/components/__probe__.ts", "R-ds-7");
    expect(findings).toHaveLength(1);
  });

  it("errors on bare StyleSheet.create outside createStyles", async () => {
    const findings = await restrictedFindings(
      BARE_STYLESHEET,
      "src/components/__probe__.ts",
      "R-ds-7",
    );
    expect(findings).toHaveLength(1);
  });

  it("passes StyleSheet.create wrapped in the createStyles factory", async () => {
    const findings = await restrictedFindings(
      WRAPPED_STYLESHEET,
      "src/components/__probe__.ts",
      "R-ds-7",
    );
    expect(findings).toEqual([]);
  });

  // Flat-config landmine: a second block's no-restricted-syntax REPLACES the
  // first for files both match. These two prove src/app/** carries BOTH rule
  // sets — i.e. adding the R-ds-7 block did not clobber the testID guard and
  // vice versa.
  it("errors on a hex literal in src/app/** (merged into the guard block)", async () => {
    const findings = await restrictedFindings(HEX_LITERAL, "src/app/__probe__.tsx", "R-ds-7");
    expect(findings).toHaveLength(1);
  });

  it("keeps the testID guard alive alongside R-ds-7 in src/app/**", async () => {
    const findings = await guardFindings(BARE_PRESSABLE, "src/app/__guard-probe__.tsx");
    expect(findings).toHaveLength(1);
  });

  it("exempts test files from token-only styling", async () => {
    const findings = await restrictedFindings(
      HEX_LITERAL,
      "src/__tests__/__probe__.test.ts",
      "R-ds-7",
    );
    expect(findings).toEqual([]);
  });
});
