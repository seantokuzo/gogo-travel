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
import { pickerCardMaxHeight } from "./PickerCard";

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
