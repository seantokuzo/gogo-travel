/**
 * Booking domain service (T-7.1 / IB-1) — THE single write path for
 * `bookings` + their derived `itinerary_items` (itinerary-bookings spec §3.1:
 * "All booking writers — this router, the capture landing service, any
 * future job — go through one booking domain service"). The P-11 capture
 * pipeline's landing flow calls these functions directly — hence the module
 * boundary: plain functions over a transaction-capable `DbClient` + typed
 * inputs, no Hono imports; failures are typed `HttpError`s the caller maps.
 * (`ServiceBookingCreate` widens `source` to the full enum so capture can
 * set `email`/`share` — the ROUTER's wire schema is what restricts direct
 * clients to `manual`/`deeplink_return`, R-ib-11.)
 *
 * INVARIANTS enforced transactionally (§3.1):
 *  - I-1  `idea` ⇒ zero items
 *  - I-2  `planned|booked` ∧ starts_at known ⇒ exactly the derived item(s),
 *         day/times synced from the booking (the booking wins)
 *  - I-3  `planned|booked` ∧ starts_at NULL ⇒ zero items or exactly the
 *         user-scheduled item(s), which OWN their day/times (times removed
 *         from details ⇒ existing items keep their day/times — precedence
 *         rule; nothing silently vanishes)
 *  - I-4  `cancelled` ⇒ zero items; booking row retained
 *  - I-5  every mutation that can change a day's located sequence returns
 *         `dirtyDays` — the CALLER fires the dirty-day seam POST-COMMIT
 *         (dirty-days.ts contract; an aborted transaction must never mark)
 *
 * STATUS MACHINE (§3.2): `BOOKING_STATUS_TRANSITIONS` below is the matrix
 * verbatim; same-status is not a transition (no-op, allowed). Side effects
 * ride the transition in ONE transaction: `→ idea` / `→ cancelled` delete
 * items; entering the calendar with known times creates them.
 *
 * DRIVER: every multi-row write runs in `db.transaction` — the prod client
 * is the Neon WebSocket `Pool`, never Neon-HTTP (landmine #1: its
 * `.transaction()` throws; postgres-js tests can't catch it).
 *
 * LOCK ORDER (global, EXTENDED here — never reorder): users → trip_members
 * → invites → **bookings → itinerary_items**. Every service transaction
 * takes the booking row `FOR UPDATE` FIRST; item rows are only ever locked/
 * written while holding their parent booking's lock. IB-2's item mutations
 * on `booking`-kind items MUST take the parent booking `FOR UPDATE` before
 * touching the item (R-ib-9 writes the booking row too); `place_visit`/
 * `custom` items have no parent and are disjoint. The booking DELETE fences
 * its item rows with an ordered `FOR UPDATE` SELECT before the cascade
 * (cascade-lock-order landmine: FK triggers fire in creation order, not
 * acquisition order — the fence guarantees no other transaction holds
 * item-row locks at cascade time). T-7.3 note: `travel_legs` cascades off
 * `itinerary_items`; the leg job (its single writer) must tolerate item
 * deletion racing a recompute (upsert-on-dead-item = FK error → drop mark).
 */
import {
  deriveAutoItems,
  deriveBookingInstants,
  type BookingCreate,
  type BookingUpdate,
  type DerivedItemPlacement,
  type ScheduleBookingInput,
} from "@gogo/shared/domains/booking";
import type { BookingDetails } from "@gogo/shared/domains/booking";
import type { BookingSource, BookingStatus } from "@gogo/shared/enums";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { HttpError, NOT_FOUND_MESSAGE } from "../http/errors.js";
import { resolvePlaceAccess } from "../places/visibility.js";
import type { DirtyDayMark } from "./dirty-days.js";
import type { BookingRow, ItineraryItemRow } from "./serialize.js";

/** §3.2 transition matrix, verbatim. Anything absent is VALIDATION_FAILED. */
export const BOOKING_STATUS_TRANSITIONS: Readonly<
  Record<BookingStatus, readonly BookingStatus[]>
> = {
  idea: ["planned", "booked", "cancelled"],
  planned: ["idea", "booked", "cancelled"],
  // `booked → idea` is deliberate two-step friction (demote to planned first).
  booked: ["planned", "cancelled"],
  // Cancelled is terminal (R-ib-3).
  cancelled: [],
};

/**
 * The service-level create input: the wire `BookingCreate` with `source`
 * widened to the full enum — the capture landing service (P-11) is the only
 * caller allowed to pass `email`/`share` (R-ib-11); the router hands over
 * its schema-restricted body untouched.
 */
export type ServiceBookingCreate = Omit<BookingCreate, "source"> & {
  source?: BookingSource | undefined;
};

export interface BookingWriteResult {
  booking: BookingRow;
  /** Post-state calendar presence, ordered `(day, sort_order)` (R-ib-18). */
  items: ItineraryItemRow[];
  /**
   * Days whose located sequence may have changed (I-5) — the caller passes
   * these to `markDaysDirty` POST-COMMIT, never inside the transaction.
   */
  dirtyDays: DirtyDayMark[];
}

/** Any transaction scope (or the client itself) usable for reads. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Reader = DbClient | Tx;

/** Gap unit for `sort_order` (schema §3.3.10 — app assigns 1024 steps). */
const SORT_GAP = 1024;

/** `HH:MM:SS[.ffffff]` (Postgres `time`) → `HH:MM` for §3.3 comparisons. */
const wallHHMM = (value: string | null): string | null =>
  value === null ? null : value.slice(0, 5);

/** Both chain days of an item (§3.6: spanning items sit in BOTH days' chains). */
function itemDays(item: { day: string; endDay: string | null }): string[] {
  return item.endDay !== null && item.endDay !== item.day
    ? [item.day, item.endDay]
    : [item.day];
}

function marksFor(tripId: string, days: Iterable<string>): DirtyDayMark[] {
  return [...days].map((day) => ({ tripId, day }));
}

/**
 * Derived instants as DB values, with the schema CHECK
 * (`bookings_time_order_ck`) mirrored as a 400 — a details payload whose
 * derived end precedes its start must fail validation, not 500 on the
 * constraint. Cross-field detail rules are server-side refiners by design
 * (contracts §3.7 — the detail shapes stay AI-reusable and rule-free).
 */
function derivedInstantsOf(details: BookingDetails): {
  startsAt: Date | null;
  endsAt: Date | null;
} {
  const derived = deriveBookingInstants(details);
  const startsAt = derived.starts_at !== null ? new Date(derived.starts_at) : null;
  const endsAt = derived.ends_at !== null ? new Date(derived.ends_at) : null;
  if (startsAt !== null && endsAt !== null && endsAt.getTime() < startsAt.getTime()) {
    throw new HttpError(
      "VALIDATION_FAILED",
      "the category's primary end time precedes its start time",
      { details: "end before start" },
    );
  }
  return { startsAt, endsAt };
}

/**
 * §3.3 placements with the items-table CHECK
 * (`itinerary_items_end_day_ck`: `end_day IS NULL OR end_day >= day`)
 * mirrored as a 400 — the `derivedInstantsOf` posture, applied where the
 * CHECK actually fires (item derivation, not every details write; an idea
 * storing such details is legal because it holds zero items). Reachable via
 * the lodging arm: mixed-offset `check_in`/`check_out` whose UTC instants
 * are correctly ordered but whose WALL-dates invert (check-in's local date
 * after check-out's) derive `end_day < day`. The pure helper emits
 * as-derived (physics-faithful, its documented contract); the WRITE path
 * must answer VALIDATION_FAILED instead of surfacing 23514 as a 500.
 */
function derivedPlacementsOf(details: BookingDetails): DerivedItemPlacement[] {
  const placements = deriveAutoItems(details);
  for (const placement of placements) {
    if (placement.end_day !== null && placement.end_day < placement.day) {
      throw new HttpError(
        "VALIDATION_FAILED",
        "the category's primary end wall-date precedes its start wall-date",
        { details: "end day before start day" },
      );
    }
  }
  return placements;
}

/**
 * Law #3 / R-places-8 write-side gate for `bookings.place_id` (round-1 B1):
 * a booking's `place_id` is a VISIBILITY GRANT — places search widens
 * custom-place visibility to trip members via a bookings subquery
 * (`places/search-query.ts`), so writing it unchecked would let a caller
 * re-grant themselves (and everyone they invite) a custom place they cannot
 * see. The rule itself lives in the shared predicate
 * (`places/visibility.ts`, round-2 A1 — one copy for every surface); this
 * wrapper folds everything except visible into the canonical 404 (Law #3:
 * invisible ≡ absent), which also closes the 201-vs-500 existence oracle of
 * the unmapped FK 23503 (custom places are client-deletable — a stale id is
 * a legitimate flow, not an edge case). It runs inside the write
 * transaction, but under READ COMMITTED that is NO snapshot guarantee: a
 * place hard-deleted between this check and the row write still fires the
 * place FK — `isPlaceFkViolation` below maps that residue onto the SAME 404.
 */
async function assertPlaceVisible(
  tx: Tx,
  args: { placeId: string; userId: string },
): Promise<void> {
  const access = await resolvePlaceAccess(tx, args);
  if (access.kind === "not_found") throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);
}

/** The Drizzle-generated FK constraint guarding `bookings.place_id`. */
export const BOOKINGS_PLACE_FK = "bookings_place_id_places_id_fk";

/**
 * Round-2 A2: is this the place-FK 23503? The `assertPlaceVisible` →
 * insert/update window is a real race (READ COMMITTED — see above), so the
 * constraint is the last line and its violation must converge on the same
 * canonical 404, not a 500. Constraint-PRECISE on purpose: the other FKs on
 * this write path (trip, creator) are gate-proven and should stay loud if
 * they ever fire. 🔴 Driver trap (the `fkViolationTable` precedent,
 * `places/routes.ts`): postgres-js — the TEST driver — exposes the wire
 * field as `constraint_name`; pg-protocol's `DatabaseError` — what the PROD
 * Neon serverless driver throws — exposes `constraint`. Accept BOTH and walk
 * `cause` for wrapped shapes; exported so the unit test can pin the prod
 * shape no container ever produces.
 */
export function isPlaceFkViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
    };
    if (candidate.code === "23503") {
      const constraint =
        typeof candidate.constraint_name === "string"
          ? candidate.constraint_name
          : typeof candidate.constraint === "string"
            ? candidate.constraint
            : null;
      return constraint === BOOKINGS_PLACE_FK;
    }
    current = current.cause;
  }
  return false;
}

/** Rethrow, mapping the race-window place-FK violation onto the canonical 404 (A2). */
function rethrowPlaceFkMapped(error: unknown): never {
  if (isPlaceFkViolation(error)) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);
  throw error;
}

/**
 * §3.3 auto-item `sort_order` placement: "inserted after the last item on
 * that day whose `start_time ≤` the new item's (midpoint value); untimed →
 * appended". Neighbors exclude the booking's OWN items (they may be the ones
 * moving). Midpoint exhaustion (gap 0/1) may collide with the neighbor —
 * ties order arbitrarily until IB-2's day-reorder PUT re-indexes (the
 * documented re-index path, R-ib-15).
 */
async function placementSortOrder(
  tx: Tx,
  tripId: string,
  bookingId: string,
  day: string,
  startTime: string | null,
): Promise<number> {
  const neighbors = await tx
    .select({
      sortOrder: schema.itineraryItems.sortOrder,
      startTime: schema.itineraryItems.startTime,
    })
    .from(schema.itineraryItems)
    .where(
      and(
        eq(schema.itineraryItems.tripId, tripId),
        eq(schema.itineraryItems.day, day),
        or(
          isNull(schema.itineraryItems.bookingId),
          ne(schema.itineraryItems.bookingId, bookingId),
        ),
      ),
    )
    .orderBy(asc(schema.itineraryItems.sortOrder), asc(schema.itineraryItems.id));

  if (neighbors.length === 0) return SORT_GAP;
  const last = neighbors[neighbors.length - 1];
  if (!last) return SORT_GAP; // unreachable; drizzle destructure landmine guard
  if (startTime === null) return last.sortOrder + SORT_GAP;

  let prevIdx = -1;
  neighbors.forEach((row, idx) => {
    const rowTime = wallHHMM(row.startTime);
    if (rowTime !== null && rowTime <= startTime) prevIdx = idx;
  });
  const first = neighbors[0];
  if (prevIdx === -1) return (first ? first.sortOrder : 0) - SORT_GAP;
  if (prevIdx === neighbors.length - 1) return last.sortOrder + SORT_GAP;
  const prev = neighbors[prevIdx];
  const next = neighbors[prevIdx + 1];
  if (!prev || !next) return last.sortOrder + SORT_GAP; // unreachable guard
  return Math.floor((prev.sortOrder + next.sortOrder) / 2);
}

/** The booking's items, ordered `(day, sort_order, id)` — the response order. */
async function itemsOf(reader: Reader, bookingId: string): Promise<ItineraryItemRow[]> {
  return reader
    .select()
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.bookingId, bookingId))
    .orderBy(
      asc(schema.itineraryItems.day),
      asc(schema.itineraryItems.sortOrder),
      asc(schema.itineraryItems.id),
    );
}

/**
 * I-2 resync: make the booking's items EXACTLY the derived placements,
 * preserving item ids where possible (index-matched — travel legs and client
 * caches key on item ids; delete+recreate would churn both). Day/time fields
 * are overwritten from the booking (the booking wins); a same-day update
 * keeps the item's `sort_order`, a day MOVE re-places it by the §3.3
 * midpoint rule. Returns the dirty-day set (old + new days of every touched
 * item).
 */
async function syncItemsToPlacements(
  tx: Tx,
  args: {
    tripId: string;
    bookingId: string;
    userId: string;
    placements: readonly DerivedItemPlacement[];
    existing: readonly ItineraryItemRow[];
  },
): Promise<Set<string>> {
  const { tripId, bookingId, userId, placements, existing } = args;
  const dirty = new Set<string>();

  // Surplus existing items (derivation shrank — e.g. dropoff_at removed).
  for (const item of existing.slice(placements.length)) {
    await tx.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, item.id));
    for (const day of itemDays(item)) dirty.add(day);
  }

  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i];
    if (!placement) continue; // index-bounded; TS narrowing only
    const current = existing[i];

    if (current) {
      const dayChanged = current.day !== placement.day;
      const changed =
        dayChanged ||
        current.endDay !== placement.end_day ||
        wallHHMM(current.startTime) !== placement.start_time ||
        wallHHMM(current.endTime) !== placement.end_time;
      if (!changed) continue;

      const sortOrder = dayChanged
        ? await placementSortOrder(tx, tripId, bookingId, placement.day, placement.start_time)
        : current.sortOrder;
      await tx
        .update(schema.itineraryItems)
        .set({
          day: placement.day,
          endDay: placement.end_day,
          startTime: placement.start_time,
          endTime: placement.end_time,
          sortOrder,
        })
        .where(eq(schema.itineraryItems.id, current.id));
      for (const day of itemDays(current)) dirty.add(day);
      for (const day of itemDays({ day: placement.day, endDay: placement.end_day })) {
        dirty.add(day);
      }
    } else {
      const sortOrder = await placementSortOrder(
        tx,
        tripId,
        bookingId,
        placement.day,
        placement.start_time,
      );
      await tx.insert(schema.itineraryItems).values({
        tripId,
        kind: "booking",
        bookingId,
        day: placement.day,
        endDay: placement.end_day,
        startTime: placement.start_time,
        endTime: placement.end_time,
        sortOrder,
        createdBy: userId,
      });
      for (const day of itemDays({ day: placement.day, endDay: placement.end_day })) {
        dirty.add(day);
      }
    }
  }
  return dirty;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Trip-scoped read: a booking id from another trip is unknown here (IDOR
 * posture — the gate's trip is the only world a route can see). `null` =
 * absent; the route folds it into the indistinguishable 404.
 */
export async function getBookingWithItems(
  db: Reader,
  args: { tripId: string; bookingId: string },
): Promise<{ booking: BookingRow; items: ItineraryItemRow[] } | null> {
  const [booking] = await db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.id, args.bookingId), eq(schema.bookings.tripId, args.tripId)));
  if (!booking) return null;
  return { booking, items: await itemsOf(db, booking.id) };
}

// ---------------------------------------------------------------------------
// Writes (the single write path)
// ---------------------------------------------------------------------------

/**
 * Create (§3.4 POST): instants derived (R-ib-4); auto-item(s) created in the
 * SAME transaction when I-2 applies (`status ∈ {planned, booked}` ∧ primary
 * start known — R-ib-5). `details` defaults to the minimal `{ category }`
 * member; `status` to `'idea'`; `source` to `'manual'`.
 */
export async function createBooking(
  db: DbClient,
  args: { tripId: string; userId: string; input: ServiceBookingCreate },
): Promise<BookingWriteResult> {
  const { tripId, userId, input } = args;
  // `{ category }` alone is a valid member of the union for all 8 categories:
  // every non-discriminant detail field is optional by design (§3.4.1 — an
  // idea may know nothing).
  const details: BookingDetails = input.details ?? { category: input.category };
  const status: BookingStatus = input.status ?? "idea";
  const { startsAt, endsAt } = derivedInstantsOf(details);

  return db.transaction(async (tx) => {
    // B1: a referenced place must exist AND be visible to the caller
    // (Law #3 — `place_id` is a visibility grant; see assertPlaceVisible).
    if (input.place_id !== undefined) {
      await assertPlaceVisible(tx, { placeId: input.place_id, userId });
    }

    const [booking] = await tx
      .insert(schema.bookings)
      .values({
        tripId,
        category: input.category,
        status,
        title: input.title,
        details,
        startsAt,
        endsAt,
        priceCents: input.price_cents ?? null,
        currency: input.currency ?? null,
        confirmationCode: input.confirmation_code ?? null,
        source: input.source ?? "manual",
        placeId: input.place_id ?? null,
        createdBy: userId,
      })
      .returning();
    if (!booking) throw new HttpError("INTERNAL", "booking insert returned no row");

    const dirty = new Set<string>();
    if ((status === "planned" || status === "booked") && startsAt !== null) {
      const placements = derivedPlacementsOf(details);
      const synced = await syncItemsToPlacements(tx, {
        tripId,
        bookingId: booking.id,
        userId,
        placements,
        existing: [],
      });
      for (const day of synced) dirty.add(day);
    }

    return {
      booking,
      items: await itemsOf(tx, booking.id),
      dirtyDays: marksFor(tripId, dirty),
    };
  }).catch(rethrowPlaceFkMapped); // A2: race-window place-FK 23503 → canonical 404
}

/**
 * Partial update (§3.4 PATCH): §3.2 transition legality + its item side
 * effects, R-ib-1 details↔category recheck against the STORED row, I-2
 * resync on time changes, I-3 precedence when times are removed, merged-row
 * R-ib-12. Locks the booking row FOR UPDATE first (lock order above) —
 * concurrent PATCHes serialize; each sees the previous committed state
 * (collab-v1 LWW).
 */
export async function updateBooking(
  db: DbClient,
  args: { tripId: string; bookingId: string; userId: string; input: BookingUpdate },
): Promise<BookingWriteResult> {
  const { tripId, bookingId, userId, input } = args;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.bookings)
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.tripId, tripId)))
      .for("update");
    if (!current) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

    // B1: every non-null `place_id` write runs the visibility gate. NOTE the
    // scope honestly (round-2 A3): on a SAME-VALUE rewrite this booking's own
    // row already references the place in a trip the caller is a proven
    // member of, so the reference rule is satisfied by construction — that is
    // the documented grant rule (an existing reference keeps granting
    // visibility; the revoked-membership walk in routes.db.test.ts pins the
    // rule's real edge), not a replay-revocation check. The gate BITES on
    // place_id CHANGES. Lock order holds: the booking row is already held
    // FOR UPDATE; places/members are plain reads.
    if (input.place_id !== undefined && input.place_id !== null) {
      await assertPlaceVisible(tx, { placeId: input.place_id, userId });
    }

    // R-ib-1: the details discriminant must match the ROW's (immutable)
    // category — the wire schema can only check body-internal consistency.
    if (input.details !== undefined && input.details.category !== current.category) {
      throw new HttpError(
        "VALIDATION_FAILED",
        `details.category '${input.details.category}' must match booking category '${current.category}'`,
        { details: "category mismatch" },
      );
    }

    // §3.2 transition legality (same-status is not a transition — no-op).
    const nextStatus = input.status ?? current.status;
    if (nextStatus !== current.status) {
      if (!BOOKING_STATUS_TRANSITIONS[current.status].includes(nextStatus)) {
        throw new HttpError(
          "VALIDATION_FAILED",
          `illegal status transition '${current.status}' → '${nextStatus}'`,
          { status: "illegal transition" },
        );
      }
    }

    // R-ib-12 on the MERGED row: a non-null price requires a currency.
    const nextPrice = input.price_cents !== undefined ? input.price_cents : current.priceCents;
    const nextCurrency = input.currency !== undefined ? input.currency : current.currency;
    if (nextPrice !== null && nextCurrency === null) {
      throw new HttpError("VALIDATION_FAILED", "price_cents requires a currency", {
        currency: "required with price_cents",
      });
    }

    const detailsTouched = input.details !== undefined;
    const nextDetails = input.details ?? current.details;
    // Derived instants only move when details are written (R-ib-4).
    const { startsAt: nextStartsAt, endsAt: nextEndsAt } = detailsTouched
      ? derivedInstantsOf(nextDetails)
      : { startsAt: current.startsAt, endsAt: current.endsAt };

    const set: Partial<typeof schema.bookings.$inferInsert> = {};
    if (input.title !== undefined) set.title = input.title;
    if (detailsTouched) {
      set.details = nextDetails;
      set.startsAt = nextStartsAt;
      set.endsAt = nextEndsAt;
    }
    if (input.status !== undefined) set.status = input.status;
    if (input.price_cents !== undefined) set.priceCents = input.price_cents;
    if (input.currency !== undefined) set.currency = input.currency;
    if (input.confirmation_code !== undefined) set.confirmationCode = input.confirmation_code;
    if (input.place_id !== undefined) set.placeId = input.place_id;

    const updated =
      Object.keys(set).length > 0
        ? (
            await tx
              .update(schema.bookings)
              .set(set)
              .where(eq(schema.bookings.id, bookingId))
              .returning()
          )[0]
        : current;
    if (!updated) throw new HttpError("INTERNAL", "booking update returned no row");

    // ---- item side effects, same transaction (§3.1/§3.2) -------------------
    const existing = await itemsOf(tx, bookingId);
    const dirty = new Set<string>();

    if (nextStatus === "idea" || nextStatus === "cancelled") {
      // I-1 / I-4: off-calendar states hold zero items. `→ idea` (manual
      // unschedule) and `→ cancelled` delete in the same transaction; the
      // cancelled row itself is retained (R-ib-7 — expense links unchanged).
      for (const item of existing) {
        await tx.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, item.id));
        for (const day of itemDays(item)) dirty.add(day);
      }
    } else {
      const wasOnCalendar = current.status === "planned" || current.status === "booked";
      if (nextStartsAt !== null && (detailsTouched || !wasOnCalendar)) {
        // I-2: exactly the derived items, day/times synced (the booking
        // wins). Also the I-3 → I-2 precedence arm: a timeless-but-scheduled
        // booking gaining real times overwrites the item's day/times HERE.
        const synced = await syncItemsToPlacements(tx, {
          tripId,
          bookingId,
          userId,
          placements: derivedPlacementsOf(nextDetails),
          existing,
        });
        for (const day of synced) dirty.add(day);
      }
      // else: I-3 — starts_at NULL (times removed keep item-owned day/times;
      // nothing vanishes), or booked↔planned with untouched details (items
      // unaffected, §3.2 matrix note). No item writes.
    }

    // Location change: a moved place re-resolves every item's location
    // (R-ib-20 resolves `booking`-kind via the parent's place_id) — the
    // items' days go dirty even though no item row changed.
    if (input.place_id !== undefined && input.place_id !== current.placeId) {
      for (const item of await itemsOf(tx, bookingId)) {
        for (const day of itemDays(item)) dirty.add(day);
      }
    }

    return {
      booking: updated,
      items: await itemsOf(tx, bookingId),
      dirtyDays: marksFor(tripId, dirty),
    };
  }).catch(rethrowPlaceFkMapped); // A2: race-window place-FK 23503 → canonical 404
}

/**
 * Hard delete (§3.4 DELETE): items cascade (DB), expense links SET NULL
 * (schema §3.6 — the ledger outlives the booking). The ordered FOR UPDATE
 * item fence runs BEFORE the delete (cascade-lock-order landmine — see the
 * module doc); it doubles as the dirty-day capture (R-ib-19: legs dirty for
 * affected days). `null` = absent booking (route folds into the 404).
 */
export async function deleteBooking(
  db: DbClient,
  args: { tripId: string; bookingId: string },
): Promise<{ dirtyDays: DirtyDayMark[] } | null> {
  const { tripId, bookingId } = args;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.tripId, tripId)))
      .for("update");
    if (!current) return null;

    // Fence: every item row FOR UPDATE in id order before the cascade fires.
    const fencedItems = await tx
      .select({
        day: schema.itineraryItems.day,
        endDay: schema.itineraryItems.endDay,
      })
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.bookingId, bookingId))
      .orderBy(asc(schema.itineraryItems.id))
      .for("update");

    const dirty = new Set<string>();
    for (const item of fencedItems) {
      for (const day of itemDays(item)) dirty.add(day);
    }

    await tx.delete(schema.bookings).where(eq(schema.bookings.id, bookingId));
    return { dirtyDays: marksFor(tripId, dirty) };
  });
}

/**
 * Schedule a TIMELESS booking onto a day (§3.4 POST …/schedule, R-ib-8):
 * creates its `booking`-kind item with the given day/times and advances
 * `idea → planned`. Known times → VALIDATION_FAILED (its calendar presence
 * is automatic, R-ib-5); already scheduled → CONFLICT; `cancelled` →
 * VALIDATION_FAILED (terminal — I-4 pins zero items; the §3.4 error table
 * has no cancelled row, folded into the 400 arm and flagged in the PR).
 */
export async function scheduleBooking(
  db: DbClient,
  args: { tripId: string; bookingId: string; userId: string; input: ScheduleBookingInput },
): Promise<BookingWriteResult> {
  const { tripId, bookingId, userId, input } = args;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.bookings)
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.tripId, tripId)))
      .for("update");
    if (!current) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

    if (current.status === "cancelled") {
      throw new HttpError("VALIDATION_FAILED", "a cancelled booking cannot be scheduled", {
        status: "cancelled is terminal",
      });
    }
    if (current.startsAt !== null) {
      throw new HttpError(
        "VALIDATION_FAILED",
        "booking has known times — its calendar presence is automatic",
        { starts_at: "known" },
      );
    }
    const existing = await itemsOf(tx, bookingId);
    if (existing.length > 0) {
      throw new HttpError("CONFLICT", "booking is already scheduled", {
        reason: "already_scheduled",
      });
    }

    // Position: after `after_item_id` (validated trip-scoped + on-day — a
    // foreign or off-day anchor is a bad body), default append.
    let sortOrder: number;
    if (input.after_item_id !== undefined) {
      const [anchor] = await tx
        .select({
          id: schema.itineraryItems.id,
          day: schema.itineraryItems.day,
          sortOrder: schema.itineraryItems.sortOrder,
        })
        .from(schema.itineraryItems)
        .where(
          and(
            eq(schema.itineraryItems.id, input.after_item_id),
            eq(schema.itineraryItems.tripId, tripId),
          ),
        );
      if (!anchor || anchor.day !== input.day) {
        throw new HttpError(
          "VALIDATION_FAILED",
          "after_item_id must reference an item on the target day",
          { after_item_id: "unknown or off-day" },
        );
      }
      // Successor = the smallest sort value strictly after the anchor's;
      // midpoint between them (ties at the midpoint order arbitrarily until
      // IB-2's re-index PUT — same posture as placementSortOrder).
      const dayOrder = await tx
        .select({ sortOrder: schema.itineraryItems.sortOrder })
        .from(schema.itineraryItems)
        .where(
          and(
            eq(schema.itineraryItems.tripId, tripId),
            eq(schema.itineraryItems.day, input.day),
          ),
        )
        .orderBy(asc(schema.itineraryItems.sortOrder), asc(schema.itineraryItems.id));
      const next = dayOrder
        .map((row) => row.sortOrder)
        .find((value) => value > anchor.sortOrder);
      sortOrder =
        next !== undefined
          ? Math.floor((anchor.sortOrder + next) / 2)
          : anchor.sortOrder + SORT_GAP;
    } else {
      const dayItems = await tx
        .select({ sortOrder: schema.itineraryItems.sortOrder })
        .from(schema.itineraryItems)
        .where(
          and(
            eq(schema.itineraryItems.tripId, tripId),
            eq(schema.itineraryItems.day, input.day),
          ),
        )
        .orderBy(asc(schema.itineraryItems.sortOrder), asc(schema.itineraryItems.id));
      const last = dayItems[dayItems.length - 1];
      sortOrder = last ? last.sortOrder + SORT_GAP : SORT_GAP;
    }

    await tx.insert(schema.itineraryItems).values({
      tripId,
      kind: "booking",
      bookingId,
      day: input.day,
      startTime: input.start_time ?? null,
      endTime: input.end_time ?? null,
      sortOrder,
      createdBy: userId,
    });

    // R-ib-8: advance `idea → planned` (the schedule arm of the §3.2
    // matrix); `planned`/`booked` timeless bookings keep their status.
    let booking = current;
    if (current.status === "idea") {
      const [advanced] = await tx
        .update(schema.bookings)
        .set({ status: "planned" })
        .where(eq(schema.bookings.id, bookingId))
        .returning();
      if (!advanced) throw new HttpError("INTERNAL", "booking status update returned no row");
      booking = advanced;
    }

    return {
      booking,
      items: await itemsOf(tx, bookingId),
      dirtyDays: marksFor(tripId, [input.day]),
    };
  });
}
