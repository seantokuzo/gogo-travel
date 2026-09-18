# GoGo Travel — Security Posture

> Security findings table + fix order. One home for security state
> (see `.claude/rules/planning-doc-homes.md`). Threat-model detail lives in
> `docs/PLANNING.md § Security`; this file tracks concrete findings.

## Standing rules

- Secrets never in git. `.env` is gitignored and hook-blocked from the Read
  tool. **Bash is NOT covered** — `cat .env` reaches the model (B-29).
- Auth, payments/split-money surfaces, migrations, and release workflows are
  **sensitive paths** — any blocking finding on them escalates the review.
- Money is integer cents (or `Decimal`) — never float.

## Findings

| ID   | Date       | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status | Fixed in |
| ---- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| B-29 | 2026-09-15 | Medium   | `.claude/hooks/pre-tool-security.sh` applies `check_file_path` only to `Read\|Write\|Edit\|MultiEdit\|NotebookEdit`. Its `Bash` branch runs `check_bash`, which covers catastrophic deletes and destructive git and nothing else, so `cat .env`, `grep KEY .env`, `cat ~/.ssh/id_rsa` and `cat ~/.aws/credentials` are all allowed. `permissions.deny` does not close it: `Read(...)` rules bind the Read tool only. Agent-tooling scope, not product runtime — no shipped surface is affected. See B-29 for the fix design and the rejected first attempt. | open   | —        |
