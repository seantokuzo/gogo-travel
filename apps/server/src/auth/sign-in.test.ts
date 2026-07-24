/**
 * T-5.2 display-name seeding (R-auth-5) + the concurrency machinery of
 * `resolveSignIn` (R-auth-4/6) driven by deterministic `DbClient` stubs — the
 * unique-violation retry and lost-link-race rematch branches are unreachable
 * via the happy-path integration suite (they need a genuine race), so they're
 * pinned here. End-to-end resolution flows live in `signin-routes.db.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { DisplayNameSchema } from "@gogo/shared/domains/user";
import type { DbClient } from "../db/create-user.js";
import type * as schema from "../db/schema/index.js";
import type { VerifiedIdentity } from "./provider-verify.js";
import { resolveSignIn, SignInRejectedError, seedDisplayName } from "./sign-in.js";

type UserRow = typeof schema.users.$inferSelect;

describe("seedDisplayName", () => {
  it("joins given + family name", () => {
    expect(seedDisplayName({ givenName: "Sean", familyName: "Tokuzo" }, "s@example.com")).toBe(
      "Sean Tokuzo",
    );
  });

  it("prefers the provider's full name when present", () => {
    expect(
      seedDisplayName(
        { fullName: "Sean T.", givenName: "Sean", familyName: "Tokuzo" },
        "s@example.com",
      ),
    ).toBe("Sean T.");
  });

  it("uses a lone given name without trailing whitespace", () => {
    expect(seedDisplayName({ givenName: " Sean " }, "s@example.com")).toBe("Sean");
  });

  it("falls back to the email local part when no name fields arrive", () => {
    expect(seedDisplayName({}, "wanderer42@example.com")).toBe("wanderer42");
  });

  it("whitespace-only name fields fall through to the email local part", () => {
    expect(seedDisplayName({ fullName: "  ", givenName: " " }, "trip.lord@example.com")).toBe(
      "trip.lord",
    );
  });

  it("clamps to 50 chars (DisplayNameSchema cap)", () => {
    const seeded = seedDisplayName({ fullName: "x".repeat(80) }, "s@example.com");
    expect(seeded).toHaveLength(50);
  });

  it("degenerate email local part still yields a non-empty name", () => {
    expect(seedDisplayName({}, "@example.com")).toBe("Traveler");
  });

  it("clamps code-point-safe: an emoji straddling index 50 never leaves a lone surrogate", () => {
    // 49 ASCII + a 2-UTF-16-unit emoji: a naive slice(0, 50) keeps only the
    // emoji's lead surrogate → invalid UTF-8 that Postgres rejects (500).
    const name = "x".repeat(49) + "😀" + "y".repeat(10);
    const seeded = seedDisplayName({ fullName: name }, "s@example.com");

    expect([...seeded]).toHaveLength(50); // 50 whole code points
    expect(seeded).toBe("x".repeat(49) + "😀");
    // Round-trips through UTF-8 unchanged (no lone surrogate).
    expect(Buffer.from(seeded, "utf8").toString("utf8")).toBe(seeded);
    // The naive UTF-16 slice would have split the surrogate pair.
    expect(name.slice(0, 50)).not.toBe(seeded);
  });

  it("an astral seeded name (>50 code units, ≤50 code points) re-parses through DisplayNameSchema", () => {
    // seedDisplayName clamps to 50 code POINTS; the write schema now also caps
    // code points. 30 emoji = 30 code points but 60 UTF-16 code units: the seed
    // leaves it whole and the write schema re-accepts it, so the system-
    // generated name round-trips through PATCH /users/me verbatim.
    const seeded = seedDisplayName({ fullName: "\u{1F600}".repeat(30) }, "s@example.com");
    expect([...seeded]).toHaveLength(30); // not clamped (≤50 code points)
    expect(seeded.length).toBe(60); // 60 UTF-16 code units
    expect(DisplayNameSchema.parse(seeded)).toBe(seeded); // write schema accepts it verbatim
  });

  it("strips control characters from provider name claims (write-side parity)", () => {
    expect(seedDisplayName({ fullName: "Sean\u0000\tTokuzo\n" }, "s@example.com")).toBe(
      "SeanTokuzo",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSignIn concurrency — deterministic DbClient stubs (R-auth-4/6)
// ---------------------------------------------------------------------------

/** A partial `users` row is all the resolution paths under test read. */
function userRow(overrides: Partial<UserRow>): UserRow {
  return { id: "user-0", appleSub: null, googleSub: null, ...overrides } as unknown as UserRow;
}

const googleIdentity: VerifiedIdentity = {
  provider: "google",
  sub: "google-sub-race",
  email: "race@example.com",
  emailVerified: true,
  name: {},
};

/**
 * Minimal chainable stub of the exact `DbClient` surface `resolveSignIn`
 * touches: `select…limit` (FIFO over `selects`), `update…returning`, and
 * `transaction` (the create path). `selects` entries are consumed in call
 * order — findBySub, then byEmail, then any rematch.
 */
function makeDb(opts: {
  selects: (UserRow | undefined)[];
  update?: UserRow[];
  transaction?: () => Promise<never>;
}): DbClient {
  let selectIdx = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const row = opts.selects[selectIdx++];
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(opts.update ?? []),
        }),
      }),
    }),
    transaction: (cb: (tx: unknown) => Promise<unknown>) =>
      opts.transaction ? opts.transaction() : cb(db),
  };
  return db as unknown as DbClient;
}

function unique23505(wrapped: boolean): Error {
  const pg = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
  return wrapped ? new Error("insert failed", { cause: pg }) : pg;
}

describe("resolveSignIn concurrency", () => {
  it("first-insert 23505 (bare) → retried as a lookup, winner found by sub (R-auth-4)", async () => {
    const winner = userRow({ id: "winner-1", googleSub: googleIdentity.sub });
    const db = makeDb({
      // resolveOnce #1: findBySub (none), byEmail (none) → create → throws.
      // resolveOnce #2 (retry): findBySub → winner.
      selects: [undefined, undefined, winner],
      transaction: () => Promise.reject(unique23505(false)),
    });

    const result = await resolveSignIn(db, googleIdentity);
    expect(result.user.id).toBe("winner-1");
    expect(result.isNewUser).toBe(false);
  });

  it("first-insert 23505 (Drizzle-cause-wrapped) → cause-walk still retries", async () => {
    const winner = userRow({ id: "winner-2", googleSub: googleIdentity.sub });
    const db = makeDb({
      selects: [undefined, undefined, winner],
      transaction: () => Promise.reject(unique23505(true)),
    });

    const result = await resolveSignIn(db, googleIdentity);
    expect(result.user.id).toBe("winner-2");
    expect(result.isNewUser).toBe(false);
  });

  it("link UPDATE returns 0 rows but rematch is OUR sub → returning-user sign-in (double-submit)", async () => {
    const existing = userRow({ id: "acct-1", googleSub: null });
    const rematch = userRow({ id: "acct-1", googleSub: googleIdentity.sub });
    const db = makeDb({
      // findBySub (none) → byEmail (existing) → link update 0 rows → rematch findBySub (acct-1).
      selects: [undefined, existing, rematch],
      update: [], // lost the link race
    });

    const result = await resolveSignIn(db, googleIdentity);
    expect(result.user.id).toBe("acct-1");
    expect(result.isNewUser).toBe(false);
  });

  it("link UPDATE returns 0 rows and rematch resolves to nothing → provider_identity_conflict", async () => {
    const existing = userRow({ id: "acct-2", googleSub: null });
    const db = makeDb({
      selects: [undefined, existing, undefined], // rematch finds no row
      update: [],
    });

    const error = await resolveSignIn(db, googleIdentity).then(
      () => {
        throw new Error("expected a provider_identity_conflict rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SignInRejectedError);
    expect((error as SignInRejectedError).reason).toBe("provider_identity_conflict");
  });
});
