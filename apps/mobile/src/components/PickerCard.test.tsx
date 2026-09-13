/**
 * `pickerCardMaxHeight` (B-26 R1 — round-1 review B2). Device QA / the
 * reviewer's own measured scenario: on an iPhone 15 (852pt window) with the
 * zone-search keyboard up (~336pt incl. accessory bar), a card sized only
 * off the STATIC 85% window fraction (724pt) has no idea the keyboard ate
 * real room — `PickerCard`'s `modalAvoider` (bottom-anchored,
 * `justifyContent: "flex-end"`) then renders that 724pt card bottom-anchored
 * against a content area that only has ~500pt left, pushing its top (and the
 * header + search input inside it) up past y=0, off screen.
 *
 * jest has no layout engine and no real keyboard (`.claude/rules/mobile.md`,
 * `.claude/rules/testing.md` §4) — what IS pinnable, and the actual bug
 * fix's load-bearing math, is `pickerCardMaxHeight`'s pure computation: it
 * must never return a ceiling taller than the room the keyboard leaves.
 *
 * Falsification (mutation-verify, `.claude/rules/testing.md` §3): reverting
 * the function to ignore `keyboardHeight` and always return the static 85%
 * cap — i.e. exactly the pre-fix defect — turns every "keyboard up" arm
 * below RED while the "no keyboard" arms stay green (recorded in the PR body
 * mutation table, not repeated here as a runtime test — the revert is a
 * one-line source edit, not something to keep committed as dead branchy
 * test code).
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { renderWithTheme } from "@/test-utils/render";

import { PickerCard, pickerCardMaxHeight } from "./PickerCard";

describe("pickerCardMaxHeight (B-26 R1)", () => {
  it("no keyboard: the static 85% window fraction, matching the DS Sheet's own posture", () => {
    expect(pickerCardMaxHeight(852, 0)).toBe(Math.round(852 * 0.85));
    expect(pickerCardMaxHeight(852, 0)).toBe(724);
  });

  it("a small keyboard that still leaves more than 85% of the window untouched: the static cap wins (unchanged from today)", () => {
    // 852 - 100 - 16(gap) = 736, which is MORE room than the 724 cap needs.
    expect(pickerCardMaxHeight(852, 100)).toBe(724);
  });

  it("the reviewer's own iPhone 15 scenario — a 336pt keyboard shrinks the ceiling well below the static 85% cap", () => {
    // 852 - 336 - 16(gap) = 500, well under the 724 static cap: the keyboard
    // wins. This is the exact arm a reverted (keyboard-blind) implementation
    // fails — it would return 724 here, the pre-fix defect.
    expect(pickerCardMaxHeight(852, 336)).toBe(500);
    expect(pickerCardMaxHeight(852, 336)).toBeLessThan(Math.round(852 * 0.85));
  });

  it("the reviewer's iPhone SE scenario — a 260pt keyboard on a 667pt window", () => {
    expect(pickerCardMaxHeight(667, 260)).toBe(667 - 260 - 16);
  });

  it("boundary: a keyboard tall enough to exceed the window never returns a negative ceiling", () => {
    expect(pickerCardMaxHeight(667, 900)).toBe(0);
  });

  it("adversarial: a negative keyboard height (a malformed native event) is treated as no keyboard, not as MORE room", () => {
    expect(pickerCardMaxHeight(852, -50)).toBe(724);
  });

  it("boundary: the keyboard leaves exactly the gap and nothing else — a zero-height ceiling, not a negative one", () => {
    expect(pickerCardMaxHeight(100, 84)).toBe(0);
  });
});

/**
 * The modal avoider's layout/hit-testing shape (B-26 R2 — round-2 review
 * regression + the unpinned half of B2).
 *
 * RNTL's `fireEvent.press` invokes a matched element's handler directly; it
 * does not simulate real touch propagation or z-order hit-testing, so a test
 * that presses `{testID}-sheet-scrim` (DateField.test.tsx / TimeField.test.tsx)
 * cannot see either defect below — both stayed green through the regression.
 * These pins assert the STRUCTURE the fixes depend on instead.
 *
 * 1. `pointerEvents="box-none"` on the `KeyboardAvoidingView`'s host View
 *    (round-2 regression). Without it, giving `modalAvoider` `flex: 1` (next
 *    point) makes that View cover the whole modal; declared after the scrim
 *    in the tree, it paints and hit-tests ABOVE it with the platform default
 *    `pointerEvents` ("auto"), silently swallowing every tap on the dimmed
 *    area outside the card. Confirmed at the pinned RN 0.86.2
 *    `KeyboardAvoidingView.js`: `pointerEvents` is not among the props it
 *    destructures (`behavior`, `children`, `contentContainerStyle`,
 *    `enabled`, `keyboardVerticalOffset`, `style`, `onLayout`) — the rest,
 *    `...props`, is spread onto the host `View` unchanged in every
 *    `behavior` branch (`padding` included), so it forwards straight through.
 *    Falsification: drop `pointerEvents="box-none"` from the
 *    `KeyboardAvoidingView` in `PickerCard.tsx` → RED.
 * 2. `flex: 1` + `justifyContent: "flex-end"` on `modalAvoider` (B-26 R1's
 *    fix — shipped unpinned; reverting just the `flex: 1` left all 59
 *    then-existing tests green). Falsification: drop `flex: 1` from
 *    `modalAvoider` in `PickerCard.tsx` (leaving `justifyContent: "flex-end"`)
 *    → RED.
 *
 * Located via the card's testID rather than by the props under test, so a
 * mutation that removes those props can't also make the node "not found" —
 * it has to fail the `toBe`/`toEqual` assertion on a node the test still finds.
 */
describe("PickerCard modal avoider — layout + hit-testing shape (B-26 R2)", () => {
  function renderCard() {
    return renderWithTheme(
      <PickerCard label="Zone" visible onClose={() => undefined} testID="pc">
        <Text testID="pc-child">rows</Text>
      </PickerCard>,
    );
  }

  it("the KeyboardAvoidingView host lets taps outside the card fall through to the scrim (pointerEvents box-none)", async () => {
    await renderCard();
    const card = screen.getByTestId("pc-sheet");
    const avoider = card.parent;
    expect(avoider).not.toBeNull();
    // Falsification: remove `pointerEvents="box-none"` from the
    // KeyboardAvoidingView → this reads undefined → RED.
    expect(avoider?.props.pointerEvents).toBe("box-none");
  });

  it("the avoider is fixed to the modal's full height, not content-sized (flex: 1 + flex-end)", async () => {
    await renderCard();
    const card = screen.getByTestId("pc-sheet");
    const avoider = card.parent;
    expect(avoider).not.toBeNull();
    const mergedStyle = Object.assign({}, ...[avoider?.props.style].flat());
    // Falsification: drop `flex: 1` from `modalAvoider` → this reads
    // `undefined`, not `1` → RED (the B-26 R1 fix, shipped unpinned).
    expect(mergedStyle.flex).toBe(1);
    expect(mergedStyle.justifyContent).toBe("flex-end");
  });

  it("the scrim is still the dismiss path once the avoider is box-none", async () => {
    const onClose = jest.fn();
    await renderWithTheme(
      <PickerCard label="Zone" visible onClose={onClose} testID="pc">
        <Text testID="pc-child">rows</Text>
      </PickerCard>,
    );
    await fireEvent.press(screen.getByTestId("pc-sheet-scrim", { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
