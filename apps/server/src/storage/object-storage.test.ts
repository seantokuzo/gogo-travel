/**
 * Avatar key mint/parse + the unconfigured stand-in (T-5.5, R-user-3). The
 * parse side is the commit-time gate: anything that is not exactly
 * `avatars/{uuid}/{uuid}` must be unparseable, or a crafted key could reach
 * the storage lookup (or worse, commit into another user's namespace).
 */
import { describe, expect, it } from "vitest";
import {
  mintAvatarKey,
  ObjectStorageUnconfiguredError,
  parseAvatarKey,
  UNCONFIGURED_OBJECT_STORAGE,
} from "./object-storage.js";

const USER_ID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

describe("mintAvatarKey / parseAvatarKey (R-user-3 namespace)", () => {
  it("mints avatars/{userId}/{uuid} and parses it back", () => {
    const key = mintAvatarKey(USER_ID);
    expect(key.startsWith(`avatars/${USER_ID}/`)).toBe(true);
    const parsed = parseAvatarKey(key);
    expect(parsed?.userId).toBe(USER_ID);
    expect(parsed?.objectId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints a fresh object id per call (keys are unguessable, never reused)", () => {
    expect(mintAvatarKey(USER_ID)).not.toBe(mintAvatarKey(USER_ID));
  });

  it("rejects everything that is not exactly avatars/{uuid}/{uuid}", () => {
    const objectId = "0f0e0d0c-0b0a-4a4b-8c8d-9e9f00010203";
    const crafted = [
      "", // empty
      `avatars/${USER_ID}`, // missing object segment
      `avatars/${USER_ID}/${objectId}/extra`, // extra segment
      `avatars/${USER_ID}/not-a-uuid`, // non-uuid object
      `avatars/not-a-uuid/${objectId}`, // non-uuid user
      `avatars/../${USER_ID}/${objectId}`, // traversal
      `avatars/${USER_ID}/../${objectId}`, // traversal in object slot
      `photos/${USER_ID}/${objectId}`, // foreign namespace prefix
      ` avatars/${USER_ID}/${objectId}`, // leading whitespace
      `avatars/${USER_ID}/${objectId} `, // trailing whitespace
      `avatars//${objectId}`, // empty user slot
      `AVATARS/${USER_ID}/${objectId}`, // wrong-case prefix
    ];
    for (const key of crafted) {
      expect(parseAvatarKey(key)).toBeNull();
    }
  });
});

describe("UNCONFIGURED_OBJECT_STORAGE (provider escalation parked)", () => {
  it("presign rejects loudly with a named error", async () => {
    await expect(
      UNCONFIGURED_OBJECT_STORAGE.createPresignedUpload("k", "image/png", 1, 60),
    ).rejects.toBeInstanceOf(ObjectStorageUnconfiguredError);
  });

  it("existence fails CLOSED — no commit can succeed", async () => {
    await expect(UNCONFIGURED_OBJECT_STORAGE.objectExists(mintAvatarKey(USER_ID))).resolves.toBe(
      false,
    );
  });
});
