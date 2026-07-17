/**
 * Jest manual mock — auto-applied by jest for node_modules packages when a
 * `__mocks__/<package>.ts` sits adjacent to node_modules (jest rootDir).
 *
 * Why: react-native-nitro-modules resolves its native TurboModule AT IMPORT
 * TIME and throws under jest (no native runtime). react-native-mmkv's test
 * path never actually calls Nitro — `createMMKV()` detects JEST_WORKER_ID and
 * returns its own in-memory mock — so an inert stub here lets all of mmkv's
 * REAL JS load and its sanctioned mock kick in.
 *
 * Any genuine Nitro call under jest is a bug: fail loudly, never silently.
 */
export const NitroModules = new Proxy(
  {},
  {
    get(_target, property): never {
      throw new Error(
        `NitroModules.${String(property)} was called under jest — native Nitro ` +
          "modules do not exist in the test environment. Mock the calling module instead.",
      );
    },
  },
);
