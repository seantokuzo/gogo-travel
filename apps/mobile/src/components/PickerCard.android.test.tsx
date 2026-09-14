/**
 * `alwaysModal` on Android (round-1 review A1). `PickerCard.tsx:135`'s
 * `Platform.OS !== "ios" && !alwaysModal` branch never ran under jest before
 * this pin: `jest-expo`'s base preset resolves `Platform.OS` to `"ios"` for
 * EVERY test in the suite (verified: `haste: {"defaultPlatform":"ios",...}`
 * read out of `node_modules`), and grepping the repo found no precedent
 * anywhere for flipping it. Without `alwaysModal`, `TimeZoneField`'s own
 * `FlatList` would render bare (inline in the item/new screen's
 * `ScrollView`) on Android — precisely the "VirtualizedLists should never be
 * nested" defect B-26 exists to fix, just on the other platform, invisible
 * to CI either way.
 *
 * SEPARATE FILE, deliberately: `PickerCard.test.tsx` statically imports
 * `{ pickerCardMaxHeight }` from `"./PickerCard"`, which evaluates
 * `PickerCard.tsx` (with the REAL, unmocked `Platform`) once at file-load
 * time. Node/Jest's require cache is keyed by resolved file path, so ANY
 * later `require("./PickerCard")` in that same file — even after
 * `jest.doMock`-ing the `Platform` submodule — returns that SAME
 * already-cached, real-platform module; the mock never gets a chance to
 * apply. This file never statically imports `"./PickerCard"`, so the
 * `require` inside the test below is the module's first-ever evaluation.
 *
 * Mocking needs the exact deep specifier RN's own bare `Platform.js`
 * re-exports through (`Libraries/Utilities/Platform`) — confirmed live: the
 * top-level `Platform` from `"react-native"` routes through this same
 * resolved module. `jest.mock("react-native", ...)` was rejected as the
 * alternative — it would have to reimplement the whole package and risks
 * silently degrading everything else RNTL depends on.
 *
 * Both arms live in ONE test (not `beforeEach` + two `it`s): a SECOND fresh
 * `require` between tests would need `jest.resetModules()`, which also
 * evicts "react" itself, producing a second React instance distinct from
 * the one this file's own `render`/`screen` import is bound to ("Invalid
 * hook call" — confirmed by hitting exactly that error while developing this
 * pin). `Platform.OS` is read LIVE on every render (not baked in at
 * module-eval time), so ONE fresh require correctly serves both `alwaysModal`
 * values via two renders in the same test.
 */
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";

it("A1: with alwaysModal the card chrome renders on Android too; without it, Android renders BARE children", async () => {
  const mockPlatform = {
    OS: "android",
    select: (obj: Record<string, unknown>) => obj["android"] ?? obj["default"],
  };
  jest.doMock("react-native/Libraries/Utilities/Platform", () => ({
    __esModule: true,
    default: mockPlatform,
    ...mockPlatform,
  }));
  // Must post-date `jest.doMock` above — a static import is hoisted before it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PickerCard } = require("./PickerCard") as typeof import("./PickerCard");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ThemeProvider } = require("@gogo/tokens/react") as typeof import("@gogo/tokens/react");

  const { unmount } = await render(
    <ThemeProvider defaultAppearancePref="light">
      <PickerCard label="Zone" visible alwaysModal onClose={() => undefined} testID="probe">
        <Text testID="probe-child">rows</Text>
      </PickerCard>
    </ThemeProvider>,
  );
  expect(screen.getByTestId("probe-sheet")).toBeOnTheScreen();
  expect(screen.getByTestId("probe-sheet-close")).toBeOnTheScreen();
  expect(screen.getByTestId("probe-child")).toBeOnTheScreen();
  await unmount();

  // MUTATION arm — the falsification this pin exists for: drop
  // `alwaysModal` from a caller (as this repo's own PR #67 round-1 review
  // probe did to `TimeZoneField.tsx`) and Android gets this branch instead —
  // no card, no bounds, no scroll container.
  await render(
    <ThemeProvider defaultAppearancePref="light">
      <PickerCard label="Zone" visible onClose={() => undefined} testID="probe">
        <Text testID="probe-child">rows</Text>
      </PickerCard>
    </ThemeProvider>,
  );
  expect(screen.queryByTestId("probe-sheet")).toBeNull();
  expect(screen.queryByTestId("probe-sheet-close")).toBeNull();
  expect(screen.getByTestId("probe-child")).toBeOnTheScreen();
});
