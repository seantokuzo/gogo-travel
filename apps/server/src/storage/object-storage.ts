/**
 * `ObjectStorage` — the provider-agnostic presigned-upload port (auth-users
 * spec §3.7; R-user-3). Server-side interface, deliberately NOT in
 * `@gogo/shared` (it's I/O). The avatar endpoints depend ONLY on this port;
 * the concrete provider (S3/R2/…) is a parked infra escalation (Autonomy
 * Contract #3 — new billed service), so no provider adapter exists yet.
 * Until one lands, prod wiring uses `UNCONFIGURED_OBJECT_STORAGE` below:
 * presign fails LOUD (500), existence checks fail CLOSED (commit → 400).
 *
 * Key namespace (R-user-3): `avatars/{user_id}/{uuid}` — the user id baked
 * into the key is what makes "issued to that user" checkable at commit time
 * without a ticket table: a key is committable iff (a) it parses to the
 * caller's own namespace and (b) its object exists in storage. Objects can
 * only come into existence through a presigned PUT to a server-minted key
 * (unguessable uuid), so (a)+(b) ⇒ server-issued-to-caller.
 */
import { randomUUID } from "node:crypto";

/** What a provider returns for one presigned upload. */
export interface PresignedUpload {
  /** The URL the client PUTs the bytes to. */
  url: string;
  /** Headers the client must send with the PUT (content-type, etc.). */
  headers: Record<string, string>;
}

/** The port (spec §3.7): presign + existence. Implemented per provider. */
export interface ObjectStorage {
  createPresignedUpload(
    key: string,
    contentType: string,
    byteSize: number,
    ttlSeconds: number,
  ): Promise<PresignedUpload>;
  objectExists(key: string): Promise<boolean>;
}

/**
 * Canonical hyphenated lowercase UUID (exactly what `randomUUID()` mints).
 * Deliberately case-SENSITIVE: storage keys are case-sensitive, minted keys
 * are lowercase, and a case-variant of a real key names a different (never-
 * presigned) object — parse must reject it, not normalize it.
 */
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const AVATAR_KEY_RE = new RegExp(`^avatars/(${UUID_SOURCE})/(${UUID_SOURCE})$`);

/** Mint a fresh avatar storage key in the caller's namespace (R-user-3). */
export function mintAvatarKey(userId: string): string {
  return `avatars/${userId}/${randomUUID()}`;
}

/**
 * Strict parse of an avatar key. Anything that is not EXACTLY
 * `avatars/{uuid}/{uuid}` (traversal, extra segments, non-uuid parts, other
 * prefixes) returns null — crafted keys never reach a storage lookup with
 * surprising shapes.
 */
export function parseAvatarKey(key: string): { userId: string; objectId: string } | null {
  const match = AVATAR_KEY_RE.exec(key);
  if (!match?.[1] || !match[2]) return null;
  return { userId: match[1], objectId: match[2] };
}

/**
 * The stand-in bound in prod wiring until the object-storage provider
 * escalation resolves. Presign requests throw (→ the app error handler's
 * uniform 500 INTERNAL, name-only logged); existence checks return false
 * (fail closed: no commit can succeed against storage that doesn't exist).
 */
export const UNCONFIGURED_OBJECT_STORAGE: ObjectStorage = {
  createPresignedUpload() {
    return Promise.reject(new ObjectStorageUnconfiguredError());
  },
  objectExists() {
    return Promise.resolve(false);
  },
};

/** Named so the error-handler's name-only log line is self-explanatory. */
export class ObjectStorageUnconfiguredError extends Error {
  constructor() {
    super("object storage provider is not configured");
    this.name = "ObjectStorageUnconfiguredError";
  }
}
