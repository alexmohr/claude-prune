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
const VISIBLE = argv.includes('--visible');
const SKIP_CHATS = argv.includes('--no-chats');
const SKIP_SESSIONS = argv.includes('--no-sessions');
const KEEP = (argv.find(a => a.startsWith('--keep=')) || '').replace(/^--keep=/, '').split(',').map(s => s.trim()).filter(Boolean);
const IDS_FILE = (argv.find(a => a.startsWith('--ids=')) || '').replace(/^--ids=/, '');

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
    ...(VISIBLE ? [] : ['--headless=new']),
    'https://claude.ai/new',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(path.join(PROFILE, '.claude-prune.pid'), String(child.pid));
  for (let i = 0; i < 60; i++) { try { return await cdpVersion(); } catch { await sleep(500); } }
  throw new Error('Chrome did not expose CDP on port ' + PORT + '. Is the profile open in another Chrome? (one Chrome per profile dir)');
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
  return evaluate(sid, `(async()=>{${hdr(org)}let cursor=null,items=[],guard=0;while(guard++<60){let u='${B}/v1/code/sessions?statuses=archived&limit=100';if(cursor)u+='&cursor='+encodeURIComponent(cursor);const r=await fetch(u,{headers:H});if(r.status!==200)return JSON.stringify({error:'http '+r.status});const j=await r.json();const arr=j.data||j.sessions||(Array.isArray(j)?j:[]);items=items.concat(arr.map(s=>({id:s.id||s.session_id,title:(s.title||'').slice(0,60),status:s.status})));cursor=j.next_cursor||null;if(!cursor||!arr.length)break;}return JSON.stringify({total:items.length,items});})()`);
}
const deleteSession = (sid, org, id) => evaluate(sid, `(async()=>{${hdr(org)}try{const r=await fetch('${B}/v1/code/sessions/${id}',{method:'DELETE',headers:H});return JSON.stringify({status:r.status});}catch(e){return JSON.stringify({error:String(e)});}})()`);

const deleteTrigger = (sid, org, id) => evaluate(sid, `(async()=>{${hdr(org)}try{const r=await fetch('${B}/v1/code/triggers/${id}',{method:'DELETE',headers:H});return JSON.stringify({status:r.status});}catch(e){return JSON.stringify({error:String(e)});}})()`);

// ---------- main ----------
async function main() {
  log('# claude-prune ' + new Date().toISOString() + ' mode=' + (YES ? 'APPLY' : 'DRY-RUN') + (VISIBLE ? ' visible' : ''));
  const ver = await ensureChrome();
  await connectCdp(ver.webSocketDebuggerUrl);
  const sid = await openClaudeTab();

  let login = await loginCheck(sid);
  if (!login.ok && VISIBLE) {
    log('Chrome window is open. Log in to claude.ai there. Waiting up to 10 minutes...');
    for (let i = 0; i < 200 && !login.ok; i++) { await sleep(3000); login = await loginCheck(sid); }
  }
  if (!login.ok) {
    log('NOT LOGGED IN (' + (login.status || login.error) + ') — run:  ./claude-prune --visible   and log in once.');
    await killChrome(); process.exit(2);
  }
  const org = login.org;
  if (VISIBLE) { log('Login OK. You can close the Chrome window now (or it will be closed for you).'); await killChrome(); process.exit(0); }

  let exitCode = 0;

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
      const targets = s.items.filter(x => x.status === 'archived');
      log('SESSIONS: archived=' + targets.length);
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

  await killChrome();
  log('DONE log=' + logPath);
  process.exit(exitCode);
}

main().catch(async e => { log('FATAL ' + (e && e.stack || e)); try { await killChrome(); } catch {} process.exit(3); });
