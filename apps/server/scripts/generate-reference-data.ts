/**
 * Regenerates the committed transport reference dataset (B-9):
 *
 *   pnpm --filter @gogo/server exec tsx scripts/generate-reference-data.ts
 *
 * Writes `reference-data/airports.json` + `reference-data/airlines.json`
 * (provenance + licence: `reference-data/README.md`). NETWORK RUNS HERE, at
 * generation time on a dev machine, ONLY — the app never downloads anything
 * at boot/runtime, and tests only ever see the committed snapshot via the
 * seed migration (Law #5-compatible CI).
 *
 * Sources ($0, open data, no accounts/keys):
 *  - Airports: OurAirports daily CSV (public domain / CC0).
 *  - IANA tz:  derived lat/lng → zone via `geo-tz/all` (MIT code; polygon
 *    data from timezone-boundary-builder — ODbL, see the README's flag).
 *    The `/all` (comprehensive) product returns country-specific ids
 *    (`Asia/Bahrain`, not the post-1970-merged `Asia/Qatar`) — better
 *    display labels, identical offsets.
 *  - Airlines: Wikidata SPARQL (CC0) — entities with an IATA designator
 *    (P229) that are airlines (P31/P279* Q46970), not dissolved (no P576).
 *
 * Deterministic given fixed source snapshots: filters, dedupe rules, and
 * ordering are all total orders (documented inline). The script SELF-CHECKS
 * a pin set of airports whose zones the B-8 evidence fixtures depend on and
 * refuses to write output that fails a pin.
 *
 * After regenerating, rebuild the seed SQL for a NEW migration with
 * `scripts/reference-data-to-sql.ts` (Law #6 — dataset refresh is a
 * migration, never drift).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { find as findTz } from "geo-tz/all";

/** Operator-facing generation report — the script's whole point is its output. */
// eslint-disable-next-line no-console -- generator report for the operator
const report = (line: string): void => console.log(line);

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "reference-data");
const AIRPORTS_CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";

const IATA_AIRPORT_RE = /^[A-Z]{3}$/;
const ICAO_AIRPORT_RE = /^[A-Z0-9]{4}$/;
const IATA_AIRLINE_RE = /^[A-Z0-9]{2}$/;
const ALL_DIGITS_RE = /^[0-9]{2}$/;
const NAME_MAX = 200;
const TZ_MAX = 64;

export interface AirportSeed {
  iata: string;
  icao: string | null;
  name: string;
  city: string | null;
  country: string | null;
  lat: number;
  lng: number;
  tz: string;
}

export interface AirlineSeed {
  iata: string;
  name: string;
}

/**
 * Zone pins for airports the B-8/T-S3.4 fixtures reason about — a generation
 * run that breaks one of these must fail loudly, not ship a silently-wrong
 * snapshot. (`routes.db.test.ts` re-pins these against the seeded DB.)
 */
const ZONE_PINS: Record<string, string> = {
  NRT: "Asia/Tokyo",
  HND: "Asia/Tokyo",
  LAX: "America/Los_Angeles",
  AKL: "Pacific/Auckland",
  PPT: "Pacific/Tahiti",
  BAH: "Asia/Bahrain",
  PPG: "Pacific/Pago_Pago",
};

// ---------------------------------------------------------------------------
// CSV (OurAirports quotes fields containing commas/quotes)
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** IANA-valid iff Intl accepts it (throws otherwise). */
function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const clean = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim().normalize("NFC");
  return trimmed.length === 0 ? null : trimmed;
};

// ---------------------------------------------------------------------------
// Airports
// ---------------------------------------------------------------------------

/** Larger scheduled-service field wins an IATA-code collision. */
const TYPE_RANK: Record<string, number> = {
  large_airport: 0,
  medium_airport: 1,
  small_airport: 2,
  seaplane_base: 3,
  heliport: 4,
};

async function buildAirports(): Promise<AirportSeed[]> {
  report(`fetching ${AIRPORTS_CSV_URL} …`);
  const res = await fetch(AIRPORTS_CSV_URL);
  if (!res.ok) throw new Error(`OurAirports fetch failed: ${res.status}`);
  const rows = parseCsv(await res.text());
  const header = rows[0];
  if (!header) throw new Error("empty airports CSV");
  const col = new Map(header.map((h, i) => [h, i] as const));
  const at = (row: string[], name: string): string | undefined => row[col.get(name) ?? -1];

  interface Candidate extends AirportSeed {
    typeRank: number;
    sourceId: number;
  }
  const byIata = new Map<string, Candidate>();
  let considered = 0;
  const skipped: string[] = [];

  for (const row of rows.slice(1)) {
    if (at(row, "scheduled_service") !== "yes") continue;
    const type = at(row, "type") ?? "";
    if (type === "closed") continue;
    const iata = (at(row, "iata_code") ?? "").trim();
    if (!IATA_AIRPORT_RE.test(iata)) continue;
    considered++;

    const name = clean(at(row, "name"));
    const lat = Number(at(row, "latitude_deg"));
    const lng = Number(at(row, "longitude_deg"));
    if (!name || name.length > NAME_MAX) {
      skipped.push(`${iata}: unusable name`);
      continue;
    }
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      skipped.push(`${iata}: unusable coordinates`);
      continue;
    }

    const [tz] = findTz(lat, lng);
    if (!tz || tz.length > TZ_MAX || !isValidZone(tz)) {
      skipped.push(`${iata}: no valid IANA zone for (${lat}, ${lng}) → ${tz ?? "none"}`);
      continue;
    }

    const icaoRaw = (at(row, "icao_code") ?? "").trim().toUpperCase();
    const cityRaw = clean(at(row, "municipality"));
    const countryRaw = (at(row, "iso_country") ?? "").trim().toUpperCase();
    const candidate: Candidate = {
      iata,
      icao: ICAO_AIRPORT_RE.test(icaoRaw) ? icaoRaw : null,
      name,
      city: cityRaw && cityRaw.length <= NAME_MAX ? cityRaw : null,
      country: /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : null,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      tz,
      typeRank: TYPE_RANK[type] ?? 9,
      sourceId: Number(at(row, "id") ?? Number.MAX_SAFE_INTEGER),
    };

    // IATA collision: larger type wins; tie → lower OurAirports id (stable).
    const existing = byIata.get(iata);
    if (
      !existing ||
      candidate.typeRank < existing.typeRank ||
      (candidate.typeRank === existing.typeRank && candidate.sourceId < existing.sourceId)
    ) {
      if (existing) skipped.push(`${iata}: duplicate IATA — kept the larger/older field`);
      byIata.set(iata, candidate);
    } else {
      skipped.push(`${iata}: duplicate IATA — kept the larger/older field`);
    }
  }

  const airports = [...byIata.values()].sort((a, b) => (a.iata < b.iata ? -1 : 1));

  // ICAO must be unique (partial unique index): null-out later collisions.
  const seenIcao = new Set<string>();
  for (const airport of airports) {
    if (airport.icao === null) continue;
    if (seenIcao.has(airport.icao)) {
      skipped.push(`${airport.iata}: duplicate ICAO ${airport.icao} — nulled`);
      airport.icao = null;
    } else {
      seenIcao.add(airport.icao);
    }
  }

  for (const [iata, expected] of Object.entries(ZONE_PINS)) {
    const actual = airports.find((a) => a.iata === iata)?.tz;
    if (actual !== expected) {
      throw new Error(`zone pin failed: ${iata} expected ${expected}, got ${actual ?? "missing"}`);
    }
  }

  report(
    `airports: ${considered} scheduled-service IATA rows → ${airports.length} seeds ` +
      `(${skipped.length} skipped/deduped)`,
  );
  for (const line of skipped) report(`  - ${line}`);
  return airports.map(({ typeRank: _t, sourceId: _s, ...seed }) => seed);
}

// ---------------------------------------------------------------------------
// Airlines
// ---------------------------------------------------------------------------

const AIRLINES_SPARQL = `SELECT ?airline ?airlineLabel ?iata ?dissolved ?sitelinks WHERE {
  ?airline wdt:P229 ?iata .
  ?airline wdt:P31/wdt:P279* wd:Q46970 .
  ?airline wikibase:sitelinks ?sitelinks .
  OPTIONAL { ?airline wdt:P576 ?dissolved . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

interface SparqlBinding {
  airline: { value: string };
  airlineLabel: { value: string };
  iata: { value: string };
  dissolved?: { value: string };
  sitelinks: { value: string };
}

async function buildAirlines(): Promise<AirlineSeed[]> {
  report("querying Wikidata for airlines …");
  const res = await fetch(`${WIKIDATA_SPARQL_URL}?query=${encodeURIComponent(AIRLINES_SPARQL)}`, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "GoGoTravel-reference-data-generator/1.0 (open-data seed build; run manually)",
    },
  });
  if (!res.ok) throw new Error(`Wikidata query failed: ${res.status}`);
  const body = (await res.json()) as { results: { bindings: SparqlBinding[] } };

  interface Candidate extends AirlineSeed {
    sitelinks: number;
    qid: string;
  }
  const byIata = new Map<string, Candidate>();
  let considered = 0;
  let excludedAllDigits = 0;

  for (const binding of body.results.bindings) {
    if (binding.dissolved !== undefined) continue; // defunct — IATA codes get reused
    const iata = binding.iata.value.trim().toUpperCase();
    if (!IATA_AIRLINE_RE.test(iata)) continue;
    if (ALL_DIGITS_RE.test(iata)) {
      excludedAllDigits++;
      continue; // ambiguous inside "12345"-style flight numbers
    }
    const name = clean(binding.airlineLabel.value);
    // A bare QID label means "no English label" — unusable for display.
    if (!name || name.length > NAME_MAX || /^Q\d+$/.test(name)) continue;
    considered++;

    const candidate: Candidate = {
      iata,
      name,
      sitelinks: Number(binding.sitelinks.value),
      qid: binding.airline.value,
    };
    // IATA collision (reuse + controlled duplicates): most sitelinks wins
    // (popularity proxy — "NH" must resolve to All Nippon Airways, not the
    // regional co-holder); tie → smallest QID (stable).
    const existing = byIata.get(iata);
    if (
      !existing ||
      candidate.sitelinks > existing.sitelinks ||
      (candidate.sitelinks === existing.sitelinks && candidate.qid < existing.qid)
    ) {
      byIata.set(iata, candidate);
    }
  }

  const airlines = [...byIata.values()]
    .sort((a, b) => (a.iata < b.iata ? -1 : 1))
    .map(({ sitelinks: _s, qid: _q, ...seed }) => seed);
  report(
    `airlines: ${considered} active labeled candidates → ${airlines.length} unique IATA codes ` +
      `(${excludedAllDigits} all-digit codes excluded)`,
  );

  const nh = airlines.find((a) => a.iata === "NH");
  if (nh?.name !== "All Nippon Airways") {
    throw new Error(`airline pin failed: NH → ${nh?.name ?? "missing"}`);
  }
  return airlines;
}

// ---------------------------------------------------------------------------

/** One row per line — compact but diffable. */
function toJsonLines(rows: object[]): string {
  return `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
}

const [airports, airlines] = await Promise.all([buildAirports(), buildAirlines()]);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "airports.json"), toJsonLines(airports));
writeFileSync(join(OUT_DIR, "airlines.json"), toJsonLines(airlines));
report(`wrote ${airports.length} airports + ${airlines.length} airlines to ${OUT_DIR}`);
report("(licence + provenance: reference-data/README.md — update its snapshot date)");
