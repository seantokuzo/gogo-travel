// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const prettierConfig = require("eslint-config-prettier");

// DS-4 / R-ds-7: token-only styling. Every color comes from theme tokens and
// every style sheet goes through the createStyles(theme) factory, so literal
// color strings and un-wrapped StyleSheet.create are lint errors. Spacing
// literals are NOT machine-banned (numeric literals like `flex: 1` make a
// syntactic ban all noise) — spacing discipline stays on review.
// Self-tested in src/__tests__/eslint-testid-guard.test.ts.
const tokenOnlySelectors = [
  {
    selector: "Literal[value=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
    message:
      "Literal hex color — source colors from theme tokens via createStyles (tokens.spec R-ds-7).",
  },
  {
    selector: "Literal[value=/^(rgb|hsl)a?\\(/]",
    message:
      "Literal rgb()/hsl() color — source colors from theme tokens via createStyles (tokens.spec R-ds-7).",
  },
  {
    selector:
      'CallExpression[callee.object.name="StyleSheet"][callee.property.name="create"]:not(CallExpression[callee.name="createStyles"] *)',
    message:
      "Bare StyleSheet.create — wrap it in the createStyles(theme) factory so styles are theme-derived and cached (tokens.spec R-ds-7, DS-4).",
  },
];

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", ".expo/*"],
  },
  {
    // NAV-7 / R-nav-22: raw RN interactive elements in screens must carry a
    // testID (grammar: navigation.spec §2.7). Design-system components
    // already enforce it via required props, so the guard targets the raw
    // primitives only — spread-only usages of DS components stay legal.
    //
    // Known limits (self-tested in src/__tests__/eslint-testid-guard.test.ts):
    // - `import { Pressable as P }` aliasing evades the name match (guard is
    //   name-based; the DS-component convention makes aliased raw primitives
    //   rare enough to accept).
    // - An attribute spread carrying testID (`<Pressable {...props} />`)
    //   still errors — the guard fails CLOSED (false positive over silent
    //   hole); write a literal testID or use the DS component.
    //
    // NOTE: flat-config rule settings REPLACE, not merge, per rule per file —
    // any block matching src/app/** or src/navigation/** must carry the FULL
    // no-restricted-syntax selector list (tokenOnlySelectors included here),
    // or it silently drops the testID guard. Self-test covers both rules on
    // an src/app filename to catch exactly that regression.
    files: ["src/app/**/*.tsx", "src/navigation/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'JSXOpeningElement[name.name=/^(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|TouchableNativeFeedback|TextInput|Switch)$/]:not(:has(JSXAttribute[name.name="testID"]))',
          message:
            "Interactive elements must carry a testID (navigation.spec §2.7, R-nav-22) — or use the design-system component, which requires one.",
        },
        ...tokenOnlySelectors,
      ],
    },
  },
  {
    // DS-4 / R-ds-7 for everything outside the block above (components,
    // theme adapters): token-only styling. Test/typetest/test-util files are
    // exempt — they declare no shipped visual styles.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/app/**",
      "src/navigation/**",
      "src/**/*.test.*",
      "src/**/*.typetest.*",
      "src/__tests__/**",
      "src/test-utils/**",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...tokenOnlySelectors],
    },
  },
  prettierConfig,
]);
