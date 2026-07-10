# S-2 Research: Competitor Teardown

> Evidence layer for P-2 product specs. Researched 2026-07-09, adversarially
> verified (~160 sourced claims, 3 verify agents). Market state: July 2026.

## Market context (one paragraph)

TripCase is dead (Sabre sunset 2025-04-01, deleted all user data). TripIt is
the reliable-but-ancient incumbent ("enterprise software trapped in 2012").
Wanderlog owns collaborative day planning. AI-first newcomers (Mindtrip ~$22.5M
raised; Layla 5M+ users) monetize booking commissions, not planning. Google is
absorbing trip planning piecemeal (Gemini/Ask Maps) but has no dedicated trip
product. **Stippl is the only competitor attempting our exact all-in-one thesis
— and its execution is bad (33/100 review sentiment, crashes, can't edit trips
after creation). The all-in-one slot is validated demand with no good
execution.**

## Top-line prescriptive calls

1. **Lead with expense splitting + Venmo/Zelle handoff** — verified unoccupied
   by EVERY planner (Wanderlog/Stippl track who-owes-who but have no payment
   handoff; Splitwise itself caps free entries + Venmo is US-only there). It's
   also the group-install network-effect feature.
2. **Offline + collaboration free forever; monetize alerts + AI.** Offline is
   paywalled everywhere planning is good (Wanderlog Pro, Stippl Pro,
   Roadtrippers top tier) and users hate it — TripIt's free static offline is
   the exception that proves it. What users actually pay for: TripIt Pro's
   flight alerts ($49/yr) that beat airline apps.
3. **Capture UX = share-sheet + screenshot + ONE permanent forward address
   (never per-trip — Wanderlog's per-trip scheme is a documented usability
   failure), instant parse-reply (<1 min — TripIt's trust mechanism). Parse
   schema.org JSON-LD first (deterministic, free), LLM second. Failures land
   in a visible "needs review" queue (Tripsy pattern), never silently dropped
   (TripIt's documented sin). Skip OAuth inbox scanning at MVP** (24h latency,
   primary-inbox-only, privacy friction).
4. **Two itinerary surfaces**: plan mode (Wanderlog's day-sectioned drag-drop
   list + persistent map + inline travel times — the category's most-praised
   pattern, and free there so free here) and **today mode** (TripIt's
   chronological what's-next timeline + leave-by prompts; auto-switch when the
   trip starts). **Plus the calendar-grid view NOBODY has** — HN users
   explicitly ask for gap/overlap exposure. Cheap differentiation.
5. **AI = grounded tools** (expense estimation — which NOBODY does; schedule
   sanity checks; in-trip guide on your actual itinerary), NOT generic
   "AI, plan me a trip" — that's commoditized (Kayak/Google/Mindtrip) and its
   hallucination rap is the category's loudest AI complaint.
6. **Deeplink round-trip capture is genuinely novel**: planners deeplink OUT
   for affiliate revenue, nobody captures the completed booking BACK. Pair
   deeplink-out with a "did you book? screenshot/forward it" prompt on app
   return.
7. **Watch Mindtrip (Sabre+PayPal agentic booking) and Google (Ask Maps,
   Canvas), not TripIt** — TripIt is the share donor.

## What users love most (steal these)

1. Email-forward auto-import "magic" (TripIt's killer feature per HN).
2. Flight alerts that beat the airline (1:45am cancellation alerts; what
   people pay for).
3. Map-beside-itinerary with travel times ("saved me from crossing the city
   four times a day") — Wanderlog's moat, free there.
4. Free real-time collaboration (Wanderlog, pledged free forever).
5. Effortless memory capture (Polarsteps: 5M→20M travelers on auto
   route/photo journaling alone). Journaling lives in SEPARATE apps from
   planning today — merging them is an opening.

## Loudest complaints (our openings)

1. Offline paywalled everywhere → ship it free.
2. TripIt's template parser misses/duplicates; Inbox Sync has up-to-24h lag →
   LLM-grade parsing with instant feedback wins.
3. Fragmentation: users run TripIt + Wanderlog + Splitwise + Google Maps
   simultaneously → our core thesis, validated.
4. Subscription fatigue (Roadtrippers' 3-stop free tier "completely useless")
   → generous free tier, paywall only genuinely costly things.
5. AI planners hallucinate (closed attractions, private homes); the one
   all-in-one rival is unstable → grounded AI + boring reliability wins.

## Feature-matrix highlights (who's best per our feature)

- Bookings-by-category parsing: **TripIt** widest (flights/hotels/cars/trains/
  shuttles/cruises/OpenTable/Eventbrite/StubHub). Nobody models moped/scooter
  rentals — ownable niche.
- Maps + travel times: **Wanderlog** benchmark (free inline times,
  drive/walk/transit).
- Budgeting: Wanderlog free w/ categories + multi-currency; Stippl graphs;
  **AI expense estimation: NOBODY** — open lane.
- Photos/journaling: **Polarsteps** owns it (auto route tracking), but it's a
  separate app from planning.
- Live-trip: **TripIt Pro** benchmark (Go Now leave-by prompts, real-time
  alerts). No planning-first app does day-of well.
- Collab: **Wanderlog** best-in-class, free, Google-Docs-style.
- Nav: never replace the nav app — one-tap handoff to Google/Apple Maps from
  every item (Wanderlog pattern).
- Map-first UX only works for road trips (Roadtrippers) — make it a mode, not
  the default.

## Notable capture-tech state of the art

- schema.org JSON-LD in confirmation emails (deterministic parse path).
- On-device LLM extraction (TripIt × Apple Intelligence, Pro + iPhone 15 Pro+
  only).
- Social-link extraction (Mindtrip: TikTok/IG/YouTube link → itinerary).
- Everyone else: email forwarding (Kayak free + Gmail sync; Tripsy Pro-gated
  with pending-queue fallback).

## Verification notes

- REFUTED in verify pass: "TripIt sharing is view-only" (it has view/edit
  permissions — but it's reservation-sharing, not co-planning).
- UNCLEAR: TripIt Inbox Sync free-vs-Pro tiering (TripIt's own docs conflict).
- CORRECTED: Stippl "offline free" → actually Pro-gated.
