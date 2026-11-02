# AGENTS.md — claude-prune

Instructions for AI coding agents working in this repository.

## What this project is

A single-purpose CLI that prunes a claude.ai consumer account: project-less web chats
and archived Claude Code (`/code`) sessions. It automates claude.ai's own private
backend API through a DevTools-attached, dedicated headless Chrome profile — there is
no official Anthropic API for consumer chat data.

## Layout

- `claude-prune` — zsh wrapper: checks Node ≥ 22, execs the engine. The ONLY entrypoint users run.
- `claude-prune.mjs` — the entire engine: Chrome lifecycle, CDP client (raw WebSocket via
  Node globals), API shims, pruning logic. No build step, no dependencies.
- `logs/` — timestamped run reports (`claude-prune-*.log`). Generated, never committed.

## Hard rules (safety-critical, do not weaken)

1. **Dry-run is the default.** Mutating operations require the explicit `--yes` flag.
   Never add a mode that deletes without it. Never default `--yes` in cron examples
   without a warning.
2. **Project chats are untouchable.** Chat delete targets MUST exclude any chat with
   `project_uuid` set. Do not "simplify" this filter. Pinned/starred and archived
   chats ARE valid delete targets (pinning is not protection) — keep enumerating all
   three chat sources.
3. **Only archived code sessions.** Delete targets MUST be `status === 'archived'`
   from a fresh enumeration. Active sessions may be running user work.
4. **Session-bound triggers cascade-delete with sessions.** Do NOT bulk-delete triggers
   by listing `/v1/code/triggers` — that endpoint's shape/availability has changed
   before. Only individually-addressable ids from a user-supplied `--ids` file.
5. **Everything runs inside the page context.** All API calls are `fetch` executed via
   `Runtime.evaluate` on a claude.ai tab so that cookies apply. Keep URLs ABSOLUTE
   (`https://claude.ai/...`) — relative fetches break when the tab sits on a login
   redirect. Never try to export/extract session cookies to use outside the browser.
6. **Dedicated profile only.** Chrome runs with `--user-data-dir=$PRUNE_PROFILE`.
   Never attach to the user's default Chrome profile (macOS TCC + consent prompts
   + privacy). If CDP won't come up, tell the user to close other Chrome instances
   of that profile; do not kill arbitrary Chrome processes.
7. **Login expiry handling:** detect via failed `/api/organizations` and exit 2 with
   the `--visible` instruction. Never attempt to automate the login itself
   (credentials, captchas, MFA).

## API notes (learned empirically, keep current)

- Org discovery: `GET /api/organizations` → `[0].uuid`.
- Chat list: enumerated from THREE sources and merged by uuid (learned empirically —
  pinned/starred and archived chats do NOT reliably appear in the sidebar listing):
  1. `GET /api/organizations/{org}/chat_conversations?view=sidebar&tree=false` → flat array.
  2. `GET /api/organizations/{org}/chat_conversations_v2?limit=100&offset=N&consistency=strong&archived=true`
  3. `GET /api/organizations/{org}/chat_conversations_v2?limit=100&offset=N&consistency=strong&starred=true&archived=false`
  v2 variants may 404 on some account states — ignore variant errors, keep the merge lenient.
  Fields: `uuid`, `name`, `project_uuid` (NOT `project_id`), `is_starred` (pinned), `is_archived`.
- Chat delete: `DELETE /api/organizations/{org}/chat_conversations/{uuid}`.
- Code sessions: `GET /v1/code/sessions?statuses=archived&limit=100`, cursor-paginated
  via `next_cursor`; body shape `{data, next_cursor}`. Delete: `DELETE /v1/code/sessions/{id}`
  (ids look like `cse_…`). Requires headers `anthropic-version: 2023-06-01` and
  `x-organization-uuid`.
- Triggers: `DELETE /v1/code/triggers/{trig_…}` works and returns an API error envelope
  (`not_found_error`) for unknown ids — treat 404-envelope as "already gone", plain
  `404 page not found` as "route missing". The list endpoint `GET /v1/code/triggers`
  has 404'd for the same account state that leaves DELETE working.
- A "Channel Root" agent (`/v1/code/agents`) CANNOT be deleted (`cannot_delete_root_agent`)
  — do not add agent deletion.
- 429/5xx: retry once after ≥ 2s; keep pacing ≥ 250ms between deletes.

## Conventions

- Plain ESM, no dependencies, no TypeScript. Node ≥ 22 (global `WebSocket`).
- All server-side effects are logged line-by-line to `logs/claude-prune-<ts>.log`
  (DELETED / ALREADY_GONE / FAILED + summary). Keep that audit trail.
- Failures never throw out of the run: record, set exit code 3, continue.
- Test changes with dry-runs only:
  `./claude-prune` against the live account is safe. Never run `--yes` while testing
  unless the user explicitly asks. A clean-profile dry-run exiting with
  `NOT LOGGED IN (403)` exit 2 is the expected smoke test when no session exists.
- Update README.md's usage/env tables whenever flags or env vars change.
