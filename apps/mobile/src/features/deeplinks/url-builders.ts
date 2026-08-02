/**
 * Deeplink-out URL builders (T-7.8 / IT-8; itinerary spec §2.7) — pure
 * functions, one per §2.7 partner row. Every template traces to
 * `.specs/research/booking-integrations.md` § Key deeplink formats; ONLY
 * research-verified formats ship — anything unverified degrades to the
 * partner's plain domain link (§2.7 preamble).
 *
 * Contract per builder (drives R-itin-21 button enablement):
 *  - all required fields present → `{ status: "ready", url }` — the EXACT
 *    partner URL, every interpolation URL-encoded, date formats per-partner
 *    (`YYYY-MM-DD` / Skyscanner `yymmdd` / Turo `MM/DD/YYYY`);
 *  - required fields missing → `{ status: "missing", missing: [labels] }` —
 *    the button renders disabled, hinting the missing field(s);
 *  - partner not constructible at all for this input → `{ status: "omit" }`
 *    (Eventbrite outside a US `state--city` destination — §2.7: "otherwise
 *    omit the button", not disable).
 *
 * `adults` defaults to the trip's member count upstream (R-itin-32 — the
 * PANEL owns the default + inline edit; builders take the resolved number).
 *
 * Affiliate params (§2.7 preamble): every builder accepts an optional
 * `affiliate` query-param map, appended verbatim-encoded. DORMANT until
 * Sean's affiliate signups (research § Escalations — e.g. Viator
 * `?pid={P00X}&mcid={id}&medium=link` when it activates); nothing in v1
 * passes it.
 */
import type { BookingCategory } from "@gogo/shared";

import { usCityStateSlug } from "./us-city-slug";

// ---------------------------------------------------------------------------
// Result + shared plumbing
// ---------------------------------------------------------------------------

export type DeeplinkBuild =
  | { status: "ready"; url: string }
  | { status: "missing"; missing: readonly string[] }
  | { status: "omit" };

/** Optional affiliate query params, appended in insertion order (dormant v1). */
export type AffiliateParams = Readonly<Record<string, string>>;

const ready = (url: string): DeeplinkBuild => ({ status: "ready", url });
const missing = (fields: readonly string[]): DeeplinkBuild => ({
  status: "missing",
  missing: fields,
});
const OMIT: DeeplinkBuild = { status: "omit" };

/** `k=v&k2=v2` with both sides `encodeURIComponent`-encoded. */
function queryString(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Append affiliate params to a built URL (`?` or `&` as the URL requires). */
export function withAffiliateParams(url: string, affiliate?: AffiliateParams): string {
  if (affiliate === undefined || Object.keys(affiliate).length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${queryString(affiliate)}`;
}

/** True for a non-empty (post-trim) string — the "field is present" test. */
function has(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

const trim = (value: string): string => value.trim();

/** `YYYY-MM-DD` → Skyscanner's `yymmdd` (research: NOT ISO). */
export function toYymmdd(isoDate: string): string {
  return isoDate.slice(2).replaceAll("-", "");
}

/** `YYYY-MM-DD` → Turo's `MM/DD/YYYY` (research: caveated exact format). */
export function toUsSlashDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${m}/${d}/${y}`;
}

/** R-itin-32 guard: a traveler count is a positive integer (floor + min 1). */
export function normalizeAdults(adults: number): number {
  return Number.isFinite(adults) ? Math.max(1, Math.floor(adults)) : 1;
}

// ---------------------------------------------------------------------------
// Field shapes (panel/consumer-facing; every field optional — enablement is
// the builders' verdict, not the type system's)
// ---------------------------------------------------------------------------

export interface FlightSearchFields {
  originIata?: string;
  destinationIata?: string;
  /** `YYYY-MM-DD` (wall date of departure). */
  departDate?: string;
  /** `YYYY-MM-DD`; present ⇒ round trip (second Kayak/Skyscanner segment). */
  returnDate?: string;
  /** Free text from the form; mapped to Skyscanner's fixed cabin set. */
  cabinClass?: string;
  /** Kayak `?fs=stops=0` / Skyscanner `preferDirects=true` form toggle. */
  nonStopOnly?: boolean;
}

export interface LodgingSearchFields {
  /** Place/address field; the PANEL falls back to `trips.destination_name` (§2.7). */
  location?: string;
  /** `YYYY-MM-DD`. */
  checkIn?: string;
  /** `YYYY-MM-DD`. */
  checkOut?: string;
}

export interface CarRentalSearchFields {
  pickupLocation?: string;
  /** `YYYY-MM-DD`. */
  pickupDate?: string;
  /** `YYYY-MM-DD`. */
  dropoffDate?: string;
}

/** Pure-builder input — URNs come from the Trainline lookup (trainline.ts). */
export interface TrainlineUrlInput {
  originUrn?: string;
  destinationUrn?: string;
  /** ISO datetime of departure, passed through encoded (spec: `outwardDate={ISO}`). */
  outwardDate?: string;
}

// ---------------------------------------------------------------------------
// Flight (§2.7 rows 1–2)
// ---------------------------------------------------------------------------

/**
 * Kayak Flights: `kayak.com/flights/{ORIG}-{DEST}/{YYYY-MM-DD}[/{RET}]`
 * (+ `?fs=stops=0` when the non-stop toggle is set). Enabled when both IATAs
 * and the depart date are present (R-itin-21). No adults param — Kayak's
 * verified format doesn't carry one.
 */
export function buildKayakFlightsUrl(
  fields: FlightSearchFields,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps: string[] = [];
  if (!has(fields.originIata)) gaps.push("origin airport");
  if (!has(fields.destinationIata)) gaps.push("destination airport");
  if (!has(fields.departDate)) gaps.push("departure date");
  if (gaps.length > 0) return missing(gaps);

  const orig = encodeURIComponent(trim(fields.originIata ?? "").toUpperCase());
  const dest = encodeURIComponent(trim(fields.destinationIata ?? "").toUpperCase());
  let url = `https://www.kayak.com/flights/${orig}-${dest}/${encodeURIComponent(trim(fields.departDate ?? ""))}`;
  if (has(fields.returnDate)) url += `/${encodeURIComponent(trim(fields.returnDate))}`;
  if (fields.nonStopOnly === true) url += "?fs=stops=0";
  return ready(withAffiliateParams(url, affiliate));
}

/** Skyscanner's fixed cabin-class set (officially documented params). */
export type SkyscannerCabin = "economy" | "premiumeconomy" | "business" | "first";

/**
 * Free-text cabin field → Skyscanner's set. "Premium economy" in any casing/
 * separator maps to `premiumeconomy`; unknown/absent text falls back to
 * `economy` (the search still lands — cabin is a preference, not a filter
 * the user typed precisely).
 */
export function mapSkyscannerCabin(cabinClass: string | undefined): SkyscannerCabin {
  const normalized = (cabinClass ?? "").toLowerCase().replaceAll(/[^a-z]/g, "");
  if (normalized.includes("premium")) return "premiumeconomy";
  if (normalized.includes("business")) return "business";
  if (normalized.includes("first")) return "first";
  return "economy";
}

/**
 * Skyscanner:
 * `skyscanner.net/transport/flights/{orig}/{dest}/{yymmdd}/[{yymmdd}/]?adultsv2=&cabinclass=&preferDirects=`
 * — lowercase IATA, `yymmdd` dates (research: NOT ISO), officially
 * documented param set.
 */
export function buildSkyscannerUrl(
  fields: FlightSearchFields,
  adults: number,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps: string[] = [];
  if (!has(fields.originIata)) gaps.push("origin airport");
  if (!has(fields.destinationIata)) gaps.push("destination airport");
  if (!has(fields.departDate)) gaps.push("departure date");
  if (gaps.length > 0) return missing(gaps);

  const orig = encodeURIComponent(trim(fields.originIata ?? "").toLowerCase());
  const dest = encodeURIComponent(trim(fields.destinationIata ?? "").toLowerCase());
  // Encoded like every other interpolation (digits are encoding-fixed, so the
  // exact-literal pins are unchanged — this closes the one unencoded seam).
  let path = `${orig}/${dest}/${encodeURIComponent(toYymmdd(trim(fields.departDate ?? "")))}/`;
  if (has(fields.returnDate)) path += `${encodeURIComponent(toYymmdd(trim(fields.returnDate)))}/`;
  const query = queryString({
    adultsv2: String(normalizeAdults(adults)),
    cabinclass: mapSkyscannerCabin(fields.cabinClass),
    preferDirects: fields.nonStopOnly === true ? "true" : "false",
  });
  return ready(
    withAffiliateParams(`https://www.skyscanner.net/transport/flights/${path}?${query}`, affiliate),
  );
}

// ---------------------------------------------------------------------------
// Lodging (§2.7 rows 3–6) — `location` here is ALREADY resolved (place/address
// field, else `trips.destination_name`; the panel owns that fallback)
// ---------------------------------------------------------------------------

function lodgingGaps(fields: LodgingSearchFields): string[] {
  const gaps: string[] = [];
  if (!has(fields.location)) gaps.push("location");
  if (!has(fields.checkIn)) gaps.push("check-in date");
  if (!has(fields.checkOut)) gaps.push("check-out date");
  return gaps;
}

/**
 * Airbnb: `airbnb.com/s/{location}/homes?checkin=&checkout=&adults=`.
 * Research caveat (repeated by §2.7): the app honoring params after the
 * universal-link hop is UNTESTED — device-verify is a phase-QA item.
 */
export function buildAirbnbUrl(
  fields: LodgingSearchFields,
  adults: number,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps = lodgingGaps(fields);
  if (gaps.length > 0) return missing(gaps);
  const query = queryString({
    checkin: trim(fields.checkIn ?? ""),
    checkout: trim(fields.checkOut ?? ""),
    adults: String(normalizeAdults(adults)),
  });
  const url = `https://www.airbnb.com/s/${encodeURIComponent(trim(fields.location ?? ""))}/homes?${query}`;
  return ready(withAffiliateParams(url, affiliate));
}

/** Booking.com: `booking.com/searchresults.html?ss=&checkin=&checkout=&group_adults=`. */
export function buildBookingComUrl(
  fields: LodgingSearchFields,
  adults: number,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps = lodgingGaps(fields);
  if (gaps.length > 0) return missing(gaps);
  const query = queryString({
    ss: trim(fields.location ?? ""),
    checkin: trim(fields.checkIn ?? ""),
    checkout: trim(fields.checkOut ?? ""),
    group_adults: String(normalizeAdults(adults)),
  });
  return ready(
    withAffiliateParams(`https://www.booking.com/searchresults.html?${query}`, affiliate),
  );
}

/** Expedia (official docs): `expedia.com/Hotel-Search?destination=&startDate=&endDate=&adults=`. */
export function buildExpediaUrl(
  fields: LodgingSearchFields,
  adults: number,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps = lodgingGaps(fields);
  if (gaps.length > 0) return missing(gaps);
  const query = queryString({
    destination: trim(fields.location ?? ""),
    startDate: trim(fields.checkIn ?? ""),
    endDate: trim(fields.checkOut ?? ""),
    adults: String(normalizeAdults(adults)),
  });
  return ready(withAffiliateParams(`https://www.expedia.com/Hotel-Search?${query}`, affiliate));
}

/** Vrbo: `vrbo.com/search?destination=&startDate=&endDate=&adults=`. */
export function buildVrboUrl(
  fields: LodgingSearchFields,
  adults: number,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps = lodgingGaps(fields);
  if (gaps.length > 0) return missing(gaps);
  const query = queryString({
    destination: trim(fields.location ?? ""),
    startDate: trim(fields.checkIn ?? ""),
    endDate: trim(fields.checkOut ?? ""),
    adults: String(normalizeAdults(adults)),
  });
  return ready(withAffiliateParams(`https://www.vrbo.com/search?${query}`, affiliate));
}

// ---------------------------------------------------------------------------
// Train (§2.7 rows 7–9)
// ---------------------------------------------------------------------------

/** Degrade target when the URN lookup fails (§2.7: "degrade to plain thetrainline.com"). */
export const TRAINLINE_HOME_URL = "https://www.thetrainline.com/";
export const OMIO_URL = "https://www.omio.com/";
export const AMTRAK_URL = "https://www.amtrak.com/";

/**
 * Trainline results (step 2 of the URN flow):
 * `thetrainline.com/book/results?origin={urn}&destination={urn}&outwardDate={ISO}`.
 * Step 1 (the station-search lookup that produces the URNs) lives in
 * `trainline.ts` — this builder is pure over its output.
 */
export function buildTrainlineUrl(
  input: TrainlineUrlInput,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps: string[] = [];
  if (!has(input.originUrn)) gaps.push("origin station");
  if (!has(input.destinationUrn)) gaps.push("destination station");
  if (!has(input.outwardDate)) gaps.push("departure time");
  if (gaps.length > 0) return missing(gaps);
  const query = queryString({
    origin: trim(input.originUrn ?? ""),
    destination: trim(input.destinationUrn ?? ""),
    outwardDate: trim(input.outwardDate ?? ""),
  });
  return ready(
    withAffiliateParams(`https://www.thetrainline.com/book/results?${query}`, affiliate),
  );
}

/** Omio: plain link only — no parameterized format in research. Always ready. */
export function buildOmioUrl(affiliate?: AffiliateParams): DeeplinkBuild {
  return ready(withAffiliateParams(OMIO_URL, affiliate));
}

/** Amtrak: plain link (research: no API, SPA, no prefill). Always ready. */
export function buildAmtrakUrl(affiliate?: AffiliateParams): DeeplinkBuild {
  return ready(withAffiliateParams(AMTRAK_URL, affiliate));
}

// ---------------------------------------------------------------------------
// Car rental (§2.7 rows 10–11)
// ---------------------------------------------------------------------------

/** Kayak Cars: `kayak.com/cars/{location}/{YYYY-MM-DD}/{YYYY-MM-DD}` (verified). */
export function buildKayakCarsUrl(
  fields: CarRentalSearchFields,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps: string[] = [];
  if (!has(fields.pickupLocation)) gaps.push("pickup location");
  if (!has(fields.pickupDate)) gaps.push("pickup date");
  if (!has(fields.dropoffDate)) gaps.push("dropoff date");
  if (gaps.length > 0) return missing(gaps);
  const url =
    `https://www.kayak.com/cars/${encodeURIComponent(trim(fields.pickupLocation ?? ""))}` +
    `/${encodeURIComponent(trim(fields.pickupDate ?? ""))}` +
    `/${encodeURIComponent(trim(fields.dropoffDate ?? ""))}`;
  return ready(withAffiliateParams(url, affiliate));
}

/**
 * Turo: `turo.com/us/en/search?location={q}&startDate={MM/DD/YYYY}` —
 * `MM/DD/YYYY` per research; further params exist but are UNVERIFIED, so v1
 * ships location + startDate ONLY (§2.7 caveat; device-verify before adding
 * more — phase-QA item).
 */
export function buildTuroUrl(
  fields: CarRentalSearchFields,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const gaps: string[] = [];
  if (!has(fields.pickupLocation)) gaps.push("pickup location");
  if (!has(fields.pickupDate)) gaps.push("pickup date");
  if (gaps.length > 0) return missing(gaps);
  const query = queryString({
    location: trim(fields.pickupLocation ?? ""),
    startDate: toUsSlashDate(trim(fields.pickupDate ?? "")),
  });
  return ready(withAffiliateParams(`https://turo.com/us/en/search?${query}`, affiliate));
}

// ---------------------------------------------------------------------------
// Activity / other (§2.7 rows 12–13)
// ---------------------------------------------------------------------------

/**
 * Eventbrite browse: `eventbrite.com/d/{state--city}/events/` — constructible
 * ONLY when the destination maps to a US `state--city` slug; otherwise the
 * button is OMITTED entirely (§2.7 — omit, not disable).
 */
export function buildEventbriteUrl(
  destinationName: string | undefined,
  affiliate?: AffiliateParams,
): DeeplinkBuild {
  const slug = usCityStateSlug(destinationName ?? "");
  if (slug === null) return OMIT;
  return ready(withAffiliateParams(`https://www.eventbrite.com/d/${slug}/events/`, affiliate));
}

/**
 * External URL: `details.external_url` verbatim, shown as "Open {host}".
 * Only http(s) URLs are openable — a deeplink button must never hand an
 * arbitrary scheme (`javascript:`, `tel:`…) to `Linking.openURL`, so
 * anything else counts as the field being missing/invalid.
 */
export function buildExternalUrl(externalUrl: string | undefined): DeeplinkBuild {
  if (!has(externalUrl)) return missing(["link URL"]);
  const url = trim(externalUrl);
  if (externalUrlHost(url) === null) return missing(["valid link URL"]);
  return ready(url);
}

/**
 * Host of an http(s) URL for the "Open {host}" label; null = not http(s).
 * An authority carrying userinfo (`https://chase.com.account-verify@evil.io`)
 * is REJECTED outright — the "Open {host}" label would show the spoof text
 * while the tap lands on the real host after the `@`. Legit booking links
 * never carry userinfo, so this folds to the missing/invalid verdict.
 */
export function externalUrlHost(externalUrl: string | undefined): string | null {
  if (externalUrl === undefined) return null;
  const match = /^https?:\/\/([^/?#]+)/i.exec(externalUrl.trim());
  const host = match?.[1];
  if (host === undefined || host.length === 0) return null;
  if (host.includes("@")) return null;
  return host.replace(/^www\./i, "");
}

// ---------------------------------------------------------------------------
// Partner registry (panel + §2.9 testID slugs)
// ---------------------------------------------------------------------------

/** §2.9 testID slugs — `itinerary-item-new-button-search-{partner}` etc. */
export type DeeplinkPartnerId =
  | "kayak"
  | "skyscanner"
  | "airbnb"
  | "booking"
  | "expedia"
  | "vrbo"
  | "trainline"
  | "omio"
  | "amtrak"
  | "kayak-cars"
  | "turo"
  | "eventbrite"
  | "external";

export interface DeeplinkPartner {
  id: DeeplinkPartnerId;
  /** Display name for "Search on {partner}" (R-itin-21). */
  label: string;
  /** True when the partner URL carries a traveler count (R-itin-32 surface). */
  usesAdults: boolean;
}

/**
 * Partners per category, in §2.4 form-table order. Absent categories
 * (`moped_rental`, `restaurant`) have NO deeplink buttons in v1 — manual
 * entry only (§2.7 footnote; BikesBooking is a v2 affiliate).
 */
export const PARTNERS_BY_CATEGORY: Readonly<Record<BookingCategory, readonly DeeplinkPartner[]>> = {
  flight: [
    { id: "kayak", label: "Kayak", usesAdults: false },
    { id: "skyscanner", label: "Skyscanner", usesAdults: true },
  ],
  lodging: [
    { id: "airbnb", label: "Airbnb", usesAdults: true },
    { id: "booking", label: "Booking.com", usesAdults: true },
    { id: "expedia", label: "Expedia", usesAdults: true },
    { id: "vrbo", label: "Vrbo", usesAdults: true },
  ],
  train: [
    { id: "trainline", label: "Trainline", usesAdults: false },
    { id: "omio", label: "Omio", usesAdults: false },
    { id: "amtrak", label: "Amtrak", usesAdults: false },
  ],
  car_rental: [
    { id: "kayak-cars", label: "Kayak Cars", usesAdults: false },
    { id: "turo", label: "Turo", usesAdults: false },
  ],
  moped_rental: [],
  activity: [
    { id: "external", label: "External", usesAdults: false },
    { id: "eventbrite", label: "Eventbrite", usesAdults: false },
  ],
  restaurant: [],
  other: [{ id: "external", label: "External", usesAdults: false }],
};

/**
 * True when any partner for the category takes `{adults}`. CONSUMER: the
 * T-7.6 add-form seam (whether the form surfaces a traveler-count field for
 * the category). The panel itself does NOT call this — its per-category
 * subcomponents know statically whether they render the adults edit.
 */
export function categoryUsesAdults(category: BookingCategory): boolean {
  return PARTNERS_BY_CATEGORY[category].some((p) => p.usesAdults);
}

/** Display name by partner id (return-prompt copy: "…on {partner}"). */
export function partnerLabel(id: DeeplinkPartnerId): string {
  for (const partners of Object.values(PARTNERS_BY_CATEGORY)) {
    const match = partners.find((p) => p.id === id);
    if (match !== undefined) return match.label;
  }
  return id;
}
