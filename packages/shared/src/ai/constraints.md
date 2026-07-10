# AI structured-output constraints (contracts spec §3.7 — colocated for implementers)

Every schema in `src/ai/*` that is used as a Claude structured-output format
(`client.messages.parse()` + `zodOutputFormat`) MUST obey these rules.
`constraints.test.ts` walks each exported schema and enforces them
mechanically — if your change fails that test, fix the schema, not the test.

1. **No recursion.** No `z.lazy`, no self-references. Nesting ≤ 3 object
   levels; prefer arrays of flat objects.
2. **No numeric range constraints** (`.min` / `.max` / `.gt` / `.lt` /
   `.nonnegative` / `.positive` on numbers) — the SDK strips them silently.
   Instead each module exports a paired `refine<X>(parsed)` server-side step
   that enforces ranges and cross-field rules after parsing. A thrown
   `AiRefinementError` is treated as a parse failure (retry once →
   `AI_UPSTREAM`). String formats (regex, length, uuid, ISO dates) are fine.
3. **Every module exports `SCHEMA_VERSION: number`** — bump it on ANY shape
   change. It feeds `deriveAiCacheKey()` (R-shared-8; schema spec R-db-10),
   so stale cached shapes can never be parsed against new schemas.
4. **Grounding lives in the shape.** Generative schemas that mention venues
   reference provided `place_id`s from our spine (the prompt's candidate
   list) — inventing venues is unrepresentable. Facts carry `source_ref`s
   that must resolve (cite-or-retract; the refiner drops unresolvable ones).
5. **Permission to not know.** Fields are optional / omissible wherever
   facts may be missing — an incomplete answer is correct, an invented one
   is wrong. No volatile-fact fields (hours, prices, ratings) exist at all.

Cache-key derivation (`cache-key.ts`) is user-anonymous by construction:
`sha256(feature ∥ destination ∥ travel_style ∥ season ∥ schema_version)` —
no user or trip id is ever a key input (R-db-10).
