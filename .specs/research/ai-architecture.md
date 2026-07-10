# S-2 Research: AI Feature Architecture

> Evidence layer for the P-2 AI specs. Researched 2026-07-09 (web-verified).
> Confidence tags per finding. Prescriptive summary first.

## Recommendation (one-liner)

Claude single-vendor (**Haiku 4.5** default; **Sonnet 5** for recommendations +
recaps), ALL calls server-side in Hono with Zod-validated structured outputs
(`client.messages.parse()` + `zodOutputFormat` from
`@anthropic-ai/sdk/helpers/zod`), grounded in **Google Places API (New)** +
Wikipedia, destination-level response caching (14–30d TTL), **Batch API (50%
off)** for tour-guide pre-gen + recaps, per-user daily caps + global spend
kill-switch, offline tour bundles in SQLite. **~$30–60/mo at 1k MAU; budget
$100/mo.**

## Model + pricing facts (HIGH — official, 2026-07)

| Model | In / Out per 1M | Notes |
|-------|-----------------|-------|
| Claude Haiku 4.5 | $1 / $5 | Batch 50% off; prompt-cache min prefix 4,096 tokens |
| Claude Sonnet 5 | $3/$15 ($2/$10 intro thru 2026-08-31) | Structured outputs confirmed |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 | 10–20x cheaper floor — optional 1-day benchmark hedge |

- Structured-output limits (design Zod schemas around): no recursive schemas,
  no numeric min/max constraints (SDK strips + validates client-side) — keep
  schemas flat-ish.
- Prompt caching is a NON-lever (our system prompts < 4,096-token minimum);
  **response caching is the cost lever**: key =
  `hash(destination, travel_style, season, schema_version)`, shareable across
  users.

## Model per feature

| Feature | Model | Mode | Est. cost/call |
|---------|-------|------|----------------|
| Destination recommendations | Sonnet 5 | live, cached by destination | ~$0.022 |
| Expense estimation | Haiku 4.5 | live, cached by destination | ~$0.004 |
| Tour-guide POI content | Haiku 4.5 | **Batch at trip creation** | ~$0.0018 |
| Packing lists | Haiku 4.5 | live | ~$0.005 |
| Trip recap | Sonnet 5 | **Batch overnight post-trip** | ~$0.009 |

## Architecture (locked pattern)

```
Expo app → Hono (auth + rate limit) → cache check → [Places grounding] → Claude
        → Zod-validate → cache write → response
```

- Endpoints: `POST /ai/recommendations`, `/ai/expense-estimate`,
  `/ai/packing-list`, `/ai/recap`; internal job for tour-guide pre-gen at trip
  creation. **No keys in the app — non-negotiable.**
- Caps: **30 AI calls/user/day** (tighter than sibling repo's 150 — one abuser
  at 150 Sonnet calls/day ≈ $100/mo), per-feature ceilings, and a global
  monthly kill-switch (alert $50, hard-stop $100).

## Grounding (the decisive finding — HIGH)

- **Expedia killed Romie (2026) because answers weren't grounded in real-time
  data** (Skift). Raw-LLM itineraries: ~90% contain ≥1 error, ~25% recommend
  permanently closed attractions (HuffPost/UK study). Survivors (Kayak, Layla,
  Mindtrip) all: **LLM = language/curation layer; live APIs = truth.**
- GoGo pattern: Google Places API (New) Text Search Pro returns ~20 real
  places; LLM ranks/curates/annotates, **never invents venues**. Volatile facts
  (hours, prices, open-now) render from Places data at display time, never
  from LLM text. Even grounded products ship *reasoning* errors over correct
  data (Kayak nightly-vs-total price) — unit/date logic needs test coverage.
- Places pricing (HIGH): $32/1K Text Search Pro AFTER 5,000 free Pro calls/mo
  + 10,000 free Essentials calls (the $200 credit died March 2025). With
  destination caching (~400–500 grounding calls/mo) → **$0 at our scale.**
- Wikipedia/Wikidata free for tour-guide trivia (use authenticated requests —
  anonymous now 10 req/min). Foursquare paid tier worse at our scale, but
  their **fsq-os-places open dataset (100M POIs, Apache 2.0)** is a free
  future bulk layer. OpenTripMap free tier is non-commercial only — skip.

## Tour-guide UX

- **v1 = foreground-only location** (`watchPositionAsync` + distanceInterval,
  balanced accuracy, while tour screen active) — GuideAlong/VoiceMap pattern.
  Background geofencing deferred: iOS 20-region cap, needs "Always" permission
  + dev build, App Store friction. (Sean signed off implicitly via extras
  approval; re-confirm at P-2 spec gate.)
- **Offline bundles**: at trip creation, Batch-API fan-out per POI (grounded
  facts in-prompt) → server-validate → client downloads bundle keyed by
  `place_id` into expo-sqlite over wifi. On-tour lookup local, zero network.
  Evergreen narrative offline-safe; volatile facts online-only. (SmartGuide
  does exactly this — MEDIUM-HIGH.)

## Anti-hallucination prompt patterns (HIGH — Anthropic guidance + research)

1. External-knowledge restriction: "only use provided facts" + structured POI
   block in-prompt.
2. Explicit permission to answer "unknown".
3. Cite-or-retract: every claim references a provided fact ID or is dropped.
4. Volatile facts never from memory — API at render time.
5. Chain-of-Verification pass at pre-gen time (affordable in batch).
6. **Trap:** "answer concisely" cuts hallucination resistance up to 20%
   (Giskard Phare) — generate full, trim in post.

## Escalations for Sean (per Autonomy Contract §3)

1. Anthropic API paid account (~$50–100/mo budget) — required.
2. Google Cloud billing account for Places (card on file; usage stays free
   tier) — required.
3. Cap policy: 30/day + $100/mo kill-switch — sign-off.
4. Optional: 1-day Gemini Flash-Lite benchmark (10–20x cheaper floor).
5. v1 foreground-only location (no background geofencing) — sign-off.
