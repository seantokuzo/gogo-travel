/**
 * Itinerary item domain service (T-7.2 / IB-2) — the write path for DIRECT
 * item mutations (`place_visit`/`custom` CRUD, day reorder) and the R-ib-9
 * unschedule arm of `booking`-kind item deletion. Booking-DERIVED item state
 * stays the booking service's (§3.1 single-write-path rule): nothing here
 * writes a booking's details/instants, and `booking`-kind items' protected
 * fields (R-ib-16) are rejected toward `PATCH …/bookings/:id`.
 *
 * LOCK ORDER (global, extended at T-7.1 — never reorder): users →
 * trip_members → invites → bookings → itinerary_items. Every mutation that
 * touches a `booking`-kind item takes the parent booking `FOR UPDATE` FIRST
 * (R-ib-9 writes the booking row too; R-ib-16 reads its `starts_at` as the
 * protection predicate), then the item row(s). Multi-row lockers (reorder,
 * multi-item unschedule) order by id — concurrent transactions acquire in
 * the same sequence, so they serialize instead of deadlocking (the day-order
 * PUT's "no partial interleave" guarantee, R-ib-15/R-ib-18 LWW).
 *
 * `travel_legs` cascade off `itinerary_items` with NO fence here — the
 * T-7.1 module-doc posture: the leg job (their single writer, T-7.3) must
 * tolerate item deletion racing a recompute.
 *
 * DIRTY DAYS (I-5/R-ib-19): every mutation returns `dirtyDays`; the CALLER
 * fires the seam POST-COMMIT (dirty-days.ts contract — an aborted
 * transaction must never mark). Marks cover every day whose located ordered
 * sequence MAY have changed: old + new chain days of moved items (spanning
 * items sit in both days' chains, §3.6), plus time/place changes (§3.5 step
 * 4 diffs on endpoint locations AND times).
 *
 * DRIVER: every multi-row write runs in `db.transaction` — prod is the Neon
 * WebSocket `Pool`, never Neon-HTTP (its `.transaction()` throws).
 */
import type {
  DayOrderInput,
  ItineraryItemCreate,
  ItineraryItemUpdate,
} from "@gogo/shared/domains/itinerary";
import { violatesSingleDayTimeOrder } from "@gogo/shared/domains/itinerary";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { HttpError, NOT_FOUND_MESSAGE } from "../http/errors.js";
import { resolvePlaceAccess } from "../places/visibility.js";
import type { DirtyDayMark } from "../bookings/dirty-days.js";
import type { ItineraryItemRow } from "../bookings/serialize.js";
import type { TravelLegRow } from "./serialize.js";

/** Gap unit for `sort_order` (schema §3.3.10 — app assigns 1024 steps). */
const SORT_GAP = 1024;

/** Any transaction scope (or the client itself) usable for reads. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Reader = DbClient | Tx;

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
 * Law #3 / R-places-8 write-side gate for `itinerary_items.place_id` — the
 * shared predicate (`places/visibility.ts`), consumed exactly as the booking
 * service does (`assertPlaceVisible` there is the precedent): everything
 * except visible folds into the canonical 404 (invisible ≡ absent), which
 * also closes the 201-vs-500 existence oracle of the unmapped FK 23503.
 * Runs inside the write transaction; READ COMMITTED gives no snapshot
 * guarantee, so `isItemPlaceFkViolation` below maps the race residue onto
 * the SAME 404.
 */
async function assertPlaceVisible(
  tx: Tx,
  args: { placeId: string; userId: string },
): Promise<void> {
  const access = await resolvePlaceAccess(tx, args);
  if (access.kind === "not_found") throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);
}

/** The Drizzle-generated FK constraint guarding `itinerary_items.place_id`. */
export const ITINERARY_ITEMS_PLACE_FK = "itinerary_items_place_id_places_id_fk";

/**
 * Is this the item place-FK 23503? Constraint-precise on purpose (the other
 * FKs on this write path — trip, creator, booking — are gate-/lock-proven
 * and should stay loud). 🔴 Driver trap (the `isPlaceFkViolation` precedent,
 * bookings/service.ts): postgres-js — the TEST driver — exposes the wire
 * field as `constraint_name`; pg-protocol's `DatabaseError` — what the PROD
 * Neon serverless driver throws — exposes `constraint`. Accept BOTH and walk
 * `cause`; exported so a unit test can pin the prod shape no container ever
 * produces.
 */
export function isItemPlaceFkViolation(error: unknown): boolean {
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
      return constraint === ITINERARY_ITEMS_PLACE_FK;
    }
    current = current.cause;
  }
  return false;
}

/** Rethrow, mapping the race-window place-FK violation onto the canonical 404. */
function rethrowPlaceFkMapped(error: unknown): never {
  if (isItemPlaceFkViolation(error)) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);
  throw error;
}

// ---------------------------------------------------------------------------
// Composite read (§3.4 GET /trips/:tripId/itinerary, R-ib-13)
// ---------------------------------------------------------------------------

export interface ItineraryReadResult {
  items: ItineraryItemRow[];
  legs: TravelLegRow[];
}

/**
 * One-shot calendar read: the range's items ordered `(day, sort_order, id)`
 * plus the legs whose endpoints are BOTH in range. Plain reads, one query
 * per table shape (items · legs · plus the trip row and one min/max
 * aggregate when a default bound is needed) — never per-row.
 *
 * Range default (§3.4): each absent bound falls back to the trip's dates
 * unioned with the min→max of existing item days (covers pre/post-trip
 * items; the item-days arm doubles as the date-less-trip robustness
 * fallback). An item is "in range" when its `[day, end_day ?? day]` span
 * intersects `[from, to]` — a spanning item participates in every day of
 * its span (§3.6).
 */
export async function readItinerary(
  db: Reader,
  args: { tripId: string; from?: string | undefined; to?: string | undefined },
): Promise<ItineraryReadResult> {
  const { tripId } = args;
  let from = args.from ?? null;
  let to = args.to ?? null;

  if (from === null || to === null) {
    // Independent single-row reads — in parallel (`deps.db` is a pool; inside
    // a transaction scope postgres-js queues on the one connection, still
    // correct, just sequential).
    const [tripRows, spanRows] = await Promise.all([
      db
        .select({ startDate: schema.trips.startDate, endDate: schema.trips.endDate })
        .from(schema.trips)
        .where(eq(schema.trips.id, tripId)),
      db
        .select({
          minDay: sql<string | null>`min(${schema.itineraryItems.day})`,
          maxDay: sql<
            string | null
          >`max(coalesce(${schema.itineraryItems.endDay}, ${schema.itineraryItems.day}))`,
        })
        .from(schema.itineraryItems)
        .where(eq(schema.itineraryItems.tripId, tripId)),
    ]);
    const trip = tripRows[0];
    const span = spanRows[0];

    const froms = [trip?.startDate, span?.minDay].filter((d): d is string => d != null);
    const tos = [trip?.endDate, span?.maxDay].filter((d): d is string => d != null);
    if (from === null && froms.length > 0) from = froms.reduce((a, b) => (b < a ? b : a));
    if (to === null && tos.length > 0) to = tos.reduce((a, b) => (b > a ? b : a));
  }
  // Unresolvable bound (no trip dates AND no items — the date-less fallback's
  // empty arm): an empty calendar, not an error.
  if (from === null || to === null) return { items: [], legs: [] };

  // Items + legs are independent reads over the resolved range — in parallel
  // (same pool/tx note as above). Legs: both endpoints' spans in range
  // (R-ib-13). One query — the legs table joined to the items table twice;
  // ordered along the from-item's chain position for a deterministic wire
  // order.
  const fromItem = alias(schema.itineraryItems, "leg_from_item");
  const toItem = alias(schema.itineraryItems, "leg_to_item");
  const [items, legRows] = await Promise.all([
    db
      .select()
      .from(schema.itineraryItems)
      .where(
        and(
          eq(schema.itineraryItems.tripId, tripId),
          lte(schema.itineraryItems.day, to),
          gte(sql`coalesce(${schema.itineraryItems.endDay}, ${schema.itineraryItems.day})`, from),
        ),
      )
      .orderBy(
        asc(schema.itineraryItems.day),
        asc(schema.itineraryItems.sortOrder),
        asc(schema.itineraryItems.id),
      ),
    db
      .select({ leg: schema.travelLegs })
      .from(schema.travelLegs)
      .innerJoin(fromItem, eq(schema.travelLegs.fromItemId, fromItem.id))
      .innerJoin(toItem, eq(schema.travelLegs.toItemId, toItem.id))
      .where(
        and(
          eq(schema.travelLegs.tripId, tripId),
          lte(fromItem.day, to),
          gte(sql`coalesce(${fromItem.endDay}, ${fromItem.day})`, from),
          lte(toItem.day, to),
          gte(sql`coalesce(${toItem.endDay}, ${toItem.day})`, from),
        ),
      )
      .orderBy(asc(fromItem.day), asc(fromItem.sortOrder), asc(schema.travelLegs.id)),
  ]);

  return { items, legs: legRows.map((row) => row.leg) };
}

// ---------------------------------------------------------------------------
// Direct item writes (§3.4 POST/PATCH/DELETE items, PUT day order)
// ---------------------------------------------------------------------------

export interface ItemWriteResult {
  item: ItineraryItemRow;
  /** Days whose located sequence may have changed (I-5) — POST-COMMIT marks. */
  dirtyDays: DirtyDayMark[];
}

/**
 * R-ib-15 position resolution for a new row: after `after_item_id`
 * (validated trip-scoped + on-day — a foreign or off-day anchor is a bad
 * body; the scheduleBooking precedent), default append with a +1024 gap.
 * Midpoint exhaustion may tie with a neighbor — ties order arbitrarily
 * until the day-order PUT re-indexes (the documented re-index path).
 */
async function resolveCreateSortOrder(
  tx: Tx,
  args: { tripId: string; day: string; afterItemId?: string | undefined },
): Promise<number> {
  const { tripId, day, afterItemId } = args;
  const dayOrder = await tx
    .select({ id: schema.itineraryItems.id, sortOrder: schema.itineraryItems.sortOrder })
    .from(schema.itineraryItems)
    .where(and(eq(schema.itineraryItems.tripId, tripId), eq(schema.itineraryItems.day, day)))
    .orderBy(asc(schema.itineraryItems.sortOrder), asc(schema.itineraryItems.id));

  if (afterItemId === undefined) {
    const last = dayOrder[dayOrder.length - 1];
    return last ? last.sortOrder + SORT_GAP : SORT_GAP;
  }

  const anchor = dayOrder.find((row) => row.id === afterItemId);
  if (!anchor) {
    throw new HttpError(
      "VALIDATION_FAILED",
      "after_item_id must reference an item on the target day",
      { after_item_id: "unknown or off-day" },
    );
  }
  const next = dayOrder.map((row) => row.sortOrder).find((value) => value > anchor.sortOrder);
  return next !== undefined
    ? Math.floor((anchor.sortOrder + next) / 2)
    : anchor.sortOrder + SORT_GAP;
}

/**
 * Create a `place_visit`/`custom` item (§3.4 POST, R-ib-14/15/17). Kind and
 * structural rules are wire-schema-enforced; this owns placement, the place
 * visibility gate, and the insert.
 */
export async function createItem(
  db: DbClient,
  args: { tripId: string; userId: string; input: ItineraryItemCreate },
): Promise<ItemWriteResult> {
  const { tripId, userId, input } = args;

  return db
    .transaction(async (tx) => {
      if (input.place_id !== undefined) {
        await assertPlaceVisible(tx, { placeId: input.place_id, userId });
      }

      const sortOrder = await resolveCreateSortOrder(tx, {
        tripId,
        day: input.day,
        afterItemId: input.after_item_id,
      });

      const [item] = await tx
        .insert(schema.itineraryItems)
        .values({
          tripId,
          kind: input.kind,
          placeId: input.place_id ?? null,
          title: input.title ?? null,
          notes: input.notes ?? null,
          day: input.day,
          endDay: input.end_day ?? null,
          startTime: input.start_time ?? null,
          endTime: input.end_time ?? null,
          sortOrder,
          createdBy: userId,
        })
        .returning();
      if (!item) throw new HttpError("INTERNAL", "item insert returned no row");

      return { item, dirtyDays: marksFor(tripId, itemDays(item)) };
    })
    .catch(rethrowPlaceFkMapped);
}

/**
 * Partial item update (§3.4 PATCH, R-ib-16/17/18). Field legality against
 * the stored row: `title` custom-only, `place_id` place_visit-only;
 * `day`/`end_day`/`start_time`/`end_time` on `booking`-kind only while the
 * parent's `starts_at` IS NULL (`end_day` rides the protected set — it is
 * booking-derived exactly like `day`); `notes`/`sort_order` always
 * editable. Merged-row structural checks run only when a placement/time
 * field is being written (a notes-only edit must never trip over
 * derivation-quirk times the pure helper legally emitted).
 */
export async function updateItem(
  db: DbClient,
  args: { tripId: string; itemId: string; userId: string; input: ItineraryItemUpdate },
): Promise<ItemWriteResult> {
  const { tripId, itemId, userId, input } = args;

  return db
    .transaction(async (tx) => {
      // Plain probe first: `kind`/`booking_id` are immutable, so this is a
      // race-safe way to learn whether a parent booking must be locked FIRST
      // (lock order: bookings → itinerary_items).
      const [probe] = await tx
        .select({ kind: schema.itineraryItems.kind, bookingId: schema.itineraryItems.bookingId })
        .from(schema.itineraryItems)
        .where(
          and(eq(schema.itineraryItems.id, itemId), eq(schema.itineraryItems.tripId, tripId)),
        );
      if (!probe) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

      let parentStartsAt: Date | null = null;
      if (probe.kind === "booking" && probe.bookingId !== null) {
        const [parent] = await tx
          .select({ startsAt: schema.bookings.startsAt })
          .from(schema.bookings)
          .where(
            and(eq(schema.bookings.id, probe.bookingId), eq(schema.bookings.tripId, tripId)),
          )
          .for("update");
        // Parent deleted in the probe→lock window ⇒ the item cascaded too.
        if (!parent) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);
        parentStartsAt = parent.startsAt;
      }

      const [current] = await tx
        .select()
        .from(schema.itineraryItems)
        .where(
          and(eq(schema.itineraryItems.id, itemId), eq(schema.itineraryItems.tripId, tripId)),
        )
        .for("update");
      if (!current) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

      // ---- field legality against the stored row (§3.4 PATCH) --------------
      if (input.title !== undefined && current.kind !== "custom") {
        throw new HttpError("VALIDATION_FAILED", "title is only editable on 'custom' items", {
          title: "kind mismatch",
        });
      }
      if (input.place_id !== undefined && current.kind !== "place_visit") {
        throw new HttpError(
          "VALIDATION_FAILED",
          "place_id is only editable on 'place_visit' items",
          { place_id: "kind mismatch" },
        );
      }

      const touchesPlacement =
        input.day !== undefined ||
        input.end_day !== undefined ||
        input.start_time !== undefined ||
        input.end_time !== undefined;

      // R-ib-16: a `booking`-kind item's day/times are booking-derived while
      // the parent has known times — direct them to the booking (R-ib-5).
      if (current.kind === "booking" && touchesPlacement && parentStartsAt !== null) {
        throw new HttpError(
          "VALIDATION_FAILED",
          "this item's day and times are derived from its booking — edit the booking instead",
          { day: "booking-derived" },
        );
      }

      if (input.place_id !== undefined) {
        await assertPlaceVisible(tx, { placeId: input.place_id, userId });
      }

      // ---- merged-row structural checks (R-ib-17), placement writes only ---
      const nextDay = input.day ?? current.day;
      const nextEndDay = input.end_day !== undefined ? input.end_day : current.endDay;
      const nextStart =
        input.start_time !== undefined ? input.start_time : wallHHMM(current.startTime);
      const nextEnd = input.end_time !== undefined ? input.end_time : wallHHMM(current.endTime);
      if (touchesPlacement) {
        if (nextEndDay !== null && nextEndDay < nextDay) {
          throw new HttpError("VALIDATION_FAILED", "end_day must be on or after day", {
            end_day: "before day",
          });
        }
        if (
          violatesSingleDayTimeOrder({
            day: nextDay,
            end_day: nextEndDay,
            start_time: nextStart,
            end_time: nextEnd,
          })
        ) {
          throw new HttpError(
            "VALIDATION_FAILED",
            "end_time must be on or after start_time on a single-day item",
            { end_time: "before start_time" },
          );
        }
      }

      const set: Partial<typeof schema.itineraryItems.$inferInsert> = {};
      if (input.title !== undefined) set.title = input.title;
      if (input.notes !== undefined) set.notes = input.notes;
      if (input.place_id !== undefined) set.placeId = input.place_id;
      if (input.day !== undefined) set.day = input.day;
      if (input.end_day !== undefined) set.endDay = input.end_day;
      if (input.start_time !== undefined) set.startTime = input.start_time;
      if (input.end_time !== undefined) set.endTime = input.end_time;
      if (input.sort_order !== undefined) set.sortOrder = input.sort_order;

      const updated =
        Object.keys(set).length > 0
          ? (
              await tx
                .update(schema.itineraryItems)
                .set(set)
                .where(eq(schema.itineraryItems.id, itemId))
                .returning()
            )[0]
          : current;
      if (!updated) throw new HttpError("INTERNAL", "item update returned no row");

      // ---- dirty days (I-5) ------------------------------------------------
      // Placement/times/order/place changes can change a day's located
      // ordered sequence (or a pair's diffing inputs, §3.5 step 4); a
      // title/notes-only edit cannot.
      const dirty = new Set<string>();
      const placeChanged = input.place_id !== undefined && input.place_id !== current.placeId;
      const orderChanged =
        input.sort_order !== undefined && input.sort_order !== current.sortOrder;
      const timesChanged =
        nextStart !== wallHHMM(current.startTime) || nextEnd !== wallHHMM(current.endTime);
      const daysChanged = nextDay !== current.day || nextEndDay !== current.endDay;
      if (placeChanged || orderChanged || timesChanged || daysChanged) {
        for (const day of itemDays(current)) dirty.add(day);
        for (const day of itemDays(updated)) dirty.add(day);
      }

      return { item: updated, dirtyDays: marksFor(tripId, dirty) };
    })
    .catch(rethrowPlaceFkMapped);
}

/**
 * Delete an item (§3.4 DELETE). `place_visit`/`custom`: plain delete.
 * `booking`-kind is the R-ib-9 unschedule: parent `booked` → CONFLICT (a
 * purchased booking never silently leaves the calendar); parent `planned` →
 * revert to `idea` in the same transaction — and since `idea` pins zero
 * items (I-1/R-ib-6), ALL the booking's items go, not just the targeted one
 * (a car rental's pickup+dropoff leave the calendar together). Multi-row
 * deletes fence the rows with an ordered `FOR UPDATE` SELECT first (the
 * T-6.2 cascade-lock-order landmine; bookings-service precedent).
 * `null` = absent item (route folds into the indistinguishable 404).
 */
export async function deleteItem(
  db: DbClient,
  args: { tripId: string; itemId: string },
): Promise<{ dirtyDays: DirtyDayMark[] } | null> {
  const { tripId, itemId } = args;

  return db.transaction(async (tx) => {
    const [probe] = await tx
      .select({ kind: schema.itineraryItems.kind, bookingId: schema.itineraryItems.bookingId })
      .from(schema.itineraryItems)
      .where(and(eq(schema.itineraryItems.id, itemId), eq(schema.itineraryItems.tripId, tripId)));
    if (!probe) return null;

    const dirty = new Set<string>();

    if (probe.kind === "booking" && probe.bookingId !== null) {
      // Lock order: parent booking FIRST (this path writes it too, R-ib-9).
      const [parent] = await tx
        .select({ id: schema.bookings.id, status: schema.bookings.status })
        .from(schema.bookings)
        .where(and(eq(schema.bookings.id, probe.bookingId), eq(schema.bookings.tripId, tripId)))
        .for("update");
      if (!parent) return null; // parent deleted in the window ⇒ item cascaded

      if (parent.status === "booked") {
        throw new HttpError(
          "CONFLICT",
          "a booked booking's calendar item cannot be deleted — cancel or demote the booking instead",
          { reason: "booked_parent" },
        );
      }

      // Ordered FOR UPDATE fence over ALL the booking's items (they leave
      // together — I-1), then delete them.
      const fenced = await tx
        .select({
          id: schema.itineraryItems.id,
          day: schema.itineraryItems.day,
          endDay: schema.itineraryItems.endDay,
        })
        .from(schema.itineraryItems)
        .where(eq(schema.itineraryItems.bookingId, parent.id))
        .orderBy(asc(schema.itineraryItems.id))
        .for("update");
      // The targeted item vanished between probe and fence ⇒ treat as absent
      // (LWW posture) — nothing is deleted on a stale target.
      if (!fenced.some((row) => row.id === itemId)) return null;

      for (const row of fenced) {
        for (const day of itemDays(row)) dirty.add(day);
      }
      await tx.delete(schema.itineraryItems).where(eq(schema.itineraryItems.bookingId, parent.id));

      // R-ib-9: planned → idea rides the same transaction. (Any other
      // status here means the invariant already drifted; the delete above
      // restored I-1/I-3's zero-item arm and the status is left alone.)
      if (parent.status === "planned") {
        await tx
          .update(schema.bookings)
          .set({ status: "idea" })
          .where(eq(schema.bookings.id, parent.id));
      }

      return { dirtyDays: marksFor(tripId, dirty) };
    }

    const [locked] = await tx
      .select({ day: schema.itineraryItems.day, endDay: schema.itineraryItems.endDay })
      .from(schema.itineraryItems)
      .where(and(eq(schema.itineraryItems.id, itemId), eq(schema.itineraryItems.tripId, tripId)))
      .for("update");
    if (!locked) return null;
    for (const day of itemDays(locked)) dirty.add(day);

    await tx.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, itemId));
    return { dirtyDays: marksFor(tripId, dirty) };
  });
}

export interface DayOrderResultRows {
  /** The day's resulting ordered items (R-ib-18 post-state). */
  items: ItineraryItemRow[];
  dirtyDays: DirtyDayMark[];
}

/**
 * Atomic day reorder (§3.4 PUT, R-ib-15/16/18): reassign the listed items to
 * `day` with `sort_order = 1024 × position` (1-based over the SURVIVING
 * list — ignored ids are as if never listed). Cross-day pulls are one call;
 * `booking`-kind items with booking-derived days (parent `starts_at` known)
 * are rejected for CROSS-day pulls only (same-day reordering touches
 * `sort_order` alone — always editable, R-ib-16). Items on the day but not
 * listed are left untouched (LWW: a concurrent creator's row must never be
 * destroyed; its relative position resolves at the next reorder).
 *
 * Concurrency: parents then items are locked `FOR UPDATE` in id order —
 * concurrent PUTs serialize; the last commit's full order wins with no
 * partial interleave.
 */
export async function reorderDay(
  db: DbClient,
  args: { tripId: string; day: string; input: DayOrderInput },
): Promise<DayOrderResultRows> {
  const { tripId, day, input } = args;

  return db.transaction(async (tx) => {
    const ids = input.item_ids;

    // Plain probe (immutable columns only): which rows exist, whose trips
    // they belong to, which parents must be locked first.
    const probes =
      ids.length > 0
        ? await tx
            .select({
              id: schema.itineraryItems.id,
              tripId: schema.itineraryItems.tripId,
              kind: schema.itineraryItems.kind,
              bookingId: schema.itineraryItems.bookingId,
            })
            .from(schema.itineraryItems)
            .where(inArray(schema.itineraryItems.id, ids))
        : [];

    // R-ib-15: an id from another trip is a hard 400 (the spec's explicit
    // carve-out from the ignore rule). Message stays generic — no id echo.
    if (probes.some((row) => row.tripId !== tripId)) {
      throw new HttpError("VALIDATION_FAILED", "item_ids must belong to the trip", {
        item_ids: "foreign trip",
      });
    }

    // Lock order: parent bookings (id-ordered) → item rows (id-ordered).
    const parentIds = [
      ...new Set(
        probes
          .filter((row) => row.kind === "booking" && row.bookingId !== null)
          .map((row) => row.bookingId as string),
      ),
    ].sort();
    const parents =
      parentIds.length > 0
        ? await tx
            .select({ id: schema.bookings.id, startsAt: schema.bookings.startsAt })
            .from(schema.bookings)
            .where(
              and(inArray(schema.bookings.id, parentIds), eq(schema.bookings.tripId, tripId)),
            )
            .orderBy(asc(schema.bookings.id))
            .for("update")
        : [];
    const parentById = new Map(parents.map((row) => [row.id, row]));

    const locked =
      ids.length > 0
        ? await tx
            .select()
            .from(schema.itineraryItems)
            .where(
              and(
                inArray(schema.itineraryItems.id, ids),
                eq(schema.itineraryItems.tripId, tripId),
              ),
            )
            .orderBy(asc(schema.itineraryItems.id))
            .for("update")
        : [];
    const lockedById = new Map(locked.map((row) => [row.id, row]));

    // LWW (R-ib-15): ids that no longer exist are ignored; survivors keep
    // the submitted relative order.
    const survivors = ids.flatMap((id) => {
      const row = lockedById.get(id);
      return row ? [row] : [];
    });

    const dirty = new Set<string>();
    for (const [position, row] of survivors.entries()) {
      const crossDay = row.day !== day;
      if (crossDay && row.kind === "booking") {
        // R-ib-16: booking-derived days move via the booking, never a drag.
        const parent = row.bookingId !== null ? parentById.get(row.bookingId) : undefined;
        if (parent === undefined || parent.startsAt !== null) {
          throw new HttpError(
            "VALIDATION_FAILED",
            "a booking-derived item cannot be pulled across days — edit the booking instead",
            { item_ids: "booking-derived day" },
          );
        }
      }
      if (crossDay && row.endDay !== null && row.endDay < day) {
        // A pulled spanning item keeps its end_day; an inverted span is
        // structurally invalid (R-ib-17 / items end_day CHECK).
        throw new HttpError("VALIDATION_FAILED", "end_day must be on or after day", {
          item_ids: "span would invert",
        });
      }
      if (
        crossDay &&
        violatesSingleDayTimeOrder({
          day,
          end_day: row.endDay,
          start_time: wallHHMM(row.startTime),
          end_time: wallHHMM(row.endTime),
        })
      ) {
        // R-ib-17's TIME arm on the pulled row: dragging a spanning item to
        // exactly its own end_day collapses it single-day while keeping the
        // stored times — an inverted pair must 400 here exactly as the same
        // transition does via `PATCH {day}` (the two write paths agree; there
        // is no DB CHECK backstop for the time rule).
        throw new HttpError(
          "VALIDATION_FAILED",
          "end_time must be on or after start_time on a single-day item",
          { item_ids: "single-day time order would invert" },
        );
      }

      const sortOrder = SORT_GAP * (position + 1);
      if (crossDay || row.sortOrder !== sortOrder) {
        await tx
          .update(schema.itineraryItems)
          .set({ day, sortOrder })
          .where(eq(schema.itineraryItems.id, row.id));
        dirty.add(day);
        for (const d of itemDays(row)) dirty.add(d);
        if (row.endDay !== null) for (const d of itemDays({ day, endDay: row.endDay })) dirty.add(d);
      }
    }

    const items = await tx
      .select()
      .from(schema.itineraryItems)
      .where(and(eq(schema.itineraryItems.tripId, tripId), eq(schema.itineraryItems.day, day)))
      .orderBy(asc(schema.itineraryItems.sortOrder), asc(schema.itineraryItems.id));

    return { items, dirtyDays: marksFor(tripId, dirty) };
  });
}
