# Specifications Directory

Feature/implementation specs — the **build contracts** agents implement against.
Written in P-2 (with Sean's approval gates), consumed by build phases. If
something isn't in a spec, it doesn't get built — unspecced behavior is an
escalation (`CLAUDE.md § Autonomy Contract`), not an improvisation.

## Directory structure

```
.specs/
├── README.md              # This file — format contract
├── product/               # Product-level specs (feature set, UX flows)
├── api/                   # API endpoint specifications
├── database/              # Schema specifications
├── shared/                # Shared package specifications (types, schemas, utils)
├── client/                # Client specs (screens, navigation, components)
└── design-system/         # Tokens, theming, component library
```

(Exact areas firm up with ADR-004 / P-2. One spec file per feature area.)

## Three-artifact format (per feature)

Substantial features get three sections (or three files for big ones):

1. **Requirements** — EARS-notation acceptance criteria, each with a stable ID:

   ```
   R-<area>-N: WHEN <condition/trigger> THE SYSTEM SHALL <behavior>
   ```

   Every criterion must be testable. Ambiguities are marked
   `[NEEDS CLARIFICATION: <specific question>]` — a spec is not approvable
   until zero markers remain.

2. **Design** — architecture, data model, API contracts, component interactions,
   edge-case behavior. Out-of-scope items listed **explicitly**.

3. **Tasks** — atomic implementation tasks, each traceable to requirement IDs,
   sized to one agent session (they become `T-N.M` rows in `docs/QUEUE.md`).

## API endpoint format

````markdown
### <METHOD> <PATH>

What it does. **Auth**: Required | Optional | None

**Request** / **Response <STATUS>** (typed shapes)

**Errors**: status — when

**Requirements covered**: R-xxx-N, R-xxx-M

**Tests required**:
- [ ] Happy path
- [ ] Error cases
- [ ] Authz (wrong user / wrong trip)
````

## How agents use specs

1. **Implementer** reads the spec → builds exactly that (types, validation,
   behavior) → writes every "Tests required" item.
2. **Reviewers** validate implementation against the spec — spec wins.
3. **The feature ledger** (`feature-ledger.json`, created in P-2) tracks
   verification per feature: `passes` flips only after evidence. Ledger
   entries are append-only — never removed or weakened.

## Updating specs

Specs are living documents, but changes are **scope changes**:

1. Update the spec file first (this may need Sean per the Autonomy Contract).
2. Queue the change as a `T-N.M` / `B-N` row.
3. Implement; PR references the spec section.

## Human review

Sean approves specs before implementation begins — that approval is what makes
autonomous building safe. Spec approval gates are listed in
`docs/PLANNING.md § P-2`.
