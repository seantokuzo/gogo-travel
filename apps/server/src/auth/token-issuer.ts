/**
 * Sign-in token issuance (T-5.2 / AU-3 slice of R-auth-8/9).
 *
 * Creates the `auth_sessions` row + its first refresh token and signs the
 * ES256 access token. Claims are exactly `{iss, aud, sub, sid, iat, exp}`
 * (spec §3.2 — no email/PII in tokens); the refresh token is 256-bit CSPRNG
 * persisted as a SHA-256 hash ONLY (R-auth-9 — plaintext never touches the
 * DB or a log line).
 *
 * Rotation, reuse-revocation, and `/auth/refresh` are AU-4's — this module
 * owns only the sign-in path's issuance.
 */
import { SignJWT, type CryptoKey, type KeyObject } from "jose";
import type { PushPlatform } from "@gogo/shared/enums";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  REFRESH_TOKEN_TTL_MS,
} from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { mintRefreshToken, sha256Hex } from "./crypto.js";

/** ES256 signing material — key from env (Law #1), `kid` rides the header (§3.2). */
export interface AccessTokenSigner {
  privateKey: CryptoKey | KeyObject;
  kid: string;
}

export interface DeviceInput {
  deviceName?: string | undefined;
  platform: PushPlatform;
}

export interface IssuedTokens {
  accessToken: string;
  /** Plaintext — returned to the client once, stored only as SHA-256 (R-auth-9). */
  refreshToken: string;
  /** Seconds — `ACCESS_TOKEN_TTL` on the wire (spec §3.4.1). */
  expiresIn: number;
  sessionId: string;
}

/** Sign the ES256 access token — claims exactly `{iss, aud, sub, sid, iat, exp}`. */
export async function signAccessToken(
  signer: AccessTokenSigner,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "ES256", kid: signer.kid })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
    .sign(signer.privateKey);
}

/**
 * One signed-in device = one `auth_sessions` row + one live refresh token,
 * created atomically (transaction-capable driver required — landmine #1: the
 * Neon HTTP driver would throw here; prod uses the WebSocket `Pool`).
 */
export async function createSessionWithTokens(
  db: DbClient,
  input: { userId: string; device: DeviceInput; signer: AccessTokenSigner; now?: Date },
): Promise<IssuedTokens> {
  const now = input.now ?? new Date();
  const refreshToken = mintRefreshToken();

  const sessionId = await db.transaction(async (tx) => {
    const [session] = await tx
      .insert(schema.authSessions)
      .values({
        userId: input.userId,
        deviceName: input.device.deviceName ?? null,
        platform: input.device.platform,
      })
      .returning({ id: schema.authSessions.id });
    if (!session) throw new Error("auth_sessions insert returned no row");

    await tx.insert(schema.refreshTokens).values({
      sessionId: session.id,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    });

    return session.id;
  });

  return {
    accessToken: await signAccessToken(input.signer, input.userId, sessionId, now),
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    sessionId,
  };
}
