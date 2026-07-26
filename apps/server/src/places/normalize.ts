/**
 * Spine-record normalization (places spec §3.1.4 step 3): `name` trim/NFC,
 * `lat`/`lng` range-validated, `category` stored as the raw source-taxonomy
 * string (coarse mapping is read-side, §3.2.3), `wiki_ref` carried through
 * when the source has one, `source_id` required. A record that fails any
 * rule is DROPPED (returns null) — open datasets carry junk rows and one bad
 * record must never fail a region (R-places-4 is for job-level failures).
 *
 * Pure and dataset-agnostic: the per-source column mapping lives in the
 * reader; this is the single gate every record passes before the upsert.
 */

/** What the GeoParquet reader yields — untrusted, nullable everything. */
export interface RawSpineRecord {
  sourceId: string | null;
  name: string | null;
  lat: number | null;
  lng: number | null;
  category: string | null;
  wikiRef: string | null;
}

/** A record that passed normalization and is safe to upsert. */
export interface SpineRecord {
  sourceId: string;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  wikiRef: string | null;
}

// Defensive caps, not product rules: real POI attributes are far below these;
// anything above is dataset junk (same posture as the T-6.1 string caps —
// no write path accepts unbounded strings).
const MAX_SOURCE_ID_CHARS = 200;
const MAX_NAME_CHARS = 500;
const MAX_CATEGORY_CHARS = 500;
const MAX_WIKI_REF_CHARS = 200;

function inRange(value: number | null, min: number, max: number): value is number {
  return value !== null && Number.isFinite(value) && value >= min && value <= max;
}

export function normalizeSpineRecord(raw: RawSpineRecord): SpineRecord | null {
  const sourceId = raw.sourceId?.trim() ?? "";
  if (sourceId.length === 0 || sourceId.length > MAX_SOURCE_ID_CHARS) return null;

  // NFC so byte-different encodings of the same name ("Belém" NFD vs NFC)
  // compare equal in pg_trgm dedup and type-ahead search.
  const name = raw.name?.trim().normalize("NFC") ?? "";
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return null;

  if (!inRange(raw.lat, -90, 90) || !inRange(raw.lng, -180, 180)) return null;

  const category = raw.category?.trim() ?? "";
  const wikiRef = raw.wikiRef?.trim() ?? "";

  return {
    sourceId,
    name,
    lat: raw.lat,
    lng: raw.lng,
    category: category.length > 0 && category.length <= MAX_CATEGORY_CHARS ? category : null,
    wikiRef: wikiRef.length > 0 && wikiRef.length <= MAX_WIKI_REF_CHARS ? wikiRef : null,
  };
}
