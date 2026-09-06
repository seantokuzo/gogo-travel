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
import type {
  InviteListItem,
  InvitePreview,
  ISODate,
  MemberListItem,
  Paginated,
  Place,
  SavedPlaceWithPlace,
  TripListItem,
  TripMember,
  UserProfile,
} from "@gogo/shared";

import { apiClient, ApiRequestError } from "@/auth";
import { localTodayISO } from "@/navigation/trip-defaults";

import { CREATED_INVITE_ID, CREATED_INVITE_URL, TEST_INVITE_ID, TEST_TRIP_ID } from "./ids";
import { emptyBalancesRead, emptyBudgetsRead } from "./money-fixtures";
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

/** Saved-place row with the embedded place (T-8.2 — map pin fixtures). */
export function makeSavedPlaceWithPlace(
  overrides?: Omit<Partial<SavedPlaceWithPlace>, "place"> & { place?: Partial<Place> },
): SavedPlaceWithPlace {
  const place = makePlace(overrides?.place);
  return {
    id: "55555555-5555-4555-8555-555555555551",
    trip_id: TEST_TRIP_ID,
    place_id: place.id,
    note: null,
    created_by: TEST_USER.id,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
    place,
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

// ---------------------------------------------------------------------------
// Members & invites (T-6.8)
// ---------------------------------------------------------------------------

/** Member-visible profile — TEST_USER's fields unless overridden. */
export function makeUserProfile(overrides?: Partial<UserProfile>): UserProfile {
  return {
    id: TEST_USER.id,
    display_name: TEST_USER.display_name,
    avatar_key: null,
    venmo_username: null,
    cashtag: null,
    paypalme_username: null,
    zelle_handle: null,
    zelle_display_name: null,
    ...overrides,
  };
}

/** `GET /trips/:tripId/members` item — the caller as owner by default. */
export function makeMember(overrides?: {
  user?: Partial<UserProfile>;
  role?: MemberListItem["role"];
  joined_at?: string;
}): MemberListItem {
  return {
    user: makeUserProfile(overrides?.user),
    role: overrides?.role ?? "owner",
    joined_at: overrides?.joined_at ?? "2026-07-01T00:00:00.000Z",
  };
}

/**
 * `GET /trips/:tripId/invites` item — live 7-day editor invite by default.
 * Token-free since T-7.1: the wire list row no longer carries the bearer
 * token (create-response fixtures add one explicitly where needed).
 */
export function makeInvite(overrides?: Partial<InviteListItem>): InviteListItem {
  return {
    id: TEST_INVITE_ID,
    trip_id: TEST_TRIP_ID,
    role: "editor",
    created_by: TEST_USER.id,
    expires_at: `${addDays(localTodayISO(), 7)}T00:00:00.000Z`,
    revoked_at: null,
    max_uses: null,
    use_count: 0,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
}

export interface NavApiOptions {
  /** `GET /trips` page AND the `GET /trips/:tripId` universe (id-keyed). */
  trips?: TripListItem[];
  /** Token → preview for `GET /invites/:token`; unknown tokens 404. */
  invitePreviews?: Record<string, InvitePreview>;
  /** `GET /trips/:tripId/members` items (default: the caller as owner). */
  members?: MemberListItem[];
  /** `GET /trips/:tripId/invites` page items (default: none). */
  invites?: InviteListItem[];
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
  const members = opts.members ?? [makeMember()];
  const invites = opts.invites ?? [];
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation(
    (
      descriptor: { method: string; path: string },
      input?: { params?: Record<string, string>; body?: Record<string, unknown> },
    ) => {
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
        // Member/invite family (T-6.8) — happy-path defaults; failure shapes
        // come in through `overrides` so tests exercise the REAL error mapping.
        case "GET /trips/:tripId/members":
          return Promise.resolve({ items: members });
        case "GET /trips/:tripId/invites":
          return Promise.resolve({ items: invites, nextCursor: null });
        case "PATCH /trips/:tripId/members/:userId": {
          const row: TripMember = {
            trip_id: input?.params?.tripId ?? TEST_TRIP_ID,
            user_id: input?.params?.userId ?? "",
            role: (input?.body as { role?: TripMember["role"] } | undefined)?.role ?? "editor",
            joined_at: "2026-07-01T00:00:00.000Z",
          };
          return Promise.resolve(row);
        }
        case "DELETE /trips/:tripId/members/:userId":
          return Promise.resolve(undefined);
        case "POST /trips/:tripId/transfer-ownership": {
          const tripId = input?.params?.tripId ?? TEST_TRIP_ID;
          const toUserId = (input?.body as { to_user_id?: string } | undefined)?.to_user_id ?? "";
          const rows: TripMember[] = [
            {
              trip_id: tripId,
              user_id: TEST_USER.id,
              role: "editor",
              joined_at: "2026-07-01T00:00:00.000Z",
            },
            {
              trip_id: tripId,
              user_id: toUserId,
              role: "owner",
              joined_at: "2026-07-01T00:00:00.000Z",
            },
          ];
          return Promise.resolve({ items: rows });
        }
        case "POST /trips/:tripId/invites": {
          const role =
            (input?.body as { role?: InviteListItem["role"] } | undefined)?.role ?? "editor";
          const { state: _state, ...row } = makeInvite({ id: CREATED_INVITE_ID, role });
          // Wire-faithful: the CREATE response (alone) carries token + url.
          return Promise.resolve({ ...row, token: "tok-created", url: CREATED_INVITE_URL });
        }
        case "DELETE /trips/:tripId/invites/:inviteId":
          return Promise.resolve(undefined);
        // Itinerary tab family (T-7.4) — empty-calendar defaults so route-tree
        // suites mounting the itinerary tab settle without retry noise; real
        // universes come in through `overrides` (itinerary-fixtures.ts).
        case "GET /trips/:tripId/itinerary":
          return Promise.resolve({ items: [], legs: [] });
        case "GET /trips/:tripId/bookings":
          return Promise.resolve({ items: [], nextCursor: null });
        case "PUT /trips/:tripId/itinerary/days/:day/order":
          return Promise.resolve({ items: [] });
        // Map tab (T-8.2) — same empty-universe posture as the itinerary
        // family above: route-tree suites mounting the map tab settle
        // without retry noise; real pin sets ride `overrides`.
        case "GET /trips/:tripId/saved-places":
          return Promise.resolve({ items: [], nextCursor: null });
        // Money tab (T-9.5) — same empty-universe posture; real money
        // universes ride `overrides` (money-fixtures.ts).
        case "GET /trips/:tripId/balances":
          return Promise.resolve(emptyBalancesRead());
        case "GET /trips/:tripId/budgets":
          return Promise.resolve(emptyBudgetsRead());
        case "POST /auth/logout":
          return Promise.resolve(undefined);
        default:
          return Promise.reject(new Error(`unexpected ${key}`));
      }
    },
  );
  return request;
}
