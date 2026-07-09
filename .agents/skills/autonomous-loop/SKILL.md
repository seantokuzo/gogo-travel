---
name: autonomous-loop
description: Sentinel-file protocol and session-end discipline for the gogo-travel autonomous chain mode. Read at the START of every autonomous-mode session and before writing any sentinel.
---

# Autonomous Loop — Sentinel Protocol and Discipline

> Source of truth for the chain-mode primitives. `CLAUDE.md` and `docs/SESSION-GUIDE.md` point HERE; do not re-state the contract elsewhere.

---

## 1. What this is

The **autonomous loop** is the "spec and walk away" primitive for `gogo-travel`. The human (PM/QA) writes a phase plan in `docs/QUEUE.md`, flips autonomous mode ON, and walks away. The loop:

1. Invokes `claude -p` non-interactively to do one session of work
2. Reads a small set of **sentinel files** in `.loop/` that the session leaves behind
3. Decides whether to chain another session, stop cleanly, or surface a problem to the human

It is **not** a daemon, **not** a watcher, **not** a scheduler. It is a `bash` `while` loop in `scripts/run-loop.sh` plus a Stop hook in `.claude/hooks/autonomous-handoff.sh` that enforces sentinel discipline.

---

## 2. When it's active

Autonomous mode is **ON if and only if `.loop/state.json` exists.** That file is the master switch. Both the chain wrapper and the Stop hook key off it:

- `scripts/run-loop.sh start` creates `.loop/state.json`
- `scripts/run-loop.sh stop` removes the entire `.loop/` directory
- `.claude/hooks/autonomous-handoff.sh` exits 0 immediately if `.loop/state.json` is absent — so interactive sessions are completely unaffected by the hook

If you, the assistant, ever notice that `.loop/state.json` does not exist, you are NOT in autonomous mode. Do not write sentinels. Behave as in a normal interactive session.

---

## 3. Sentinel protocol

All sentinels live in `.loop/` at the repo root. The directory is gitignored — it is per-machine runtime state.

| File | Type | Meaning |
|------|------|---------|
| `.loop/state.json` | JSON | Presence = autonomous mode ON. Updated every session. |
| `.loop/next-prompt.md` | Markdown | Instructions for the NEXT session in the chain. Non-empty → wrapper runs another iteration. |
| `.loop/done` | Empty marker | All queued work complete. Chain exits cleanly and tears `.loop/` down. |
| `.loop/pivot` | Markdown | Need human direction. Chain stops, `.loop/` preserved for inspection. |
| `.loop/blocked` | Markdown | Stuck on an external blocker. Chain stops with non-zero exit, `.loop/` preserved. |
| `.loop/log.txt` | Append-only | Timestamped activity log. Written by the wrapper and the hook. |

### Priority ordering

The chain wrapper and the Stop hook check sentinels in this order: `done` → `pivot` → `blocked` → `next-prompt.md`. The first match wins. If you accidentally write both `done` and `pivot`, `done` is honored — so **only write one terminal sentinel per session**.

---

## 4. Required session-end discipline

This is the single most important rule in this document. **At the end of every autonomous-mode session, you MUST do exactly one of:**

1. Write `.loop/done` (the chain is complete)
2. Write `.loop/pivot` with a human-facing message (you need direction)
3. Write `.loop/blocked` with a blocker description (something external is wrong)
4. Populate `.loop/next-prompt.md` with non-empty content (continue with the next session)

**If you forget, the Stop hook will auto-write `.loop/blocked` with a generic message.** That is not a feature you should rely on — it is a safety net. Auto-blocking means you failed at sentinel discipline and the human now has to figure out what state you left things in. Treat that outcome as a bug in your own behavior.

Before you stop, do a final check:

- [ ] Did I write `state.json` updates for `active_task`, `completed_this_session`, and `last_update`?
- [ ] Did I commit (or stage for commit) the actual work I did this session?
- [ ] Did I write exactly ONE of: `done`, `pivot`, `blocked`, or non-empty `next-prompt.md`?

---

## 5. `state.json` schema and maintenance

Initial contents (written by `scripts/run-loop.sh start`):

```json
{
  "active_phase": null,
  "active_task": null,
  "completed_this_session": [],
  "session_count": 0,
  "started_at": "2026-05-10T00:00:00Z",
  "last_update": "2026-05-10T00:00:00Z",
  "max_chain": 20
}
```

| Field | Maintained by | Notes |
|-------|----------------|-------|
| `active_phase` | You (each session) | e.g. `"P-3"`. Set when picking up work, clear when phase done. |
| `active_task` | You (each session) | e.g. `"T-3.2"`. The single task currently in flight. |
| `completed_this_session` | You (append) | Array of task IDs completed in this chain run. Append, never replace. |
| `session_count` | Wrapper | Incremented automatically after each iteration. |
| `started_at` | Wrapper | Written once at `start`. Never modify. |
| `last_update` | Wrapper + you | Wrapper bumps it; you may bump it too when you write meaningful state. |
| `max_chain` | Wrapper (default 20) | Hard cap on chain iterations. You may edit this if a phase legitimately needs more — but consider whether the plan needs smaller tasks. |

**How to update without clobbering:** prefer `jq` if available; otherwise read the file, change only the fields you own, write the whole object back. Never delete fields you didn't add.

---

## 6. When to write `done`

Write `.loop/done` (empty file is fine) when ALL of the following hold:

- Every task in `docs/QUEUE.md` for `active_phase` has `status: done`
- The phase row in `docs/PLANNING.md` is updated to `done`
- A phase archive exists at `docs/history/P-NNN-<slug>.md` capturing session-by-session notes
- Any PRs spawned by this phase are merged (or you have a defensible reason to leave them open — note that reason in `next-prompt.md`'s replacement, the final `done` write)
- The next phase (if any) is queued in `docs/PLANNING.md` for the human to greenlight

The wrapper will print `✅ Loop complete.` and `rm -rf .loop/` on `done`. There is no recovery — make sure you're actually done.

---

## 7. When to write `pivot`

Write `.loop/pivot` when you discover something that **changes the plan**:

- A locked decision (in an ADR) is wrong or insufficient for the work in front of you
- A task in the queue depends on something not in the queue
- Scope has exploded: a task you thought was 100 LOC is clearly 1000+
- An architectural call is needed that the human alone should make
- Two valid paths exist and the trade-off is non-obvious

**The `pivot` file body matters.** Write it as a message to the human:

```markdown
PIVOT — P-3 / T-3.2 partway through.

What I found: <one short paragraph>

Options I see:
1. <option A> — pros / cons
2. <option B> — pros / cons

Recommendation: <option + why>

Files to look at: <paths>
Relevant ADR: <if any>
```

**Always prefer `pivot` over silently going off-spec.** Going off-spec is a worse failure mode than asking — it's how chains burn the human's tokens producing work the human didn't want.

---

## 8. When to write `blocked`

Write `.loop/blocked` for **external** blockers — things you cannot resolve from inside a session:

- CI is broken in a way that requires human action (e.g. a secret is missing)
- A dependency is missing and adding it requires the human's call
- An auth token has expired
- The spec in `docs/PLANNING.md` is genuinely ambiguous and you need clarification
- A merge conflict is non-trivial and risks losing intent

Body shape:

```markdown
BLOCKED — <task ID>.

What blocked me: <one paragraph>

What I tried: <bullet list>

What the human needs to do: <bullet list>

Files for context: <paths>
```

Distinguish from `pivot`: `pivot` = "the plan is wrong"; `blocked` = "the plan is right but I can't proceed alone."

---

## 9. Constructing a good `next-prompt.md`

The next session has **no memory of this one**. Treat `next-prompt.md` as a handoff note to a competent stranger.

Checklist for every `next-prompt.md`:

- [ ] What was just done (1–2 lines; reference commit SHA if relevant)
- [ ] What's next (specific task ID from `docs/QUEUE.md`)
- [ ] Context the next session needs: file paths, recent decisions, gotchas
- [ ] Docs to re-read at session start: typically `CLAUDE.md`, `docs/QUEUE.md`, `docs/STATE.md`, this SKILL.md
- [ ] Any open questions the next session should be ready to answer (e.g. "if X is true, write pivot")

Template:

```markdown
Continue P-3 autonomous loop.

JUST DID: <one line> (commit <short SHA>).

NEXT: <task ID> — <one-line description>. See docs/QUEUE.md for full row.

CONTEXT:
- <file or path the next session should open first>
- <recent decision, gotcha, or constraint>
- <links to relevant ADRs or skills>

RE-READ:
- .agents/skills/autonomous-loop/SKILL.md (sentinel protocol)
- CLAUDE.md (project conventions)
- docs/QUEUE.md (current work queue)
- docs/STATE.md (recent state)

IF YOU FIND <X>: write `.loop/pivot` and stop. The plan assumed not-X.
```

A bad `next-prompt.md` (lossy, vague) produces a bad next session. A good one is the difference between a chain that lands cleanly and one that derails on iteration 3.

---

## 10. Opt-out signals from the human

If the human reappears mid-chain and types ANY of these in conversation, you **immediately** write `.loop/pivot` with a brief "user paused chain at <task>" message and stop:

- "stop", "pause", "wait", "halt"
- "I want to review this first"
- "let me look at X before you continue"
- Any explicit course-correction or new instruction that conflicts with the queue

Do not negotiate. Do not finish the current sub-step. Write `pivot`, surface the state, stop.

---

## 11. Hard caps

- **Max 20 chained sessions** by default (`max_chain` in `state.json`).
- If you reach iteration 20 without writing a terminal sentinel, the wrapper exits with `⛔ Hit max chain (20). Stopping for safety.`
- If a phase honestly needs more than 20 sessions, the **plan is wrong** — write `pivot` requesting the human re-plan with smaller tasks.

---

## 12. Smoke test (verify the loop works end-to-end)

Before trusting the loop with real work, run this once:

1. **Stage a trivial plan.** In `docs/QUEUE.md` add a fake phase `P-99` with two tasks: `T-99.1: create file FOO.tmp with body "hello"` and `T-99.2: delete FOO.tmp and write .loop/done`.
2. **Install the hook.** Confirm `.claude/settings.json` contains the Stop hook stanza (see §14).
3. **Start the loop:**
   ```bash
   scripts/run-loop.sh start --prompt "Read .agents/skills/autonomous-loop/SKILL.md, then docs/QUEUE.md. Execute P-99 to completion. Honor sentinel discipline."
   ```
4. **Watch:** the wrapper logs to stderr and to `.loop/log.txt`. You should see two iterations, then `✅ Loop complete.`
5. **Verify cleanup:** `.loop/` is gone, `FOO.tmp` is gone, `docs/QUEUE.md` shows `P-99` tasks marked `done` (revert this commit before doing real work).
6. **Failure path test:** repeat steps 3-4 but use a prompt that intentionally exits without writing any sentinel. Confirm the hook auto-writes `.loop/blocked` and the wrapper exits 1 with `🚧 Blocked:`.

If either path misbehaves, debug from `.loop/log.txt` before running real work.

---

## 13. State.json — full maintenance example

Suppose you start a session and `state.json` contains:

```json
{
  "active_phase": "P-3",
  "active_task": "T-3.4",
  "completed_this_session": ["T-3.1", "T-3.2", "T-3.3"],
  "session_count": 3,
  "started_at": "2026-05-10T12:00:00Z",
  "last_update": "2026-05-10T13:45:12Z",
  "max_chain": 20
}
```

You complete `T-3.4` and `T-3.5` in one session. End-of-session you write:

```json
{
  "active_phase": "P-3",
  "active_task": "T-3.6",
  "completed_this_session": ["T-3.1", "T-3.2", "T-3.3", "T-3.4", "T-3.5"],
  "session_count": 3,
  "started_at": "2026-05-10T12:00:00Z",
  "last_update": "2026-05-10T14:30:00Z",
  "max_chain": 20
}
```

`session_count` is wrapper-managed — leave it alone; the wrapper bumps it after this session exits. `last_update` you may bump too; either is fine.

Then populate `next-prompt.md` describing T-3.6, exit. The chain wrapper increments `session_count` to 4 and starts the next iteration.

---

## 14. Required hook setup (one-time)

The wrapper refuses to `start` if the Stop hook isn't installed. Add this to `.claude/settings.json` (merge with any existing `hooks` block):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/autonomous-handoff.sh"
          }
        ]
      }
    ]
  }
}
```

If you already have other Stop hooks, append `.claude/hooks/autonomous-handoff.sh` as another `command` entry in the existing `Stop[0].hooks` array — do not replace the array.

Verify the hook is executable:

```bash
ls -l .claude/hooks/autonomous-handoff.sh   # should show -rwxr-xr-x
```

---

## 15. Failure modes and recovery

| Symptom | Likely cause | Recovery |
|--------|--------------|----------|
| Wrapper exits with `🚧 Blocked: Session ended without writing a sentinel...` | A session ended without sentinel discipline; the hook auto-wrote `blocked`. | Read `.loop/log.txt`, inspect recent commits, fix root cause, `scripts/run-loop.sh stop` then `start` again. |
| Wrapper hits `⛔ Hit max chain (20)` | Plan too big or chain stuck in a loop. | Stop, inspect `state.json`, re-plan with smaller tasks, restart. |
| `next-prompt.md` empty and no sentinel | Bug in a session — should have been caught by the hook. | Read `state.json` for last known task; manually write `next-prompt.md` or `pivot`, restart. |
| Wrapper refuses to `start` ("already ON") | `.loop/` exists from a previous run that didn't terminate cleanly. | `scripts/run-loop.sh stop`, then `start`. |
| `claude` CLI exits non-zero with no sentinel | Likely a transient error (rate limit, network). | Wrapper exits with that rc; check `.loop/log.txt`, restart manually if appropriate. |

---

## 16. What this is NOT

- **Not a CI replacement.** CI still runs on PRs. The loop just chains sessions.
- **Not auto-merge.** PRs still go through the review pipeline in `CLAUDE.md`.
- **Not memory.** Each session is fresh context. `next-prompt.md` is the entire handoff.
- **Not a substitute for a good plan.** A chain that's running on a vague queue produces vague results faster.

When in doubt: stop the chain, re-plan in the queue, restart.
