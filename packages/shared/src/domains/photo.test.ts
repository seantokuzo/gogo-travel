import { describe, expect, it } from "vitest";
import { canViewPhoto } from "./photo.js";
import type { PhotoVisibility } from "../enums.js";

describe("canViewPhoto — Law #3 truth table (owner/member/stranger × private/trip/public)", () => {
  const owner = { isOwner: true, isTripMember: true };
  const member = { isOwner: false, isTripMember: true };
  const stranger = { isOwner: false, isTripMember: false };

  const table: Array<
    [string, { isOwner: boolean; isTripMember: boolean }, PhotoVisibility, boolean]
  > = [
    ["owner sees private", owner, "private", true],
    ["owner sees trip", owner, "trip", true],
    ["owner sees public", owner, "public", true],
    ["member blocked from private", member, "private", false],
    ["member sees trip", member, "trip", true],
    ["member sees public", member, "public", true],
    ["stranger blocked from private", stranger, "private", false],
    ["stranger blocked from trip", stranger, "trip", false],
    ["stranger sees public", stranger, "public", true],
  ];

  it.each(table)("%s", (_label, viewer, visibility, expected) => {
    expect(canViewPhoto(viewer, visibility)).toBe(expected);
  });

  it("an owner who somehow lost trip membership still sees their own photo", () => {
    expect(canViewPhoto({ isOwner: true, isTripMember: false }, "private")).toBe(true);
    expect(canViewPhoto({ isOwner: true, isTripMember: false }, "trip")).toBe(true);
  });
});
