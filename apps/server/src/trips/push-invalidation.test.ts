/**
 * Unit suite for the push-invalidation emitter seam (T-6.3 / API-TRIPS-4;
 * trips spec §3.5 rule 6, R-trips-18) — the pure fan-out assembly and the
 * never-throws/never-blocks discipline, over fake deps. End-to-end emission
 * (real routes, real Postgres, real membership/tokens) runs in the three
 * trips DB suites (`routes.db.test.ts`, `members-routes.db.test.ts`,
 * `invites-routes.db.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { PUSH_EVENT_LOG_MAX_CHARS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import {
  buildDelivery,
  createTripEventEmitter,
  emitTripEvent,
  redactedDropMessage,
  type PushInvalidationDelivery,
  type TripEventEmission,
} from "./push-invalidation.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const U1 = "33333333-3333-4333-8333-333333333333";
const U2 = "44444444-4444-4444-8444-444444444444";
const GHOST = "55555555-5555-4555-8555-555555555555";

const emission = (overrides: Partial<TripEventEmission> = {}): TripEventEmission => ({
  event: "trip.updated",
  tripId: TRIP,
  actorId: ACTOR,
  ...overrides,
});

/**
 * Minimal fake for the emitter's three `select().from().where()` reads —
 * resolves queued row sets in call order. Chain-shape drift would fail these
 * tests loudly (and the DB suites cover the real driver).
 */
function fakeDb(rowSets: unknown[][]): DbClient {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rowSets[call++] ?? []),
      }),
    }),
  } as unknown as DbClient;
}

/** A db whose very first touch throws — proves dormant paths never query. */
const poisonedDb = () =>
  ({
    select: () => {
      throw new Error("db must not be touched");
    },
  }) as unknown as DbClient;

describe("buildDelivery (pure fan-out assembly)", () => {
  it("excludes the actor, drops non-live candidates, dedupes, sorts, attaches tokens", () => {
    const delivery = buildDelivery(
      emission(),
      [U2, U1, ACTOR, U1, GHOST], // dupes + actor + ghost in the candidate set
      new Set([U1, U2, ACTOR]), // ghost is not live; actor liveness is irrelevant
      [
        { userId: U1, token: "tok-a" },
        { userId: U1, token: "tok-b" },
      ],
    );
    expect(delivery.recipients).toEqual([
      { userId: U1, tokens: ["tok-a", "tok-b"] },
      { userId: U2, tokens: [] }, // token-less users stay user-grained recipients
    ]);
  });

  it("payload is EXACTLY { event, trip_id } / { event, trip_id, entity_id } — ids only (R-trips-18)", () => {
    const bare = buildDelivery(emission(), [], new Set(), []);
    expect(bare.payload).toEqual({ event: "trip.updated", trip_id: TRIP });
    expect(Object.keys(bare.payload)).toEqual(["event", "trip_id"]);

    const withEntity = buildDelivery(
      emission({ event: "member.removed", entityId: U1 }),
      [],
      new Set(),
      [],
    );
    expect(Object.keys(withEntity.payload)).toEqual(["event", "trip_id", "entity_id"]);
    expect(withEntity.payload.entity_id).toBe(U1);
  });
});

describe("redactedDropMessage (advisory #3 — token-safe drop logs)", () => {
  it("strips BOTH Expo token shapes and never leaks the token body", () => {
    const message = redactedDropMessage(
      new Error(
        "ExponentPushToken[secret-abc] rejected; retry of ExpoPushToken[secret-xyz] also failed",
      ),
    );
    expect(message).not.toContain("secret-abc");
    expect(message).not.toContain("secret-xyz");
    expect(message.match(/\[push-token-redacted\]/g)).toHaveLength(2);
  });

  it("caps the redacted message at the config length (redact FIRST, then cap)", () => {
    // A token straddling the cap boundary must not survive via truncation:
    // redaction runs before the slice.
    const long = `${"x".repeat(PUSH_EVENT_LOG_MAX_CHARS - 10)}ExponentPushToken[tail-secret]`;
    const message = redactedDropMessage(new Error(long));
    expect(message.length).toBeLessThanOrEqual(PUSH_EVENT_LOG_MAX_CHARS);
    expect(message).not.toContain("tail-secret");
    expect(redactedDropMessage("not-an-error")).toBe("not-an-error");
  });
});

describe("emitTripEvent (call-site double guard)", () => {
  it("tolerates an absent emitter and swallows a throwing one", () => {
    expect(() => emitTripEvent(undefined, emission())).not.toThrow();
    const broken = {
      emit: () => {
        throw new Error("broken seam");
      },
    };
    expect(() => emitTripEvent(broken, emission())).not.toThrow();
  });
});

describe("createTripEventEmitter", () => {
  it("is DORMANT without a transport: accepts emissions, never touches the db", async () => {
    const warnings: string[] = [];
    const emitter = createTripEventEmitter({
      db: poisonedDb(),
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(() => emitter.emit(emission())).not.toThrow();
    await emitter.idle();
    expect(warnings).toEqual([]);
  });

  it("resolves membership → liveness → tokens and delivers in emission order", async () => {
    const recorded: PushInvalidationDelivery[] = [];
    const emitter = createTripEventEmitter({
      // First emission: members [U1, actor], live [U1], tokens [U1×1].
      // Second emission: members [U2], live [U2], no tokens.
      db: fakeDb([
        [{ userId: U1 }, { userId: ACTOR }],
        [{ id: U1 }],
        [{ userId: U1, token: "tok-a" }],
        [{ userId: U2 }],
        [{ id: U2 }],
        [],
      ]),
      transport: { deliver: (d) => void recorded.push(d) },
      logger: { warn: () => undefined },
    });

    emitter.emit(emission());
    emitter.emit(emission({ event: "trip.status_changed" }));
    await emitter.idle();

    expect(recorded.map((d) => d.payload.event)).toEqual(["trip.updated", "trip.status_changed"]);
    expect(recorded[0]?.recipients).toEqual([{ userId: U1, tokens: ["tok-a"] }]);
    expect(recorded[1]?.recipients).toEqual([{ userId: U2, tokens: [] }]);
  });

  it("a recipientsSnapshot bypasses the member query (trip.deleted: rows are gone post-commit)", async () => {
    const recorded: PushInvalidationDelivery[] = [];
    const emitter = createTripEventEmitter({
      // Only TWO reads: liveness + tokens — no membership query.
      db: fakeDb([[{ id: U1 }, { id: U2 }], []]),
      transport: { deliver: (d) => void recorded.push(d) },
      logger: { warn: () => undefined },
    });
    emitter.emit(emission({ event: "trip.deleted", recipientsSnapshot: [U1, U2, ACTOR] }));
    await emitter.idle();
    expect(recorded[0]?.recipients.map((r) => r.userId)).toEqual([U1, U2]);
  });

  it("an actor-only fan-out skips every query and delivers empty recipients", async () => {
    const recorded: PushInvalidationDelivery[] = [];
    const emitter = createTripEventEmitter({
      db: fakeDb([[{ userId: ACTOR }]]), // members = actor alone → no further reads
      transport: { deliver: (d) => void recorded.push(d) },
      logger: { warn: () => undefined },
    });
    emitter.emit(emission());
    await emitter.idle();
    // Still an emission (distinguishable from "never emitted") — just no fan-out.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.recipients).toEqual([]);
  });

  it("a db failure is swallowed + logged, and the chain keeps draining", async () => {
    const recorded: PushInvalidationDelivery[] = [];
    const warnings: string[] = [];
    let call = 0;
    const db = {
      select: () => {
        if (call++ === 0) throw new Error("connection reset");
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      },
    } as unknown as DbClient;
    const emitter = createTripEventEmitter({
      db,
      transport: { deliver: (d) => void recorded.push(d) },
      logger: { warn: (m) => warnings.push(m) },
    });

    emitter.emit(emission()); // dies on the poisoned first select
    emitter.emit(emission({ event: "invite.created", entityId: U1 }));
    await emitter.idle();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("trip.updated");
    expect(warnings[0]).toContain("connection reset");
    expect(recorded.map((d) => d.payload.event)).toEqual(["invite.created"]);
  });

  it("drop logs are token-safe: a transport error embedding a push token logs REDACTED (advisory #3)", async () => {
    const warnings: string[] = [];
    const emitter = createTripEventEmitter({
      db: fakeDb([[{ userId: U1 }], [{ id: U1 }], [{ userId: U1, token: "tok-a" }]]),
      transport: {
        deliver: () => {
          throw new Error(
            "DeviceNotRegistered: ExponentPushToken[dev-secret-1] is not a registered push token",
          );
        },
      },
      logger: { warn: (m) => warnings.push(m) },
    });
    emitter.emit(emission());
    await emitter.idle();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[push-token-redacted]");
    expect(warnings[0]).not.toContain("dev-secret-1");
  });

  it("a throwing OR rejecting transport is swallowed + logged; emit never throws", async () => {
    const warnings: string[] = [];
    const makeEmitter = (deliver: (d: PushInvalidationDelivery) => void | Promise<void>) =>
      createTripEventEmitter({
        db: fakeDb([[{ userId: U1 }], [{ id: U1 }], []]),
        transport: { deliver },
        logger: { warn: (m) => warnings.push(m) },
      });

    const throwing = makeEmitter(() => {
      throw new Error("transport sync boom");
    });
    expect(() => throwing.emit(emission())).not.toThrow();
    await throwing.idle();

    const rejecting = makeEmitter(() => Promise.reject(new Error("transport async boom")));
    expect(() => rejecting.emit(emission())).not.toThrow();
    await rejecting.idle();

    expect(warnings.some((m) => m.includes("transport sync boom"))).toBe(true);
    expect(warnings.some((m) => m.includes("transport async boom"))).toBe(true);
  });
});
