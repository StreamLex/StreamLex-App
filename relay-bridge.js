#!/usr/bin/env node
/*
 * RELAY — local bridge for live stream translation
 * ------------------------------------------------
 * Serves the Control window and the Overlay, and relays translated captions
 * to every connected overlay over Server-Sent Events.
 *
 * Zero dependencies. Requires Node 18+ (uses built-in fetch).
 *
 * Run:
 *    ANTHROPIC_API_KEY=sk-ant-...  node relay-bridge.js          (mac / linux)
 *    set ANTHROPIC_API_KEY=sk-ant-... && node relay-bridge.js    (windows cmd)
 *
 * Or simply put your key in a file named `relay.env` next to this script:
 *    ANTHROPIC_API_KEY=sk-ant-...
 * and run `node relay-bridge.js` — the key is loaded automatically and never
 * has to live in a launcher script.
 *
 * Options (env var or --flag=value):
 *    --port=4455      port to listen on
 *    --host=127.0.0.1 use 0.0.0.0 for a separate capture-PC + stream-PC setup
 *    --key=sk-ant-... Anthropic API key (or ANTHROPIC_API_KEY env / relay.env)
 *    --model=...      translation model (default: fast Haiku)
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

// Where writable files (relay.env, relay-config.json) live. Defaults to this
// folder for CLI use; the desktop app sets RELAY_DATA_DIR to a writable user
// directory because the packaged app folder is read-only.
const DATA_DIR = process.env.RELAY_DATA_DIR || __dirname;

// ---- tiny .env loader (so the API key never has to live in a .bat) ----------
function loadEnvFile(file){
  try {
    const txt = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    for (let line of txt.split(/\r?\n/)){
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch (_) { /* no env file — that's fine */ }
}
loadEnvFile('relay.env');
loadEnvFile('.env');

const arg = n => {
  const p = process.argv.find(a => a.startsWith('--' + n + '='));
  return p ? p.split('=').slice(1).join('=') : '';
};
const PORT  = parseInt(arg('port') || process.env.RELAY_PORT || '4455', 10);
const HOST  = arg('host') || process.env.RELAY_HOST || '127.0.0.1';
let   apiKey = arg('key')  || process.env.ANTHROPIC_API_KEY || '';   // can be set live from Control
const MODEL = arg('model')|| process.env.RELAY_MODEL || 'claude-haiku-4-5-20251001';

// Persist a key set from the Control window into relay.env so it survives restarts.
function saveKeyToEnv(key){
  const file = path.join(DATA_DIR, 'relay.env');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) {}
  let found = false;
  lines = lines.map(l => {
    if (/^\s*ANTHROPIC_API_KEY\s*=/.test(l)) { found = true; return 'ANTHROPIC_API_KEY=' + key; }
    return l;
  });
  if (!found) lines.unshift('ANTHROPIC_API_KEY=' + key);
  try { fs.writeFileSync(file, lines.join('\n')); return true; } catch (_) { return false; }
}

const CONFIG_FILE  = path.join(DATA_DIR, 'relay-config.json');
const HISTORY_MAX  = 6;     // recent captions replayed to a freshly-added overlay
const CACHE_MAX    = 600;   // translation LRU cap
const startedAt    = Date.now();

const clients   = new Set();
let lastCaption = null;
let history     = [];       // ring buffer of recent captions for late-joining overlays
const stats     = { captions:0, translations:0, cacheHits:0, errors:0 };

const DEFAULT_CONFIG = { type:'config', size:'l', pos:'bottom', bg:'transparent',
                         showsrc:'on', plate:'off', hold:'2000', lines:'2', targetLang:'' };
let lastConfig = Object.assign({}, DEFAULT_CONFIG);
try {                                    // restore overlay look across restarts
  const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  lastConfig = Object.assign({}, DEFAULT_CONFIG, saved, { type:'config' });
} catch (_) {}

// ---- translation cache (LRU via Map insertion order) ------------------------
const cache = new Map();
function cacheGet(k){
  if (!cache.has(k)) return undefined;
  const v = cache.get(k); cache.delete(k); cache.set(k, v);   // bump to newest
  return v;
}
function cacheSet(k, v){
  if (cache.has(k)) cache.delete(k);
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'Content-Type',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS'
};

function reply(res, status, type, body){
  res.writeHead(status, Object.assign({ 'Content-Type':type }, CORS));
  res.end(body);
}
function serveFile(res, file, type){
  fs.readFile(path.join(__dirname, file), (err, data) =>
    err ? reply(res, 404, 'text/plain', 'Not found: ' + file)
        : reply(res, 200, type, data));
}
function broadcast(obj){
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const c of clients){ try { c.write(line); } catch(_){} }
}
function readBody(req){
  return new Promise(r => { let d=''; req.on('data', c=>d+=c); req.on('end', ()=>r(d)); });
}
let saveTimer = null;
function persistConfig(){                // debounced write so disk isn't hammered
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { type, ...body } = lastConfig;
    fs.writeFile(CONFIG_FILE, JSON.stringify(body, null, 2), () => {});
  }, 400);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- optional profanity mask (toggle from Control; off by default) ----------
const BAD_WORDS = ['fuck','shit','bitch','asshole','cunt','dick','bastard','motherfucker',
                   'merde','putain','connard','salope','mierda','puta','cabron','scheisse'];
const BAD_RE = new RegExp('\\b(' + BAD_WORDS.join('|') + ')\\b', 'gi');
function clean(text){
  if (lastConfig.clean !== 'on') return text;
  return text.replace(BAD_RE, w => w[0] + '*'.repeat(Math.max(1, w.length - 1)));
}

function sysPrompt(srcName, dst){
  return `You are a real-time broadcast translation engine. Translate the user's text ` +
    `from ${srcName} into ${dst}. Output ONLY the translation — no preamble, quotes, ` +
    `notes or explanation. Preserve names, numbers, tone and punctuation. ` +
    `If the text is already in ${dst}, return it unchanged.`;
}

// Streaming translation: calls onDelta(partialText) as the translation grows, so
// captions appear progressively instead of after a pause. Returns the final string.
async function translateStream(text, srcName, dst, onDelta){
  if (!apiKey) return null;                     // no key → caller falls back to original
  const ck = srcName + '' + dst + '' + text;
  const hit = cacheGet(ck);
  if (hit !== undefined){ stats.cacheHits++; if (onDelta) onDelta(hit); return hit; }

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++){
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 400, stream: true,
                               system: sysPrompt(srcName, dst),
                               messages:[{ role:'user', content: text }] })
      });
      if (r.status === 429 || r.status === 529 || r.status >= 500){
        lastErr = new Error('Anthropic HTTP ' + r.status);
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
      if (!r.ok) throw new Error('Anthropic HTTP ' + r.status);

      let acc = '', buf = '';
      const td = new TextDecoder();
      for await (const chunk of r.body){
        buf += td.decode(chunk, { stream:true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0){
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let ev; try { ev = JSON.parse(payload); } catch(_){ continue; }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta'){
            acc += ev.delta.text;
            if (onDelta) onDelta(acc);
          }
        }
      }
      acc = acc.trim();
      stats.translations++;
      cacheSet(ck, acc);
      return acc;
    } catch (e){
      lastErr = e;
      await sleep(300 * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error('translation failed');
}

async function translate(text, srcName, dst){
  if (!apiKey) return null;                     // no key → caller falls back to original
  const ck = srcName + '' + dst + '' + text;
  const hit = cacheGet(ck);
  if (hit !== undefined){ stats.cacheHits++; return hit; }

  const sys =
    `You are a real-time broadcast translation engine. Translate the user's text ` +
    `from ${srcName} into ${dst}. Output ONLY the translation — no preamble, quotes, ` +
    `notes or explanation. Preserve names, numbers, tone and punctuation. ` +
    `If the text is already in ${dst}, return it unchanged.`;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++){
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 400, system: sys,
                               messages:[{ role:'user', content: text }] })
      });
      if (r.status === 429 || r.status === 529 || r.status >= 500){
        lastErr = new Error('Anthropic HTTP ' + r.status);
        await sleep(300 * Math.pow(2, attempt));   // 300, 600, 1200ms backoff
        continue;
      }
      if (!r.ok) throw new Error('Anthropic HTTP ' + r.status);
      const d = await r.json();
      const out = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      stats.translations++;
      cacheSet(ck, out);
      return out;
    } catch (e){
      lastErr = e;
      await sleep(300 * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error('translation failed');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return reply(res, 204, 'text/plain', '');

  if (p === '/' || p === '/control') return serveFile(res, 'relay-control.html', 'text/html; charset=utf-8');
  if (p === '/overlay')              return serveFile(res, 'relay-overlay.html', 'text/html; charset=utf-8');

  if (p === '/status' || p === '/health')
    return reply(res, 200, 'application/json',
      JSON.stringify({ ok:true, key: !!apiKey, model: MODEL, clients: clients.size,
                       uptime: Math.round((Date.now()-startedAt)/1000),
                       cacheSize: cache.size, ...stats }));

  // Save an Anthropic key from the Control window (no file editing needed).
  if (p === '/setkey' && req.method === 'POST'){
    let j; try { j = JSON.parse(await readBody(req)); } catch(_){ return reply(res,400,'application/json','{"error":"bad json"}'); }
    const key = (j.key || '').toString().trim();
    if (!/^sk-ant-/.test(key))
      return reply(res, 400, 'application/json', '{"ok":false,"error":"That doesn\'t look like an Anthropic key (sk-ant-…)."}');
    // Validate with a tiny request before committing.
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 4, messages:[{ role:'user', content:'ping' }] })
      });
      if (r.status === 401 || r.status === 403)
        return reply(res, 200, 'application/json', '{"ok":false,"error":"Key rejected by Anthropic (401/403). Check it and try again."}');
      if (!r.ok && r.status !== 400)
        return reply(res, 200, 'application/json', JSON.stringify({ ok:false, error:'Anthropic HTTP ' + r.status }));
    } catch (e){
      return reply(res, 200, 'application/json', JSON.stringify({ ok:false, error:'Could not reach Anthropic: ' + e.message }));
    }
    apiKey = key;
    const saved = saveKeyToEnv(key);
    return reply(res, 200, 'application/json', JSON.stringify({ ok:true, saved }));
  }

  // One-shot health check used by the Control window's self-test.
  if (p === '/selftest')
    return reply(res, 200, 'application/json',
      JSON.stringify({ ok:true, bridge:true, key:!!apiKey, overlays:clients.size, model:MODEL }));

  if (p === '/stream'){
    res.writeHead(200, Object.assign({
      'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive'
    }, CORS));
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(lastConfig) + '\n\n');       // prime new overlay
    for (const h of history) res.write('data: ' + JSON.stringify(h) + '\n\n');
    clients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(_){} }, 15000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    return;
  }

  if (p === '/caption' && req.method === 'POST'){
    let j; try { j = JSON.parse(await readBody(req)); } catch(_){ return reply(res,400,'application/json','{"error":"bad json"}'); }
    const text = (j.text || '').trim();
    if (!text) return reply(res, 200, 'application/json', '{"ok":true}');
    const seq = j.seq || Date.now();
    const channel = (j.channel || 'host').toString();
    const label = (j.label || '').toString().slice(0, 24);
    const srcName = j.srcName || 'the source language';
    // Interim captions (live streaming transcription) update the on-screen line as
    // you speak; they don't start the auto-hide timer or go into replay history.
    const isInterim = !!j.interim;
    // A global target language (set from the Control window / OBS dock) overrides
    // the per-caption value, so one switch re-languages your whole stream.
    const dstLang = (lastConfig.targetLang || '').trim() || j.dst || 'English';

    let dst = text, ok = false;
    let lastEmit = 0;
    // Stream the translation so partial captions appear as it's produced.
    const onDelta = partial => {
      const now = Date.now();
      if (now - lastEmit < 110) return;          // throttle network chatter
      lastEmit = now;
      broadcast({ type:'caption', seq, src:text, dst:clean(partial), translated:true,
                  channel, label, partial:true });
    };
    try {
      let t;
      try { t = await translateStream(text, srcName, dstLang, onDelta); }
      catch(_){ t = await translate(text, srcName, dstLang); }   // fall back to non-streaming
      if (t !== null){ dst = t; ok = true; }
    } catch (e){ stats.errors++; broadcast({ type:'notice', msg:'engine error: ' + e.message }); }

    stats.captions++;
    dst = clean(dst);
    lastCaption = { type:'caption', seq, src:text, dst, translated:ok, channel, label, final: !isInterim };
    if (!isInterim){
      history.push(lastCaption);
      if (history.length > HISTORY_MAX) history.shift();
    }
    broadcast(lastCaption);
    return reply(res, 200, 'application/json', JSON.stringify({ ok:true, translated:ok }));
  }

  if (p === '/config' && req.method === 'POST'){
    try { Object.assign(lastConfig, JSON.parse(await readBody(req)), { type:'config' }); } catch(_){}
    persistConfig();
    broadcast(lastConfig);
    return reply(res, 200, 'application/json', '{"ok":true}');
  }

  if (p === '/clear' && req.method === 'POST'){
    lastCaption = null; history = []; broadcast({ type:'clear' });
    return reply(res, 200, 'application/json', '{"ok":true}');
  }

  reply(res, 404, 'text/plain', 'Not found');
});

// Don't crash if the port is already taken (e.g. the desktop app launched while
// a bridge from start-relay.bat is still running) — log it and carry on so the
// existing bridge keeps serving the overlay/control.
server.on('error', e => {
  if (e.code === 'EADDRINUSE')
    console.error('\n  Port ' + PORT + ' is already in use — a Relay bridge is already running.\n' +
                  '  Using the existing one. Close it first if you want a fresh start.\n');
  else
    console.error('  bridge server error:', e.message);
});

server.listen(PORT, HOST, () => {
  const base = 'http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT;
  const bar = '  ' + '-'.repeat(50);
  console.log('\n  RELAY bridge is running');
  console.log(bar);
  console.log('  Control window :  ' + base + '/control     <- open in Chrome');
  console.log('  Overlay (OBS)  :  ' + base + '/overlay      <- add as Browser Source');
  console.log('  Translation    :  ' + (apiKey ? 'ON  (' + MODEL + ')' : 'OFF — no API key, captions stay in source language'));
  console.log(bar);
  if (!apiKey){
    console.log('  Add your key right in the Control window (paste & Save), or');
    console.log('  put it in a file named relay.env:');
    console.log('     ANTHROPIC_API_KEY=sk-ant-...');
    console.log('  ...or restart with the key on the command line:');
    console.log('     mac/linux :  ANTHROPIC_API_KEY=sk-ant-... node relay-bridge.js');
    console.log('     windows   :  set ANTHROPIC_API_KEY=sk-ant-...&& node relay-bridge.js');
    console.log(bar);
  }
  console.log('  Press Ctrl+C to stop.\n');
});
