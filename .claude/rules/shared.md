---
paths: ["packages/**"]
---

# packages/* — Shared Contracts & Tokens

- `@gogo/shared` is the single source of truth for wire types: Zod schema → `z.infer` type. Hand-written duplicate interfaces are a blocking finding (R-shared-1).
- Enum pattern (R-shared-2): export (a) readonly const tuple, (b) `z.enum` from it, (c) inferred union. Server builds Drizzle `pgEnum` from the SAME tuple.
- **Platform-agnostic** (R-shared-9): no `react`, `react-native`, `expo-*`, `node:*`, or I/O imports. Platform-bound things (fetch/storage/clock/token) enter via injected interfaces.
- **Money = `Cents`** (int, ≥ 0 — Law #2) paired with `CurrencyCode`; floats fail validation. Dates on the wire are ISO-8601 strings, never epoch/`Date` (R-shared-11).
- AI structured-output schemas (R-shared-7): no recursion, no numeric `.min()`/`.max()`, ≤ 3 nesting levels; ranges/cross-field rules enforced by server-side refiners. Shape change ⇒ bump `SCHEMA_VERSION` (R-shared-8).
- Module shape (R-shared-14): per domain export `XSchema` + `type X` + owned tuples; subpath exports; `"sideEffects": false`; tree-shakeable.
- `@gogo/tokens` = design tokens/themes only (P-4 spec: `.specs/design-system/tokens.spec.md`) — also platform-agnostic, no React.
- Toolchain: TS 5.9.3 strict (root base), vitest pinned 4.1.10, tests colocated `src/*.test.ts`, build = `tsc` → `dist/` (consumers import `dist`, so `pnpm build` after contract changes).
- Full spec: `.specs/shared/contracts.spec.md` — behavior not covered there is an escalation, not an improvisation (Law #4).
