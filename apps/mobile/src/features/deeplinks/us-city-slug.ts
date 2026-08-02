/**
 * US `state--city` slug mapping for the Eventbrite browse link (T-7.8 /
 * IT-8; itinerary spec §2.7: "Constructible only when the destination maps
 * to a US `state--city` slug; otherwise omit the button").
 *
 * Accepted destination shapes — the comma-separated forms our destination
 * typeahead produces ("City, ST", "City, State", optionally with a trailing
 * US country segment): the LAST non-country segment must resolve to a US
 * state (name or USPS code), the FIRST segment is the city. Anything else —
 * no comma, non-US country, unrecognized state — returns null (button
 * omitted). Deliberately conservative: a wrong slug 404s on Eventbrite, an
 * omitted button is honest.
 */

/** USPS code by lowercase state name (50 states + DC). */
const STATE_CODE_BY_NAME: Readonly<Record<string, string>> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  "district of columbia": "dc",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
};

const US_STATE_CODES: ReadonlySet<string> = new Set(Object.values(STATE_CODE_BY_NAME));

const US_COUNTRY_NAMES: ReadonlySet<string> = new Set([
  "us",
  "usa",
  "u.s.",
  "u.s.a.",
  "united states",
  "united states of america",
]);

/**
 * State NAMES that are also country names ("Tbilisi, Georgia" is not in the
 * US). A bare ambiguous name only counts as a US state when an explicit US
 * country segment follows ("Atlanta, Georgia, USA"); the USPS code ("GA")
 * stays unambiguous. Conservative by design — an omitted button is honest.
 */
const AMBIGUOUS_STATE_NAMES: ReadonlySet<string> = new Set(["georgia"]);

/**
 * Lowercase kebab slug for the city segment ("San Francisco" →
 * "san-francisco"). NFD-normalize + strip combining marks first so accented
 * destinations slug the way Eventbrite does ("Doña Ana" → "dona-ana") instead
 * of dropping the letter entirely ("d-a-ana").
 */
function citySlug(city: string): string | null {
  const slug = city
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/** State segment ("TX" / "Texas") → USPS code, or null when not a US state. */
function stateCode(state: string): string | null {
  const normalized = state.toLowerCase().replaceAll(/\s+/g, " ").trim();
  if (US_STATE_CODES.has(normalized)) return normalized;
  return STATE_CODE_BY_NAME[normalized] ?? null;
}

/**
 * `"Austin, TX"` → `"tx--austin"`; unmappable → null. The Eventbrite slug
 * order is state-first (`eventbrite.com/d/tx--austin/events/`).
 */
export function usCityStateSlug(destinationName: string): string | null {
  const segments = destinationName
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  const hasUsCountry = US_COUNTRY_NAMES.has(last.toLowerCase());
  const withoutCountry = hasUsCountry ? segments.slice(0, -1) : segments;
  if (withoutCountry.length < 2) return null;

  const stateSegment = withoutCountry[withoutCountry.length - 1];
  const cityIn = withoutCountry[0];
  if (stateSegment === undefined || cityIn === undefined) return null;

  // "Tbilisi, Georgia" is a country destination, not a US state — an
  // ambiguous state NAME needs the explicit US country segment to count.
  const normalizedState = stateSegment.toLowerCase().replaceAll(/\s+/g, " ").trim();
  if (AMBIGUOUS_STATE_NAMES.has(normalizedState) && !hasUsCountry) return null;

  const code = stateCode(stateSegment);
  if (code === null) return null;
  const city = citySlug(cityIn);
  if (city === null) return null;
  return `${code}--${city}`;
}
