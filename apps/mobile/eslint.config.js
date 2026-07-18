// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const prettierConfig = require("eslint-config-prettier");

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
      ],
    },
  },
  prettierConfig,
]);
