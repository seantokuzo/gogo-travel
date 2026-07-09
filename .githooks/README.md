# `.githooks/` — Repo-Tracked Git Hooks

Git hooks checked into the repo (so every clone gets the same nudges) instead of living in the local-only `.git/hooks/`.

## Setup (one-time per clone)

```bash
git config core.hooksPath .githooks
```

That points Git at this directory for hook lookups. Without it, the hooks are inert files on disk — Git ignores them. Run it once after cloning; the setting is per-clone, stored in `.git/config`.

## Currently shipped

| Hook | Type | Behavior |
|------|------|----------|
| `pre-commit` | Advisory (never blocks) | Warns when a new `docs/*.md` is being committed outside the 6-homes allowlist. Always exits 0 — the warning prints to stderr and the commit proceeds. |

The advisory model is intentional. Hard blocks would frustrate the "spec and walk away" UX; the nudge gives the user a chance to think without standing in the way of merges.

## Bypass once (if ever needed)

```bash
git commit --no-verify
```

Hooks here don't actually block, but `--no-verify` skips them entirely if you want zero output.

## Adding a new hook

1. Drop an executable script into `.githooks/` named after the Git lifecycle event (`pre-commit`, `commit-msg`, `pre-push`, etc.)
2. Use `#!/usr/bin/env bash` (or your preferred shebang) and `chmod +x` it
3. Default to **advisory** unless there's a strong case for a hard block — see rationale above
4. Document it in this README's "Currently shipped" table
5. If the hook references plan-doc conventions, link to `docs/decisions/ADR-001-naming-convention.md`

## Plan-doc context

Why does `pre-commit` care about `docs/*.md`? Plan-doc drift fragments the source of truth. The 6-homes convention is locked in:

- [`docs/decisions/ADR-001-naming-convention.md`](../docs/decisions/ADR-001-naming-convention.md) — full rationale
- [`.claude/rules/planning-doc-homes.md`](../.claude/rules/planning-doc-homes.md) — path-scoped rule that fires when Claude reads anything in `docs/`
