# claude-prune

Recurring privacy cleanup for a **claude.ai consumer account**. Drives the site's own
backend API through a dedicated, headless Chrome profile. No npm dependencies, Node ≥ 22.

**Repo:** <https://github.com/alexmohr/claude-prune>

> **Unofficial tool.** Anthropic provides no public API for consumer chat data, so this
> drives claude.ai's private web API and DevTools. Endpoints can change or break without
> notice — expect breakage over time and check the issues. Use at your own risk; deletions
> are final in the app (server-side purge takes up to 30 days). The `AGENTS.md` documents
> the discovered API shape to make repairs straightforward.

## What it cleans

| Target | Rule |
|---|---|
| Web chats | every chat **not attached to a project** is deleted — regardless of whether it is normal, **archived, or pinned/starred** (project chats are never in scope; add `--keep="name"` for exceptions). Pinned chats live in a separate UI/API grouping, so they are enumerated from three sources (sidebar, archived, starred) and merged |
| Claude Code sessions (`/code`) | every **archived** session is deleted; active sessions are never touched |
| Routines/triggers | session-bound one-shots cascade-delete with their sessions automatically; optionally pass `--ids=<ids.json>` to verify/delete a known id list directly |

Important distinctions:
- **Pinning a chat does NOT protect it** from pruning — use `--keep="exact title"`.
- Chats are pruned by **project attachment**; code sessions are pruned by **archive state**.

## Setup (one-time login — the ONLY interactive step)

```sh
cd path/to/claude-prune        # your checkout location
./claude-prune --visible       # Chrome window opens -> log in to claude.ai -> tool confirms, closes
```

The session cookie lives in a private Chrome profile at `~/.claude-prune-profile`
(separate from your everyday Chrome). Never open that profile folder in another Chrome
while the tool runs (one Chrome per profile dir).

## Usage

```sh
./claude-prune                       # DRY-RUN: prints counts + sample titles, deletes nothing
./claude-prune --yes                 # actually deletes
./claude-prune --yes --keep="Chat A,Chat B"   # extra protected chat names (exact match)
./claude-prune --yes --no-chats      # sessions only
./claude-prune --yes --no-sessions   # chats only
./claude-prune --yes --ids=routines_export.json   # trigger ids: ["id",...] or [{id,name},...]
```

Convert an Anthropic data export's routines file to the `--ids` format:

```sh
python3 -c "import json;d=json.load(open('claude_code_cloud/routines.json'))['claude_code_cloud'];json.dump([{'id':x['routine_id'],'name':x.get('name')} for x in d],open('routines_export.json','w'))"
```

## Scheduling

```sh
# crontab -e — monthly on the 1st at 09:00 (replace <checkout> with your absolute checkout path)
0 9 1 * * <checkout>/claude-prune --yes >> <checkout>/logs/cron.log 2>&1
```

Prefer running the dry-run once first; `--yes` is irreversible in the app
(server-side purge takes up to 30 days).

## Login expiry

Claude sessions last weeks to months. On expiry the tool exits `2` with:
`NOT LOGGED IN — run: ./claude-prune --visible` — do that once, log in, done.

## Environment overrides

| Var | Default | Meaning |
|---|---|---|
| `PRUNE_PORT` | `9333` | CDP port of the automation Chrome |
| `PRUNE_PROFILE` | `~/.claude-prune-profile` | dedicated Chrome profile dir |
| `PRUNE_CHROME` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Chrome binary |
| `PRUNE_NODE` | `node` | node binary (must be ≥ 22) |
| `PRUNE_LOG_DIR` | `./logs` | report output dir |

## Exit codes

`0` ok · `2` not logged in (run `--visible`) · `3` Chrome/CDP/API failure (see report)

## Safety notes

- Chats attached to a project are structurally excluded from the delete targets.
- Only sessions with `status=archived` are deleted.
- Anthropic retention carve-outs outlive this tool: flagged content (up to 2y),
  trust & safety scores (up to 7y), training-pipeline data (up to 5y if model
  improvement was enabled). For account-level records consult Anthropic's privacy
  center and, if applicable, file a GDPR Art. 17 request with Anthropic support.
- Deleted content does NOT disappear from previously downloaded **data-export
  copies** — delete those yourself.
- Credentials pasted into chats can't be un-leaked by deletion: rotate anything
  that was ever posted (WiFi/MQTT/API keys).
- `logs/` contains YOUR chat/session titles and ids from your account — keep it
  out of version control (gitignored by default).

## License

MIT — see [LICENSE](LICENSE).
