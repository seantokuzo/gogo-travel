/**
 * Sign-in account resolution (T-5.2 / AU-3 — R-auth-4/5/6/15).
 *
 * Given a VERIFIED provider identity (provider-verify.ts ran first — never
 * call this with unverified claims), resolves the `users` row:
 *
 *   sub known            → sign in that user, never a second account (R-auth-4)
 *   sub new, email new   → create user + entitlements in one txn (R-auth-5)
 *   sub new, email known → auto-link the missing provider sub — verified
 *                          email only (R-auth-6, Gate-2 resolution)
 *
 * Rejections (`SignInRejectedError`) are deliberately verification-shaped:
 * the route serializes them as the same undifferentiated 401 as a bad
 * signature — no oracle for "does this account exist" (spec §3.6.4).
 *
 * Security pins beyond the literal EARS text (flagged in the T-5.2 report;
 * §3.6.2's rationale is the authority):
 *  • An unknown-sub sign-in whose email is UNVERIFIED is rejected outright —
 *    for creation as well as linking. Creating an account keyed on an
 *    unverified email plants a future R-auth-6 auto-link takeover (the
 *    planted row's email would later attract a victim's verified identity).
 *  • If the email-matched account already carries a DIFFERENT sub for the
 *    same provider, we reject instead of overwriting — silently replacing a
 *    provider identity is account takeover, and v1 has no recovery flow.
 */
import { eq, isNull, sql, type SQL } from "drizzle-orm";
import { and } from "drizzle-orm";
import { createUserWithEntitlements, type DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { VerifiedIdentity } from "./provider-verify.js";

type UserRow = typeof schema.users.$inferSelect;

export type SignInRejectionReason =
  | "email_missing" // unknown sub and no email claim — R-auth-5/6 can't run
  | "email_unverified" // R-auth-6 gate (and its creation-side twin, see header)
  | "provider_identity_conflict"; // same-provider slot occupied by another sub

export class SignInRejectedError extends Error {
  readonly reason: SignInRejectionReason;

  constructor(reason: SignInRejectionReason) {
    // Fixed message — the wire body never varies (spec §3.6.4).
    super("sign-in rejected", {});
    this.name = "SignInRejectedError";
    this.reason = reason;
  }
}

export interface SignInResolution {
  user: UserRow;
  isNewUser: boolean;
}

/** Display-name seed material (R-auth-5): Apple = request body, Google = token claims. */
export interface NameSeed {
  fullName?: string | undefined;
  givenName?: string | undefined;
  familyName?: string | undefined;
}

/**
 * R-auth-5: provider name fields when present, else the email local part;
 * the user edits it at onboarding. Clamped to the `DisplayNameSchema` cap.
 */
export function seedDisplayName(name: NameSeed, email: string): string {
  const fromParts = [name.givenName, name.familyName]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" ");
  const candidate = name.fullName?.trim() || fromParts || email.split("@")[0]?.trim() || "Traveler";
  return candidate.slice(0, 50);
}

function subColumn(provider: VerifiedIdentity["provider"]) {
  return provider === "apple" ? schema.users.appleSub : schema.users.googleSub;
}

async function findBySub(db: DbClient, identity: VerifiedIdentity): Promise<UserRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(subColumn(identity.provider), identity.sub))
    .limit(1);
  return row;
}

function lowerEmailEquals(email: string): SQL {
  return sql`lower(${schema.users.email}) = ${email.toLowerCase()}`;
}

/** Postgres unique_violation (23505), possibly wrapped by Drizzle — walk `cause`. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}

/**
 * Attempt the R-auth-6 auto-link: set the missing sub on the email-matched
 * row. The `IS NULL` predicate in the UPDATE makes the link atomic — a
 * concurrent linker can't be overwritten, only beaten (0 rows → re-check).
 */
async function linkProviderSub(
  db: DbClient,
  identity: VerifiedIdentity,
  existing: UserRow,
): Promise<UserRow> {
  const column = subColumn(identity.provider);
  const [linked] = await db
    .update(schema.users)
    .set(identity.provider === "apple" ? { appleSub: identity.sub } : { googleSub: identity.sub })
    .where(and(eq(schema.users.id, existing.id), isNull(column)))
    .returning();
  if (linked) return linked;

  // Lost a race: someone set the slot since we read the row. If it became
  // OUR sub (double-submit), that's a plain returning-user sign-in.
  const rematch = await findBySub(db, identity);
  if (rematch && rematch.id === existing.id) return rematch;
  throw new SignInRejectedError("provider_identity_conflict");
}

async function resolveOnce(db: DbClient, identity: VerifiedIdentity): Promise<SignInResolution> {
  // R-auth-4: a known sub signs in — never a second account.
  const bySub = await findBySub(db, identity);
  if (bySub) return { user: bySub, isNewUser: false };

  // Everything past this point anchors on the email claim.
  if (!identity.email) throw new SignInRejectedError("email_missing");
  if (!identity.emailVerified) throw new SignInRejectedError("email_unverified");

  const [byEmail] = await db
    .select()
    .from(schema.users)
    .where(lowerEmailEquals(identity.email))
    .limit(1);

  if (byEmail) {
    // R-auth-6 auto-link — unless the same-provider slot already carries a
    // different sub (see header: overwrite = takeover, reject).
    const occupied = identity.provider === "apple" ? byEmail.appleSub : byEmail.googleSub;
    if (occupied !== null && occupied !== identity.sub) {
      throw new SignInRejectedError("provider_identity_conflict");
    }
    return { user: await linkProviderSub(db, identity, byEmail), isNewUser: false };
  }

  // R-auth-5: new account — user + entitlements ('free') in one transaction.
  // R-auth-15 holds by construction: exactly one provider sub is always set.
  const { user } = await createUserWithEntitlements(db, {
    email: identity.email,
    displayName: seedDisplayName(identity.name, identity.email),
    ...(identity.provider === "apple" ? { appleSub: identity.sub } : { googleSub: identity.sub }),
  });
  return { user, isNewUser: true };
}

/**
 * Resolve the account for a verified identity. Concurrency: two first-ever
 * sign-ins racing on the same sub/email both reach the INSERT; the loser's
 * unique violation (sub or lower(email)) is retried once as a lookup — the
 * winner's row is then found by sub or linked by email (R-auth-4: never two
 * accounts for one sub).
 */
export async function resolveSignIn(
  db: DbClient,
  identity: VerifiedIdentity,
  nameSeed?: NameSeed,
): Promise<SignInResolution> {
  const enriched: VerifiedIdentity = nameSeed
    ? { ...identity, name: { ...identity.name, ...nameSeed } }
    : identity;
  try {
    return await resolveOnce(db, enriched);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return await resolveOnce(db, enriched);
  }
}
