# S-2 Research: Map SDK + Directions + Places

> Evidence layer for P-2 maps/places specs. Researched 2026-07-09, pricing
> verified against official pages, load-bearing claims adversarially verified.

## RECOMMENDED COMBO

**@rnmapbox/maps (Mapbox) + Mapbox Directions (drive/walk/cycle) + Transitous
(transit) + open-data places spine (Overture / FSQ OS in OUR Postgres) +
Foursquare hosted API for on-tap rich details.**

**~$0–60/mo at 1k MAU** (realistically ~$40; $0 if MVP skips premium fields
like hours/ratings/photos).

## Why Mapbox for the map (HIGH)

- **Only mainstream RN/Expo SDK with real offline** — StylePacks + TileRegions
  via `offlineManager`/TileStore. react-native-maps: no offline story;
  expo-maps: still alpha after 4+ SDK cycles, no offline/clustering, iOS 17+.
- Offline downloads **bill nothing extra** (included in MAU billing — official
  docs, adversarially verified). 750 cumulative tile packs/device ceiling
  (city/trip-scale fine); packs don't auto-refresh.
- Pricing: **25,000 MAU free/mo**, then $4/1k → $0 for us with 24x headroom.
- v10.3.2 (2026-07-05), Fabric/New-Arch, Expo config plugin, **dev build
  required** (no Expo Go — fine, we need one anyway). Clustering built into
  `ShapeSource`; `MarkerView` custom markers (~100 on-screen max); Mapbox
  Studio custom styles work offline.
- Gotchas: attribution/wordmark required; **Mapbox ends CocoaPods support Dec
  2026 (SPM-only)** — watch rnmapbox/Expo migration path (MEDIUM risk).

## The Google ToS wall (HIGH — verified verbatim, changed the design)

- **Routes API results may not be displayed with/near a non-Google map**
  (Maps Service Terms §19.2; ToS §3.2.3(e)). "Mapbox basemap + Google transit
  ETAs" is contractually dead.
- **Google Places is the worst contract for exactly our three features:**
  - Save locations: only place IDs cacheable indefinitely; storing
    names/hours/ratings prohibited (§3.2.3(a)).
  - Display on our (Mapbox) map: banned (§3.2.3(e), SST §14.2).
  - AI tour guide: content can't improve/train AI (§3.2.3(c)(vii)); LLM
    grounding only via Maps Grounding Lite ($7/1k); **text-to-speech use
    banned** (§3.2.3(a)(iv)) — fatal for audio tour-guide ambitions.

### ⚠️ Cross-report conflict + resolution

The AI-architecture research (`ai-architecture.md`) recommended Google Places
(New) for grounding recommendations. **Superseded by this report's verified
ToS findings**: with a Mapbox basemap, Google Places content can't legally
display on our map or feed our AI. **Resolution: ground AI features in OUR
open-data POI spine (Overture/FSQ OS, licenses below) + Wikipedia/Wikivoyage
— all legally storable and LLM-safe.** The AI report's caching/caps/batch
architecture stands unchanged; only the grounding source swaps.

## Directions (HIGH pricing / MEDIUM transit fit)

- **Mapbox Directions: 100k free req/mo**, then $2/1k. Profiles:
  driving-traffic/driving/walking/cycling — **no transit**. With leg-pair
  caching at 1k MAU → $0.
- **Transit: Transitous** (MOTIS 2, OSM+GTFS, community-run, free, no key; no
  SLA — contact before heavy use; degrade gracefully: hide the mode, don't
  fail). Fallback: HERE Public Transit (free tier shrank to 5k–30k/mo).
  Apple MKDirections: transit is ETA-only + ToS gray zone on a Mapbox map.
- Directions/ETAs are online-only everywhere → **precompute + store itinerary
  leg times at trip sync** (our derived data; verify Mapbox caching specifics
  at implementation).

## Places (HIGH licensing / MEDIUM cost)

- **Spine: Overture Maps places** (75M+ POIs; CDLA-Permissive-2.0 / Apache
  2.0 / CC0) and/or **FSQ OS Places** (100M+ POIs, Apache 2.0). Free bulk
  GeoParquet → **our Postgres, storable forever, commercial OK, LLM-safe.**
  This is the save-locations + AI-grounding spine. Enrich narration with
  Wikipedia/Wikivoyage (CC BY-SA).
- **On-tap rich details: Foursquare hosted Places API.** 2026-06-01 pricing:
  Pro 500 free calls/mo then $15/1k; Premium fields (hours/rating/photos/tips)
  **no free tier, $18.75/1k**. **Zero content caching for PAYG** (IDs only;
  no ML training) — architect detail views as fetch-fresh → display → discard
  from day one. ~2–3k Premium calls/mo ≈ $40–60; MVP without premium fields ≈
  $0.
- Autocomplete if needed: Mapbox Search Box — 500 free sessions then $3/1k,
  but that's INTRO pricing (standard $11.50/1k published) — watch it.

## Runner-up (documented, not chosen)

All-Google: react-native-maps (PROVIDER_GOOGLE, **no Map ID** — mobile map
loads unlimited free; adding a Map ID makes every load billable $7/1k) +
Routes API (transit 10k free/mo then $5/1k) + Places (New) with surgical field
masks. Cheapest legal first-class transit + best POI data, ~$0–50/mo. **Lost
because: no offline (breaks a committed feature) and the ToS strangles
save-locations + AI tour guide.** Pick only if offline gets dropped.

## Watch items

1. Mapbox CocoaPods EOL Dec 2026 → SPM migration.
2. Foursquare zero-caching compliance — fetch-fresh detail views.
3. Search Box intro pricing can ~4x.
4. Transitous no-SLA — transit ETAs must degrade gracefully.

## Escalations for Sean

- Mapbox account (free tier covers us; card likely required) — needed at P-3+.
- Foursquare developer account IF premium detail fields make MVP (else defer).
- Accept Transitous (community, no SLA) for v1 transit ETAs.
