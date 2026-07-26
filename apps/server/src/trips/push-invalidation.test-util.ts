/**
 * Shared recording harness for T-6.3 push-invalidation assertions (same
 * pattern as `http/idor-404.test-util.ts` — test-only, imported by the
 * trips/members/invites DB suites; excluded from prod code paths).
 *
 * Wires a real `createTripEventEmitter` over the suite's db with a transport
 * that records every delivery. Suites seed unique trips per test, so
 * `eventsFor(tripId)` isolates assertions without cross-test draining;
 * `settle()` awaits the emitter's serial chain first so "no emission"
 * assertions are deterministic, never a did-not-arrive-yet race.
 */
import type { DbClient } from "../db/create-user.js";
import {
  createTripEventEmitter,
  type PushInvalidationDelivery,
  type WiredTripEventEmitter,
} from "./push-invalidation.js";

export interface RecordingTripEvents {
  tripEvents: WiredTripEventEmitter;
  /** Every delivery since boot, in emission order. */
  deliveries: PushInvalidationDelivery[];
  /** Await the emitter chain, then return this trip's deliveries. */
  eventsFor(tripId: string): Promise<PushInvalidationDelivery[]>;
  /** Sorted recipient user ids of one delivery (fan-out assertions). */
  recipientIdsOf(delivery: PushInvalidationDelivery): string[];
}

export function createRecordingTripEvents(db: DbClient): RecordingTripEvents {
  const deliveries: PushInvalidationDelivery[] = [];
  const tripEvents = createTripEventEmitter({
    db,
    transport: {
      deliver(delivery) {
        deliveries.push(delivery);
      },
    },
    logger: { warn: () => undefined },
  });

  return {
    tripEvents,
    deliveries,
    async eventsFor(tripId) {
      await tripEvents.idle();
      return deliveries.filter((delivery) => delivery.payload.trip_id === tripId);
    },
    recipientIdsOf(delivery) {
      return delivery.recipients.map((recipient) => recipient.userId);
    },
  };
}
