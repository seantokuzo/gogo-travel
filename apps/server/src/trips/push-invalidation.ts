/**
 * Push-invalidation emitter seam (T-6.3 / API-TRIPS-4; trips spec §3.5 rule 6,
 * R-trips-18). The domain-event half of collab sync v1: every mutation in the
 * trips domain emits its §3.5 event POST-COMMIT so other members' devices
 * refetch — ids only, never entity content or PII.
 *
 * CONTRACT (mirrors the T-6.4 `placesIngest` hook discipline exactly):
 *
 *  - **Post-commit only.** Routers call `emit` strictly AFTER
 *    `await db.transaction(...)` returns (or after a single-statement
 *    auto-commit write succeeds). An aborted transaction must NEVER emit —
 *    the emitter has no way to un-send.
 *  - **Never throws, never blocks.** `emit` is fire-and-forget: all work runs
 *    on an internal serial chain; every failure is swallowed into
 *    `logger.warn`. A failed emission must never fail the user request —
 *    call sites are additionally `?.`-guarded + try/catch'd (`emitTripEvent`)
 *    so even a broken seam can't take a 2xx down.
 *  - **No locks, no transaction scope.** Recipient resolution is plain
 *    post-commit SELECTs on the emitter's own implicit transactions.
 *
 * FAN-OUT (R-trips-18 / §3.5 rule 6):
 *
 *  - Default recipient set = the trip's CURRENT members, resolved post-commit.
 *  - `recipientsSnapshot` overrides the member query for events whose member
 *    rows are gone by commit time: `trip.deleted` passes the fence
 *    transaction's pre-delete membership snapshot (R-trips-8: "to all other
 *    members captured before the delete" — the capture is spec text, and the
 *    delete fence already reads exactly those rows, so the snapshot adds no
 *    query and no lock).
 *  - `alsoNotify` adds recipients beyond current membership: the removed
 *    member on `member.removed` (§3.5 rule 6: "removed member included on
 *    removal so their device evicts").
 *  - The ACTOR is always excluded (their device performed the mutation and
 *    reconciled from the response, R-trips-19).
 *  - LIVE members only: every candidate passes a `users.deleted_at IS NULL`
 *    check — ghost membership rows never receive events (same live-member
 *    semantics as member_count and the sole-owner guard, STATE P-6 landmine).
 *  - Device fan-out is via `push_tokens` (API-TRIPS-4): each recipient
 *    carries their registered tokens (possibly none — invalidation is
 *    user-grained; the transport skips token-less users).
 *
 * TRANSPORT is a stub seam: P-13 (notifications spec) supplies the real Expo
 * push transport (Law #5 — nothing here talks to an external service). With
 * no transport wired (prod today), the emitter is DORMANT — it skips
 * resolution entirely, so the seam costs nothing until P-13 turns it on.
 * Tests wire a recording transport to observe deliveries.
 */
import {
  PushInvalidationPayloadSchema,
  type PushInvalidationPayload,
  type TripDomainEvent,
} from "@gogo/shared/domains/trip";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";

/** One post-commit domain-event emission (§3.5 table row + fan-out inputs). */
export interface TripEventEmission {
  event: TripDomainEvent;
  tripId: string;
  /** The acting user — never a recipient (R-trips-18). */
  actorId: string;
  /** §3.5 third column: member events → `user_id`, invite events → `invite_id`. */
  entityId?: string;
  /**
   * Pre-captured member user-ids replacing the post-commit member query —
   * REQUIRED for `trip.deleted`, whose membership rows are cascade-gone by
   * commit time (R-trips-8 "captured before the delete").
   */
  recipientsSnapshot?: readonly string[];
  /**
   * Recipients beyond current membership — the removed user on
   * `member.removed` (§3.5 rule 6). Still actor-excluded and live-filtered.
   */
  alsoNotify?: readonly string[];
}

export interface PushInvalidationRecipient {
  userId: string;
  /** The user's registered Expo push tokens (`push_tokens`); may be empty. */
  tokens: readonly string[];
}

/** What the transport receives: the §3.5 ids-only payload + resolved fan-out. */
export interface PushInvalidationDelivery {
  payload: PushInvalidationPayload;
  /** Live, actor-excluded, deduplicated; sorted by userId for determinism. */
  recipients: readonly PushInvalidationRecipient[];
}

/**
 * The P-13 seam. Implementations must tolerate empty recipient/token sets.
 * Errors (sync throw or rejection) are swallowed + logged by the emitter.
 */
export interface PushInvalidationTransport {
  deliver(delivery: PushInvalidationDelivery): void | Promise<void>;
}

/** What routers depend on — emit only (`TripsRouterDeps.tripEvents`). */
export interface TripEventEmitter {
  /** Post-commit, fire-and-forget. Never throws; never blocks. */
  emit(emission: TripEventEmission): void;
}

export interface TripEventEmitterDeps {
  db: DbClient;
  /**
   * Absent (prod until P-13) ⇒ the emitter is dormant: emissions are
   * accepted and dropped without touching the database.
   */
  transport?: PushInvalidationTransport;
  logger?: { warn: (message: string) => void };
}

export interface WiredTripEventEmitter extends TripEventEmitter {
  /** Resolves when every previously emitted event has been delivered (tests). */
  idle(): Promise<void>;
}

/**
 * Double-guard helper for call sites — the T-6.4 hook shape (`?.` + swallow)
 * as one call, so a broken seam can never fail the user request even if a
 * future emitter implementation forgets its own never-throws contract.
 */
export function emitTripEvent(
  emitter: TripEventEmitter | undefined,
  emission: TripEventEmission,
): void {
  try {
    emitter?.emit(emission);
  } catch {
    // Deliberately swallowed: emission is best-effort (R-trips-18 delivery
    // is invalidation, not truth — refetch-on-focus is the safety net).
  }
}

/**
 * Pure fan-out assembly (exported for unit tests): dedupe candidates, exclude
 * the actor, keep only live user ids, attach tokens, sort for determinism.
 * `liveUserIds` is the DB's answer to "which candidates are live" — ordering
 * here never trusts query order.
 */
export function buildDelivery(
  emission: TripEventEmission,
  candidateIds: readonly string[],
  liveUserIds: ReadonlySet<string>,
  tokenRows: ReadonlyArray<{ userId: string; token: string }>,
): PushInvalidationDelivery {
  const tokensByUser = new Map<string, string[]>();
  for (const row of tokenRows) {
    const list = tokensByUser.get(row.userId) ?? [];
    list.push(row.token);
    tokensByUser.set(row.userId, list);
  }

  const finalIds = [...new Set(candidateIds)]
    .filter((id) => id !== emission.actorId && liveUserIds.has(id))
    .sort();

  const payload: PushInvalidationPayload = {
    event: emission.event,
    trip_id: emission.tripId,
    ...(emission.entityId !== undefined ? { entity_id: emission.entityId } : {}),
  };

  return {
    payload,
    recipients: finalIds.map((userId) => ({
      userId,
      tokens: tokensByUser.get(userId) ?? [],
    })),
  };
}

export function createTripEventEmitter(deps: TripEventEmitterDeps): WiredTripEventEmitter {
  const logger = deps.logger ?? console;
  // Serial chain: emissions resolve + deliver in emission order, one at a
  // time (same discipline as places/ingest-queue's serial drain), and
  // `idle()` gives tests a deterministic settle point.
  let chain: Promise<void> = Promise.resolve();

  async function resolveAndDeliver(
    emission: TripEventEmission,
    transport: PushInvalidationTransport,
  ): Promise<void> {
    // Candidates: the pre-captured snapshot (trip.deleted) or the CURRENT
    // membership, plus any explicit extras (removed member). Actor exclusion
    // happens in buildDelivery; it is applied before the queries too purely
    // to keep them minimal.
    const memberIds = emission.recipientsSnapshot
      ? [...emission.recipientsSnapshot]
      : (
          await deps.db
            .select({ userId: schema.tripMembers.userId })
            .from(schema.tripMembers)
            .where(eq(schema.tripMembers.tripId, emission.tripId))
        ).map((row) => row.userId);

    const candidateIds = [...new Set([...memberIds, ...(emission.alsoNotify ?? [])])];
    const queryIds = candidateIds.filter((id) => id !== emission.actorId);

    // Live filter (ghosts never get events) + token fan-out. Empty candidate
    // sets skip the queries outright — `inArray` with [] is never issued.
    const liveIds =
      queryIds.length === 0
        ? []
        : (
            await deps.db
              .select({ id: schema.users.id })
              .from(schema.users)
              .where(and(inArray(schema.users.id, queryIds), isNull(schema.users.deletedAt)))
          ).map((row) => row.id);

    const tokenRows =
      liveIds.length === 0
        ? []
        : await deps.db
            .select({ userId: schema.pushTokens.userId, token: schema.pushTokens.token })
            .from(schema.pushTokens)
            .where(inArray(schema.pushTokens.userId, liveIds));

    const delivery = buildDelivery(emission, candidateIds, new Set(liveIds), tokenRows);
    // Belt-and-braces (Law #3 adjacent): the wire schema is strict — a
    // payload that ever grew a content field would throw HERE, into the
    // swallow-and-log path below, never onto a device.
    PushInvalidationPayloadSchema.parse(delivery.payload);
    await transport.deliver(delivery);
  }

  return {
    emit(emission) {
      try {
        const transport = deps.transport;
        if (!transport) return; // Dormant until P-13 wires the real one.
        chain = chain.then(async () => {
          try {
            await resolveAndDeliver(emission, transport);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(
              `push-invalidation: ${emission.event} for trip ${emission.tripId} dropped: ${message}`,
            );
          }
        });
      } catch (err) {
        // emit() itself must never throw into a request handler.
        try {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`push-invalidation: emit failed synchronously: ${message}`);
        } catch {
          // Even a throwing logger can't break the request.
        }
      }
    },

    async idle() {
      // The chain only ever grows; awaiting until it stops moving guarantees
      // every emission enqueued before (and during) the wait has settled.
      let settled = chain;
      await settled;
      while (settled !== chain) {
        settled = chain;
        await settled;
      }
    },
  };
}
