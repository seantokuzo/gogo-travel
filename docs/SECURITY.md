# GoGo Travel — Security Posture

> Security findings table + fix order. One home for security state
> (see `.claude/rules/planning-doc-homes.md`). Threat-model detail lives in
> `docs/PLANNING.md § Security`; this file tracks concrete findings.

## Standing rules

- Secrets never in git. `.env` is gitignored. The `.env` deny rules block the file
  tools and recognized Bash file commands — `cat`/`head`/`tail`/`sed`/`tee`, `<`/`>`
  redirects, named-file reads (canary 2026-10-04, Claude Code 2.1.289). **Unnamed
  reads are NOT covered** — `grep -r`/`rg` from a parent dir, `source`, and scripts
  reach `.env` (B-29). OS sandbox for loop runs: planned under B-29, not built.
- Auth, payments/split-money surfaces, migrations, and release workflows are
  **sensitive paths** — any blocking finding on them escalates the review.
- Money is integer cents (or `Decimal`) — never float.

## Findings

| ID   | Date       | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status | Fixed in |
| ---- | ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| B-29 | 2026-09-15 | Medium   | `.claude/hooks/pre-tool-security.sh` applies `check_file_path` (by basename) only to `Read\|Write\|Edit\|MultiEdit\|NotebookEdit`. Its `Bash` branch runs `check_bash`, which covers catastrophic deletes and destructive git and nothing else, and the Grep/Glob tools are not hooked. Re-scoped 2026-10-04: the `Read(**/.env)` / `Read(**/.env.*)` deny rules DO bind the Bash file commands Claude Code recognizes (`cat`, `head`, `tail`, `sed`, `tee`), `<`/`>` redirect targets and named-file reads — a canary on Claude Code 2.1.289 denied `cat <dir>/.env` and `grep X <dir>/.env`. Still open: unnamed reads (`grep -r X .` run in the holding dir READ the canary file; same class: `rg`, `source .env`, scripts that open files themselves) and non-env secrets (`~/.ssh/id_rsa`, `~/.aws/credentials`), which have no deny rule. Fix path: OS-level sandbox for `scripts/run-loop.sh` sessions — planned, not built. Agent-tooling scope, not product runtime — no shipped surface is affected. See B-29 for the fix design and the rejected first attempt. | open   | —        |
