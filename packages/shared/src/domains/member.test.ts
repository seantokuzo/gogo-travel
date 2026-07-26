import { describe, expect, it } from "vitest";
import {
  INVITE_GRANTABLE_ROLES,
  INVITE_STATES,
  InviteCreateSchema,
  InvitePreviewSchema,
  inviteEndpoints,
  MemberRoleUpdateSchema,
  memberEndpoints,
  OwnershipTransferSchema,
} from "./member.js";

describe("InviteCreate — CHECK (role <> 'owner') mirror", () => {
  it("rejects role 'owner' — invites can never grant ownership", () => {
    expect(InviteCreateSchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("accepts every grantable role", () => {
    for (const role of INVITE_GRANTABLE_ROLES) {
      expect(InviteCreateSchema.parse({ role }).role).toBe(role);
    }
  });

  it("caps max_uses at int32 max — no Postgres integer overflow 500 vector", () => {
    expect(
      InviteCreateSchema.safeParse({ role: "editor", max_uses: 2_147_483_647 }).success,
    ).toBe(true);
    expect(
      InviteCreateSchema.safeParse({ role: "editor", max_uses: 2_147_483_648 }).success,
    ).toBe(false);
    expect(InviteCreateSchema.safeParse({ role: "editor", max_uses: 0 }).success).toBe(false);
  });
});

describe("MemberRoleUpdate — R-trips-9 (ownership moves only via transfer)", () => {
  it("rejects role 'owner'", () => {
    expect(MemberRoleUpdateSchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("accepts editor and viewer", () => {
    expect(MemberRoleUpdateSchema.parse({ role: "editor" }).role).toBe("editor");
    expect(MemberRoleUpdateSchema.parse({ role: "viewer" }).role).toBe("viewer");
  });
});

describe("OwnershipTransfer", () => {
  it("requires a UUID target", () => {
    expect(OwnershipTransferSchema.safeParse({ to_user_id: "not-a-uuid" }).success).toBe(false);
    expect(
      OwnershipTransferSchema.safeParse({
        to_user_id: "6f7c2e1a-9d4b-4c3e-8a2f-1b5d7e9f0a3c",
      }).success,
    ).toBe(true);
  });
});

describe("InvitePreview — the join-screen shape leaks no trip id (trips §3.3)", () => {
  const valid = {
    trip: { name: "Lisbon", destination_name: "Lisbon, Portugal" },
    inviter: { display_name: "Sean", avatar_key: null },
    role: "editor",
    state: "active",
    already_member: false,
  };

  it("parses the spec'd shape and STRIPS a smuggled trip_id (no key exists to carry it)", () => {
    const parsed = InvitePreviewSchema.parse({
      ...valid,
      trip: { ...valid.trip, id: "leak", trip_id: "leak" },
    });
    expect(parsed.trip).toEqual({ name: "Lisbon", destination_name: "Lisbon, Portugal" });
    expect(JSON.stringify(parsed)).not.toContain("leak");
  });

  it("covers every invite state", () => {
    for (const state of INVITE_STATES) {
      expect(InvitePreviewSchema.parse({ ...valid, state }).state).toBe(state);
    }
  });
});

describe("endpoint descriptors mirror trips spec §3.3", () => {
  it("member routes", () => {
    expect(memberEndpoints.listMembers.path).toBe("/trips/:tripId/members");
    expect(memberEndpoints.updateMemberRole.method).toBe("PATCH");
    expect(memberEndpoints.updateMemberRole.path).toBe("/trips/:tripId/members/:userId");
    expect(memberEndpoints.removeMember.method).toBe("DELETE");
    expect(memberEndpoints.transferOwnership.path).toBe("/trips/:tripId/transfer-ownership");
  });

  it("invite routes", () => {
    expect(inviteEndpoints.createInvite.path).toBe("/trips/:tripId/invites");
    expect(inviteEndpoints.listInvites.method).toBe("GET");
    expect(inviteEndpoints.revokeInvite.path).toBe("/trips/:tripId/invites/:inviteId");
    expect(inviteEndpoints.previewInvite.path).toBe("/invites/:token");
    expect(inviteEndpoints.acceptInvite.path).toBe("/invites/:token/accept");
  });
});
