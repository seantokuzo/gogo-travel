/**
 * Trip/invite fixtures + the descriptor-routed network mock for T-6.6's
 * navigation surfaces (entry redirect, [tripId] guard, deep links). Same
 * `METHOD path` routing convention as profile-screen's mockApi. Lives
 * outside `__tests__/` so jest never treats it as a suite.
 *
 * Statuses are date-relative to the DEVICE-tz today (what §2.5 evaluates),
 * with the effective `status` field kept coherent with the dates — the
 * server derives it the same way (R-db-19).
 */
import type { InvitePreview, ISODate, Paginated, Place, TripListItem } from "@gogo/shared";

import { apiClient, ApiRequestError } from "@/auth";
import { localTodayISO } from "@/navigation/trip-defaults";

import { TEST_TRIP_ID } from "./ids";
import { TEST_USER } from "./session-fixtures";

/** Day arithmetic on ISO dates (UTC math — no tz drift for day offsets). */
export function addDays(iso: ISODate, days: number): ISODate {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const yy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Base trip — planning (starts in 30 days) unless overridden. */
export function makeTrip(overrides: Partial<TripListItem> & { id: string }): TripListItem {
  const today = localTodayISO();
  return {
    name: "Kyoto",
    destination_name: "Kyoto, Japan",
    destination_lat: 35.0116,
    destination_lng: 135.7681,
    start_date: addDays(today, 30),
    end_date: addDays(today, 37),
    status: "planning",
    status_override: null,
    base_currency: "USD",
    budget_cap_cents: null,
    theme: null,
    created_by: TEST_USER.id,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    role: "owner",
    member_count: 1,
    ...overrides,
  };
}

/** Active: effective status active AND today inside the window (§2.5). */
export function makeActiveTrip(id: string, overrides?: Partial<TripListItem>): TripListItem {
  const today = localTodayISO();
  return makeTrip({
    id,
    name: "Lisbon",
    destination_name: "Lisbon, Portugal",
    start_date: addDays(today, -1),
    end_date: addDays(today, 3),
    status: "active",
    ...overrides,
  });
}

export function makePlanningTrip(id: string, overrides?: Partial<TripListItem>): TripListItem {
  return makeTrip({ id, ...overrides });
}

export function makePastTrip(id: string, overrides?: Partial<TripListItem>): TripListItem {
  const today = localTodayISO();
  return makeTrip({
    id,
    name: "Oaxaca",
    destination_name: "Oaxaca, Mexico",
    start_date: addDays(today, -20),
    end_date: addDays(today, -14),
    status: "past",
    ...overrides,
  });
}

/** Canonical destination-search hit (T-6.7 — spine place, Overture-sourced). */
export const TEST_PLACE_ID = "44444444-4444-4444-8444-444444444444";

export function makePlace(overrides?: Partial<Place>): Place {
  return {
    id: TEST_PLACE_ID,
    source: "overture",
    source_id: "ovt-kyoto",
    name: "Kyoto",
    lat: 35.0116,
    lng: 135.7681,
    category: "locality",
    coarse_category: "other",
    wiki_ref: null,
    created_by: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeInvitePreview(overrides?: Partial<InvitePreview>): InvitePreview {
  const today = localTodayISO();
  return {
    trip: {
      name: "Kyoto",
      destination_name: "Kyoto, Japan",
      start_date: addDays(today, 30),
      end_date: addDays(today, 37),
    },
    inviter: { display_name: "Test Traveler", avatar_key: null },
    role: "editor",
    state: "active",
    already_member: false,
    ...overrides,
  };
}

/** The default guarded trip most route-tree suites mount. */
export const DEFAULT_TRIPS: TripListItem[] = [makePlanningTrip(TEST_TRIP_ID)];

export interface NavApiOptions {
  /** `GET /trips` page AND the `GET /trips/:tripId` universe (id-keyed). */
  trips?: TripListItem[];
  /** Token → preview for `GET /invites/:token`; unknown tokens 404. */
  invitePreviews?: Record<string, InvitePreview>;
  /** `METHOD path` → responder; replaces the route (partial-failure seam). */
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}

/**
 * Mock the whole nav-surface network by descriptor. Unknown trips/tokens get
 * the server's indistinguishable 404 (`ApiRequestError`), so guard tests
 * exercise the REAL error mapping, not a bespoke fake.
 */
export function mockNavApi(opts: NavApiOptions = {}): jest.Mock {
  const trips = opts.trips ?? DEFAULT_TRIPS;
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation(
    (descriptor: { method: string; path: string }, input?: { params?: Record<string, string> }) => {
      const key = `${descriptor.method} ${descriptor.path}`;
      const override = opts.overrides?.[key];
      if (override) return override((input ?? {}) as Record<string, unknown>);
      switch (key) {
        case "GET /trips": {
          const page: Paginated<TripListItem> = { items: trips, nextCursor: null };
          return Promise.resolve(page);
        }
        case "GET /trips/:tripId": {
          const trip = byId.get(input?.params?.tripId ?? "");
          return trip !== undefined
            ? Promise.resolve(trip)
            : Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found"));
        }
        case "GET /invites/:token": {
          const preview = opts.invitePreviews?.[input?.params?.token ?? ""];
          return preview !== undefined
            ? Promise.resolve(preview)
            : Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found"));
        }
        case "POST /auth/logout":
          return Promise.resolve(undefined);
        default:
          return Promise.reject(new Error(`unexpected ${key}`));
      }
    },
  );
  return request;
}
