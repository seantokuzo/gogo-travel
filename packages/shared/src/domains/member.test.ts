import { describe, expect, it } from "vitest";
import { InviteCreateSchema, INVITE_GRANTABLE_ROLES } from "./member.js";

describe("InviteCreate — CHECK (role <> 'owner') mirror", () => {
  it("rejects role 'owner' — invites can never grant ownership", () => {
    expect(InviteCreateSchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("accepts every grantable role", () => {
    for (const role of INVITE_GRANTABLE_ROLES) {
      expect(InviteCreateSchema.parse({ role }).role).toBe(role);
    }
  });
});
