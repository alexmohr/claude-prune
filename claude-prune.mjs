#!/usr/bin/env node
// claude-prune — recurring privacy cleanup for a claude.ai consumer account.
//
// What it does (mirrors the manual cleanup of 2026-11-02):
//   1. Chats:    deletes every chat NOT attached to a project (chats with project_uuid are always kept;
//                additional name-based keeps via --keep="exact name,another")
//   2. Sessions: deletes every ARCHIVED Claude Code (claude.ai/code) session; active sessions untouched
//   3. Triggers: optional — verifies/deletes trigger ids from a data-export routines file (--ids=export_routines.json)
//
// Login model: dedicated Chrome profile.
//   ./claude-prune --visible   # once (or when session expires): a Chrome window opens, log in, done
//   ./claude-prune             # dry-run: print what would be deleted, change nothing
//   ./claude-prune --yes       # actually delete
//   --headful                  # run the whole flow in a visible window (needed while Cloudflare blocks headless)
//   --sessions-older-than=N    # only delete archived code sessions last updated >= N days ago
//   --opencode                 # also prune the LOCAL OpenCode store (~/.local/share/opencode/opencode.db):
//   --opencode-older-than=N    #   sessions last updated >= N days ago (default 10); the current session and its
//   --opencode-vacuum          #   lineage are always kept; --opencode-vacuum reclaims DB space afterwards
//   --copilot                  # also prune the LOCAL GitHub Copilot CLI store (~/.copilot: session-store.db,
//   --copilot-older-than=N     #   session-state/, metadata cache); sessions older than N days (default 10)
//   --copilot-vscode           #   + delete stale Copilot Chat session files in VS Code workspaceStorage
//
// No npm deps. Node >= 22. Google Chrome at /Applications (override with PRUNE_CHROME).
// Exit codes: 0 ok, 2 not logged in (run --visible), 3 chrome/cdp problem.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PRUNE_PORT || 9333);
const PROFILE = process.env.PRUNE_PROFILE || path.join(os.homedir(), '.claude-prune-profile');
const CHROME = process.env.PRUNE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOG_DIR = process.env.PRUNE_LOG_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'logs');
const argv = process.argv.slice(2);
const YES = argv.includes('--yes');
let VISIBLE = argv.includes('--visible');
let HEADFUL = argv.includes('--headful'); // run the whole prune in a visible window (Cloudflare blocks headless on some accounts)
const SKIP_CHATS = argv.includes('--no-chats');
const SKIP_SESSIONS = argv.includes('--no-sessions');
const KEEP = (argv.find(a => a.startsWith('--keep=')) || '').replace(/^--keep=/, '').split(',').map(s => s.trim()).filter(Boolean);
const IDS_FILE = (argv.find(a => a.startsWith('--ids=')) || '').replace(/^--ids=/, '');
const SESS_MAX_AGE = argv.some(a => a.startsWith('--sessions-older-than=')) ? Number(argv.find(a => a.startsWith('--sessions-older-than=')).replace(/^--sessions-older-than=/, '')) : null;
const OPENCODE = argv.includes('--opencode');           // also prune the local OpenCode session store (no browser)
const OPENCODE_VACUUM = argv.includes('--opencode-vacuum');
const OC_MAX_AGE = argv.some(a => a.startsWith('--opencode-older-than=')) ? Number(argv.find(a => a.startsWith('--opencode-older-than=')).replace(/^--opencode-older-than=/, '')) : 10;
const OC_DB = process.env.PRUNE_OPENCODE_DB || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
const COPILOT = argv.includes('--copilot');            // also prune the local GitHub Copilot CLI store (~/.copilot)
const CP_VSCODE = argv.includes('--copilot-vscode');   //   + old Copilot Chat sessions from VS Code workspaceStorage
const CP_MAX_AGE = argv.some(a => a.startsWith('--copilot-older-than=')) ? Number(argv.find(a => a.startsWith('--copilot-older-than=')).replace(/^--copilot-older-than=/, '')) : 10;
const CP_DB = process.env.PRUNE_COPILOT_DB || path.join(os.homedir(), '.copilot', 'session-store.db');
const CP_HOME = path.dirname(CP_DB);
const VS_WS = process.env.PRUNE_VSCODE_WS || path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');

fs.mkdirSync(LOG_DIR, { recursive: true });
const logPath = path.join(LOG_DIR, 'claude-prune-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(logPath, s + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- chrome lifecycle ----------
async function cdpVersion() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}
async function ensureChrome() {
  try { return await cdpVersion(); } catch {}
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    // Cloudflare binds cf_clearance to the user-agent: headless mode's default UA says
    // "HeadlessChrome", so a clearance minted by a --visible/--headful login is instantly
    // invalid for later headless runs (403 even though the profile IS logged in). Force one
    // uniform UA for every mode; keep the version in sync with the installed Chrome.
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.89 Safari/537.36',
    ...(VISIBLE || HEADFUL ? [] : ['--headless=new']),
    'https://claude.ai/new',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(path.join(PROFILE, '.claude-prune.pid'), String(child.pid));
  for (let i = 0; i < 60; i++) { try { return await cdpVersion(); } catch { await sleep(500); } }
  throw new Error('Chrome did not expose CDP on port ' + PORT + '. Is the profile open in another Chrome? (one Chrome per profile dir)');
}
async function flushBrowserState() {
  // hand cookies back to Chrome and close it GRACEFULLY over CDP: a raw SIGTERM can drop
  // a just-acquired session cookie before it is persisted to the profile (lost login)
  try { await cdp('Storage.setCookies', { cookies: await cdp('Storage.getCookies') }); } catch {}
  try { await cdp('Browser.close'); } catch {}
}
async function killChrome() {
  const pidFile = path.join(PROFILE, '.claude-prune.pid');
  if (!fs.existsSync(pidFile)) return;
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
  for (let i = 0; i < 10; i++) { try { await cdpVersion(); await sleep(400); } catch { return; } }
}

// ---------- CDP client over global WebSocket ----------
let ws, msgId = 0;
const pending = new Map();
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('CDP timeout: ' + method)); }, 60000);
  });
}
async function connectCdp(wsUrl) {
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('WS connect failed'))); });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error).slice(0, 200))); else resolve(m.result);
    }
  });
}
async function openClaudeTab() {
  let t, deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp('Target.getTargets');
    t = targetInfos.find(x => x.type === 'page' && x.url.startsWith('https://claude.ai'));
    if (!t) { await cdp('Target.createTarget', { url: 'https://claude.ai/new' }); await sleep(1500); continue; }
    break;
  }
  if (!t) throw new Error('no claude.ai tab materialized (network/offline? see the automation window with --visible)');
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  // wait until the page is actually on claude.ai and loaded
  for (let i = 0; i < 40; i++) {
    try {
      const r = await cdp('Runtime.evaluate', { expression: 'JSON.stringify({href:location.href,done:document.readyState==="complete"})', returnByValue: true }, sessionId);
      const s = JSON.parse(r.result.value);
      if (s.done && s.href.startsWith('https://claude.ai')) return sessionId;
    } catch {}
    await sleep(1000);
  }
  return sessionId;
}
async function evaluate(sid, expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 55000 }, sid);
  if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return JSON.parse(r.result.value);
}

// ---------- claude.ai backend calls (issued from the page so cookies apply) ----------
const B = 'https://claude.ai';
const hdr = org => `const H={accept:'application/json','anthropic-version':'2023-06-01','x-organization-uuid':'${org}','cache-control':'no-cache'};`;

async function loginCheck(sid) {
  return evaluate(sid, `(async()=>{try{const r=await fetch('${B}/api/organizations',{headers:{accept:'application/json'}});if(r.status!==200)return JSON.stringify({ok:false,status:r.status});const j=await r.json();return JSON.stringify({ok:true,org:(j&&j[0]&&j[0].uuid)||null});}catch(e){return JSON.stringify({ok:false,error:String(e)});}})()`);
}

async function listChats(sid, org) {
  const seen = new Map();
  // source 1: sidebar listing (the classic endpoint)
  const base = await evaluate(sid, `(async()=>{${hdr(org)}const r=await fetch('${B}/api/organizations/${org}/chat_conversations?view=sidebar&tree=false',{headers:H});if(r.status!==200)return JSON.stringify({error:'http '+r.status});const j=await r.json();const arr=Array.isArray(j)?j:(j.conversations||j.chat_conversations||[]);return JSON.stringify(arr.map(c=>({uuid:c.uuid,name:c.name||'',project:c.project_uuid||null,archived:!!c.is_archived,starred:!!c.is_starred,src:'sidebar'})));})()`);
  const merge = arr => { for (const c of (arr || [])) if (c && c.uuid && !seen.has(c.uuid)) seen.set(c.uuid, c); };
  if (base.error) return { error: base.error };
  merge(base);
  // sources 2+3: v2 endpoint variants for ARCHIVED and PINNED/STARRED chats —
  // these may not appear in the sidebar listing (learned from UI count mismatch).
  for (const variant of ['archived=true', 'starred=true&archived=false']) {
    for (let offset = 0; offset < 1000; offset += 100) {
      const v = await evaluate(sid, `(async()=>{${hdr(org)}const r=await fetch('${B}/api/organizations/${org}/chat_conversations_v2?limit=100&offset=${offset}&consistency=strong&${variant}',{headers:H});if(r.status!==200)return JSON.stringify({error:'http '+r.status});const j=await r.json();const arr=j.conversations||j.chat_conversations||(Array.isArray(j)?j:[]);return JSON.stringify(arr.map(c=>({uuid:c.uuid,name:c.name||'',project:c.project_uuid||null,archived:!!c.is_archived,starred:!!c.is_starred,src:'v2:${variant}'})));})()`);
      if (v.error) break; // endpoint variant unsupported — fine, sidebar may already cover it
      merge(v);
      if (!v.length) break;
    }
  }
  return { total: seen.size, items: [...seen.values()] };
}
const deleteChat = (sid, org, uuid) => evaluate(sid, `(async()=>{${hdr(org)}try{const r=await fetch('${B}/api/organizations/${org}/chat_conversations/${uuid}',{method:'DELETE',headers:H});return JSON.stringify({status:r.status});}catch(e){return JSON.stringify({error:String(e)});}})()`);

async function listArchivedSessions(sid, org) {
  return evaluate(sid, `(async()=>{${hdr(org)}let cursor=null,items=[],guard=0;while(guard++<60){let u='${B}/v1/code/sessions?statuses=archived&limit=100';if(cursor)u+='&cursor='+encodeURIComponent(cursor);const r=await fetch(u,{headers:H});if(r.status!==200)return JSON.stringify({error:'http '+r.status});const j=await r.json();const arr=j.data||j.sessions||(Array.isArray(j)?j:[]);items=items.concat(arr.map(s=>({id:s.id||s.session_id,title:(s.title||'').slice(0,60),status:s.status,updated:s.updated_at||s.last_updated||s.created_at||null})));cursor=j.next_cursor||null;if(!cursor||!arr.length)break;}return JSON.stringify({total:items.length,items});})()`);
}
const deleteSession = (sid, org, id) => evaluate(sid, `(async()=>{${hdr(org)}try{const r=await fetch('${B}/v1/code/sessions/${id}',{method:'DELETE',headers:H});return JSON.stringify({status:r.status});}catch(e){return JSON.stringify({error:String(e)});}})()`);

const deleteTrigger = (sid, org, id) => evaluate(sid, `(async()=>{${hdr(org)}try{const r=await fetch('${B}/v1/code/triggers/${id}',{method:'DELETE',headers:H});return JSON.stringify({status:r.status});}catch(e){return JSON.stringify({error:String(e)});}})()`);

// ---------- local OpenCode session store (SQLite; no browser) ----------
async function opencodePrune() {
  log('OPENCODE: db=' + OC_DB);
  if (!fs.existsSync(OC_DB)) { log('OPENCODE: database not found — skipping'); return 0; }
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(OC_DB);
  } catch (e) {
    log('OPENCODE: cannot open sqlite database (' + e + ') — node:sqlite requires Node >= 22.13; skipping');
    return 3;
  }
  try {
    db.exec('PRAGMA busy_timeout=8000');
    const cutoff = Date.now() - OC_MAX_AGE * 86400e3;

    // protection: the current session's whole lineage (ancestors+descendants) — never self-prune
    const protect = new Set();
    const self = process.env.OPENCODE_SESSION_ID;
    if (self) for (const t of ['session', 'session_v2'])
      for (const dir of ['up', 'down'])
        for (const r of db.prepare(`WITH RECURSIVE tree(id) AS (
            SELECT ?1 UNION SELECT ${dir === 'up' ? 's.parent_id' : 's.id'} FROM ${t} s JOIN tree ON ${dir === 'up' ? 's.id = tree.id' : 's.parent_id = tree.id'}
            ${dir === 'up' ? 'WHERE s.parent_id IS NOT NULL' : ''}) SELECT id FROM tree`).all(self)) protect.add(r.id);

    const rows = [];
    for (const t of ['session', 'session_v2'])
      for (const r of db.prepare(`SELECT id, title, time_updated, directory FROM ${t}`).all())
        rows.push({ id: r.id, title: r.title || '', dir: r.directory || '', upd: r.time_updated });

    let recent = 0, selfP = 0;
    const targets = new Map();
    for (const x of rows) {
      if (protect.has(x.id)) { selfP++; continue; }
      if (!x.upd || x.upd >= cutoff) { recent++; continue; }
      targets.set(x.id, x);
    }
    // cascade: children/descendants of a target session go with it (orphans would be unusable)
    let grew = true;
    while (grew) {
      grew = false;
      const ids = [...targets.keys()];
      for (const t of ['session', 'session_v2']) {
        const q = `SELECT id FROM ${t} WHERE parent_id = ?1`;
        for (let i = 0; i < ids.length; i++)
          for (const r of db.prepare(q).all(ids[i]))
            if (!targets.has(r.id) && !protect.has(r.id)) { targets.set(r.id, { id: r.id, title: r.title || '(cascade)', dir: r.directory || '', upd: r.time_updated }); grew = true; }
      }
    }
    log(`OPENCODE: total=${rows.length} skip(recent <${OC_MAX_AGE}d or no timestamp)=${recent} skip(current session lineage)=${selfP} target=${targets.size}`);
    if (!targets.size) return 0;
    const tlist = [...targets.values()];
    if (!YES) {
      for (const x of tlist.slice(0, 25))
        log('  TARGET: ' + new Date(x.upd ?? 0).toISOString().slice(0, 10) + '  ' + x.dir.replace(os.homedir(), '~') + '  ' + x.title.slice(0, 60));
      log(`  (dry-run) ${targets.size} sessions older than ${OC_MAX_AGE} days would be deleted. Re-run with --yes.`);
      return 0;
    }

    const ids = [...targets.keys()];
    // explicit cleanup of every session-keyed table (FK cascades are per-connection in SQLite — don't rely on them).
    // Discover the tables/columns from the live schema: OpenCode renames tables between versions
    // (e.g. `schedule` -> `automation`), so a hard-coded list breaks.
    const CHILD = [];
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('session','session_v2')").all())
      for (const c of db.prepare(`PRAGMA table_info('${t.name}')`).all())
        if (c.name === 'session_id' || c.name === 'child_session_id') CHILD.push([t.name, c.name]);
    const t0 = Date.now();
    for (let i = 0; i < ids.length; i += 400) {
      // one transaction per chunk: keeps the write lock short so a running OpenCode server is not starved
      db.exec('BEGIN IMMEDIATE');
      const chunk = ids.slice(i, i + 400);
      const ph = '(' + chunk.map(() => '?').join(',') + ')';
      for (const [tbl, col] of CHILD)
        db.prepare(`DELETE FROM ${tbl} WHERE ${col} IN ${ph}`).run(...chunk);
      db.prepare(`DELETE FROM session_v2 WHERE id IN ${ph} OR fork_session_id IN ${ph}`).run(...chunk, ...chunk);
      db.prepare(`DELETE FROM session WHERE id IN ${ph}`).run(...chunk);
      db.exec('COMMIT');
      await sleep(50);
    }
    let files = 0;
    const diffDir = path.join(path.dirname(OC_DB), 'storage', 'session_diff');
    if (fs.existsSync(diffDir)) for (const id of ids) { const f = path.join(diffDir, id + '.json'); if (fs.existsSync(f)) { fs.rmSync(f); files++; } }
    for (const x of tlist) log('  DELETED ' + x.id + ' ' + new Date(x.upd ?? 0).toISOString().slice(0, 10) + ' ' + x.title.slice(0, 60));
    log(`  OPENCODE DELETED=${ids.length} sessions, session_diff files removed=${files} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    const remaining = db.prepare('SELECT (SELECT COUNT(*) FROM session) + (SELECT COUNT(*) FROM session_v2) AS n').get().n;
    log('  OPENCODE remaining sessions=' + remaining);
    if (OPENCODE_VACUUM) {
      const before = fs.statSync(OC_DB).size;
      db.exec('VACUUM');
      log(`  OPENCODE VACUUM: ${Math.round(before / 1e6)}M -> ${Math.round(fs.statSync(OC_DB).size / 1e6)}M`);
    } else {
      log('  (tip: --opencode-vacuum reclaims the space in the DB file)');
    }
    return 0;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    log('OPENCODE: FAILED ' + (e && e.stack || e));
    return 3;
  } finally {
    try { db.close(); } catch {}
  }
}

// ---------- local GitHub Copilot CLI store (SQLite + session-state dirs; no browser) ----------
function maxMtime(dir) {
  let m = fs.statSync(dir).mtimeMs;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? maxMtime(p) : fs.statSync(p).mtimeMs);
  }
  return m;
}
async function copilotPrune() {
  log('COPILOT: db=' + CP_DB);
  const cutoff = Date.now() - CP_MAX_AGE * 86400e3;
  const ids = [];
  let db = null;
  try {
    if (fs.existsSync(CP_DB)) {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(CP_DB);
      db.exec('PRAGMA busy_timeout=8000');
      for (const r of db.prepare('SELECT id, cwd, updated_at, summary FROM sessions').all()) {
        const t = Date.parse(r.updated_at || '');
        if (!Number.isFinite(t) || t >= cutoff) { log('  KEEP(recent/undated): ' + (r.updated_at || '?') + '  ' + r.id); continue; }
        ids.push(r.id);
        log('  TARGET: ' + (r.updated_at || '').slice(0, 10) + '  ' + String(r.cwd || '?').replace(os.homedir(), '~') + '  ' + String(r.summary || '').replace(/\s+/g, ' ').slice(0, 60));
      }
    } else log('COPILOT: no session-store.db — db part skipped');
  } catch (e) {
    db = null;
    log('COPILOT: cannot open sqlite database (' + e + ') — db part skipped');
  }
  // orphan session-state dirs (no DB row at all): age-gated like everything else
  const dirs = [];
  const stateDir = path.join(CP_HOME, 'session-state');
  if (fs.existsSync(stateDir)) {
    const inDb = db ? new Set(db.prepare('SELECT id FROM sessions').all().map(r => r.id)) : new Set(ids);
    for (const name of fs.readdirSync(stateDir)) {
      if (name.startsWith('.')) continue; // dot-dirs are Copilot internals (e.g. .session-operation-locks) — never touch
      const p = path.join(stateDir, name);
      if (!fs.statSync(p).isDirectory()) continue;
      if (inDb.has(name)) continue; // handled via its DB session (target or recent-keep)
      if (maxMtime(p) >= cutoff) { log('  KEEP(recent dir): ' + name); continue; }
      dirs.push(name);
      log('  TARGET(orphan dir): ' + name);
    }
  }
  let vscodeFiles = 0;
  const oldChatJsons = [];
  if (CP_VSCODE && fs.existsSync(VS_WS)) {
    for (const ws of fs.readdirSync(VS_WS)) {
      const csDir = path.join(VS_WS, ws, 'chatSessions');
      if (!fs.existsSync(csDir) || !fs.statSync(csDir).isDirectory()) continue;
      for (const f of fs.readdirSync(csDir)) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(csDir, f);
        if (fs.statSync(p).mtimeMs < cutoff) { oldChatJsons.push(p); vscodeFiles++; }
      }
    }
    log(`COPILOT-VSCODE: stale Copilot Chat session files (> ${CP_MAX_AGE}d): ${vscodeFiles}`);
  }
  log(`COPILOT: db sessions target=${ids.length} orphan dirs target=${dirs.length}` + (CP_VSCODE ? ` vscode files=${vscodeFiles}` : ''));
  if (!ids.length && !dirs.length && !vscodeFiles) { if (db) { try { db.close(); } catch {} } return 0; }
  if (!YES) {
    log(`  (dry-run) ${ids.length} Copilot CLI sessions + ${dirs.length} orphan state dirs` + (CP_VSCODE ? ` + ${vscodeFiles} VS Code chat files` : '') + ` older than ${CP_MAX_AGE} days would be deleted. Re-run with --yes.`);
    if (db) { try { db.close(); } catch {} }
    return 0;
  }
  try {
    if (db && ids.length) {
      db.exec('BEGIN IMMEDIATE'); // no FK cascades in this schema — delete every keyed table explicitly
      for (const [tbl, col] of [['turns', 'session_id'], ['checkpoints', 'session_id'], ['session_files', 'session_id'], ['session_refs', 'session_id'], ['forge_trajectory_events', 'session_id'], ['search_index', 'session_id']])
        for (const id of ids) db.prepare(`DELETE FROM ${tbl} WHERE ${col} = ?`).run(id);
      for (const id of ids) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      db.exec('COMMIT');
    }
    for (const id of [...ids, ...dirs]) {
      fs.rmSync(path.join(stateDir, id), { recursive: true, force: true });
      log('  DELETED ' + id);
    }
    const meta = path.join(CP_HOME, 'vscode.session.metadata.cache.json');
    if (fs.existsSync(meta)) try {
      const j = JSON.parse(fs.readFileSync(meta, 'utf8'));
      let n = 0;
      for (const id of ids) if (id in j) { delete j[id]; n++; }
      fs.writeFileSync(meta, JSON.stringify(j));
      if (n) log('  metadata cache entries removed=' + n);
    } catch {}
    for (const p of oldChatJsons) fs.rmSync(p, { force: true });
    if (CP_VSCODE) log('  COPILOT-VSCODE chat files deleted=' + oldChatJsons.length);
    log(`  COPILOT DELETED sessions=${ids.length} orphanDirs=${dirs.length}`);
    return 0;
  } catch (e) {
    try { db && db.exec('ROLLBACK'); } catch {}
    log('COPILOT: FAILED ' + (e && e.stack || e));
    return 3;
  } finally { if (db) { try { db.close(); } catch {} } }
}

// ---------- main ----------
async function main() {
  log('# claude-prune ' + new Date().toISOString() + ' mode=' + (YES ? 'APPLY' : 'DRY-RUN') + (VISIBLE ? ' visible' : '') + (OPENCODE ? ' +opencode' : ''));
  let exitCode = 0;

  // 0) local OpenCode store (no browser involved)
  if (OPENCODE) exitCode = Math.max(exitCode, await opencodePrune());

  // 0b) local GitHub Copilot CLI store (no browser involved)
  if (COPILOT) exitCode = Math.max(exitCode, await copilotPrune());

  let sid = null, org = null;
  if (!SKIP_CHATS || !SKIP_SESSIONS || IDS_FILE) {
    const ver = await ensureChrome();
    await connectCdp(ver.webSocketDebuggerUrl);
    sid = await openClaudeTab();

    let login = await loginCheck(sid);
    if (!login.ok && (VISIBLE || HEADFUL)) {
      log('Chrome window is open. Log in to claude.ai there. Waiting up to 10 minutes...');
      for (let i = 0; i < 200 && !login.ok; i++) { await sleep(3000); login = await loginCheck(sid); }
    }
    if (!login.ok) {
      log('NOT LOGGED IN (' + (login.status || login.error) + ') — run:  ./claude-prune --visible   and log in once.');
      await flushBrowserState(); await killChrome(); process.exit(exitCode || 2);
    }
    org = login.org;
    if (VISIBLE) log('Login OK. Continuing this run in the same Chrome window (no second login needed).');
  }

  // 1) chats
  if (!SKIP_CHATS) {
    const chats = await listChats(sid, org);
    if (chats.error) { log('CHATS: list failed: ' + chats.error); exitCode = 3; }
    else {
      const keepP = chats.items.filter(c => c.project);
      const keepN = chats.items.filter(c => !c.project && KEEP.some(k => c.name === k));
      const targets = chats.items.filter(c => !c.project && !KEEP.some(k => c.name === k));
      const flags = c => (c.starred ? ' pinned' : '') + (c.archived ? ' archived' : '');
      log(`CHATS: total=${chats.total} keep(project)=${keepP.length} keep(--keep)=${keepN.length} target=${targets.length} (of which pinned=${targets.filter(c => c.starred).length} archived=${targets.filter(c => c.archived).length})`);
      for (const c of keepP) log('  KEEP(project): ' + c.name);
      if (YES) {
        let ok = 0, fail = 0;
        for (const c of targets) {
          const r = await deleteChat(sid, org, c.uuid);
          if (r.status >= 200 && r.status < 300) ok++;
          else if (r.status === 404) ok++;
          else { fail++; log('  CHAT FAIL ' + c.uuid + ' ' + JSON.stringify(r)); }
          await sleep(300);
        }
        log(`  CHATS DELETED=${ok} FAILED=${fail}`);
        if (fail) exitCode = 3;
      } else {
        log('  (dry-run) first 15 targets: ' + JSON.stringify(targets.slice(0, 15).map(c => c.name || '(untitled)')));
      }
    }
  }

  // 2) archived code sessions
  if (!SKIP_SESSIONS) {
    const s = await listArchivedSessions(sid, org);
    if (s.error) { log('SESSIONS: list failed: ' + s.error); exitCode = 3; }
    else {
      const archived = s.items.filter(x => x.status === 'archived');
      let targets = archived;
      if (SESS_MAX_AGE != null && Number.isFinite(SESS_MAX_AGE)) {
        const cutoff = Date.now() - SESS_MAX_AGE * 86400e3;
        targets = archived.filter(x => x.updated && Date.parse(x.updated) < cutoff);
        const skipped = archived.length - targets.length;
        log(`SESSIONS: archived=${archived.length} skip(${skipped} updated < ${SESS_MAX_AGE}d ago or unknown age) target=${targets.length}`);
      } else {
        log('SESSIONS: archived=' + archived.length);
      }
      if (!YES) for (const x of targets) log('  TARGET: ' + x.updated + '  ' + x.title);
      if (YES) {
        let ok = 0, fail = 0;
        for (const x of targets) {
          const r = await deleteSession(sid, org, x.id);
          if (r.status >= 200 && r.status < 300) ok++;
          else if (r.status === 404) ok++;
          else { fail++; log('  SESSION FAIL ' + x.id + ' ' + JSON.stringify(r)); }
          await sleep(250);
        }
        const after = await listArchivedSessions(sid, org);
        log(`  SESSIONS DELETED=${ok} FAILED=${fail} remainingArchived=${after.total ?? after.error}`);
        if (fail) exitCode = 3;
      } else {
        log('  (dry-run) first 10 titles: ' + JSON.stringify(targets.slice(0, 10).map(x => x.title)));
      }
    }
  }

  // 3) optional trigger ids from an export
  if (IDS_FILE) {
    const items = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
    log('TRIGGERS: known ids=' + items.length);
    if (YES) {
      let gone = 0, del = 0, fail = 0;
      for (const it of items) {
        const id = typeof it === 'string' ? it : it.id;
        const r = await deleteTrigger(sid, org, id);
        if (r.status >= 200 && r.status < 300) del++;
        else if (r.status === 404) gone++;
        else fail++;
        await sleep(180);
      }
      log(`  TRIGGERS deleted=${del} alreadyGone=${gone} failed=${fail}`);
      if (fail) exitCode = 3;
    }
  }

  await flushBrowserState();
  await killChrome();
  log('DONE log=' + logPath);
  process.exit(exitCode);
}

main().catch(async e => { log('FATAL ' + (e && e.stack || e)); try { await killChrome(); } catch {} process.exit(3); });
