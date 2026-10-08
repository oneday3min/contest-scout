// Contest Scout — finds, reads and ranks contests/hackathons for a small creator team.
// Zero dependencies: Node 18+ (built-in fetch). Run: node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const NEBIUS_BASE = (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/$/, '');
const NEBIUS_KEY = process.env.NEBIUS_API_KEY || '';
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

const models = { fast: process.env.NEBIUS_MODEL_FAST || '', reason: process.env.NEBIUS_MODEL_REASON || '' };

// Credit guard for a public demo: cache repeated pages, cap live runs per day and per visitor.
const DAILY_LIVE_LIMIT = Number(process.env.DAILY_LIVE_LIMIT || 40);
const HOURLY_PER_IP = Number(process.env.HOURLY_PER_IP || 6);
const MAX_PAGE_CHARS = Number(process.env.MAX_PAGE_CHARS || 30000);
const cache = new Map(); // key -> { at, value }
const usage = { day: '', count: 0, perIp: new Map() };

function allowLive(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) { usage.day = day; usage.count = 0; usage.perIp.clear(); }
  const hour = Date.now() - 3600_000;
  const hits = (usage.perIp.get(ip) || []).filter((t) => t > hour);
  if (usage.count >= DAILY_LIVE_LIMIT) return 'The public demo used today\'s AI budget. Try the sample board, or run it yourself with your own key.';
  if (hits.length >= HOURLY_PER_IP) return 'Too many analyses from you this hour. Please try again later.';
  hits.push(Date.now());
  usage.perIp.set(ip, hits);
  usage.count += 1;
  return null;
}

function cacheKey(obj) {
  return require('crypto').createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// ---------- helpers ----------

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 400_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v === '::';
}

// Fetch a public contest page as plain text. Refuses local/private addresses.
async function fetchPage(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  const { address } = await dns.lookup(u.hostname);
  if (isPrivateIp(address)) throw new Error('Local or private addresses are not allowed');
  const r = await fetch(u, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (ContestScout; +https://github.com/) AppleWebKit/537.36 Chrome/130 Safari/537.36' },
  });
  if (!r.ok) throw new Error(`Page returned HTTP ${r.status} — paste the page text instead`);
  const text = htmlToText(await r.text());
  return text.slice(0, MAX_PAGE_CHARS);
}

// ---------- Nebius Token Factory (OpenAI-compatible) ----------

async function pickModels() {
  if (!NEBIUS_KEY || (models.fast && models.reason)) return;
  try {
    const r = await fetch(`${NEBIUS_BASE}/models`, { headers: { Authorization: `Bearer ${NEBIUS_KEY}` }, signal: AbortSignal.timeout(15000) });
    const ids = ((await r.json()).data || []).map((m) => m.id);
    const nemo = ids.filter((id) => /nemotron/i.test(id));
    const find = (re) => nemo.find((id) => re.test(id));
    models.fast ||= find(/nano/i) || find(/super/i) || nemo[0] || '';
    models.reason ||= find(/ultra/i) || find(/super/i) || models.fast;
    console.log(`Nemotron models on Token Factory: ${nemo.join(', ') || '(none found)'}`);
  } catch (e) {
    console.warn('Could not list models:', e.message);
  }
}

// think=false turns off Nemotron's hidden reasoning, which otherwise eats the token budget on plain extraction.
async function chat(model, system, user, maxTokens = 2500, think = true) {
  const r = await fetch(`${NEBIUS_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NEBIUS_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(think ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Token Factory error ${r.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
  const choice = data.choices?.[0] || {};
  const msg = choice.message?.content || '';
  if (process.env.DEBUG_RAW) console.error(`[raw ${model}] finish=${choice.finish_reason} len=${msg.length} usage=${JSON.stringify(data.usage)}\n${msg.slice(0, 600)}\n---`);
  return { content: msg, usage: data.usage || null, model };
}

function parseJson(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const EXTRACT_SYSTEM = `You read contest, hackathon and open-call pages and extract facts.
Return ONLY one JSON object, no prose. Use null when the page does not say. Never guess.
Every important field must have an "evidence" quote copied verbatim from the page (max 25 words).
Schema:
{
 "name": string,
 "organizer": string|null,
 "url": string|null,
 "deadline": {"iso": "YYYY-MM-DDTHH:MM:SS±HH:MM"|null, "as_written": string|null, "evidence": string|null},
 "eligibility": {"summary": string|null, "individuals_ok": boolean|null, "online": boolean|null, "countries": string|null, "age": string|null, "evidence": string|null},
 "prizes": {"summary": string|null, "cash": boolean|null, "top_amount": string|null, "winner_count": number|null, "evidence": string|null},
 "deliverables": [{"item": string, "evidence": string|null}],
 "judging": [string],
 "required_tech": [string],
 "language": string|null,
 "red_flags": [string]
}
Write values in the same language as the user's "output language". Keep evidence quotes in the page's original language.`;

const SCORE_SYSTEM = `You are a pragmatic contest strategist for a tiny team.
Given extracted contest facts and the team profile, score the contest.
Return ONLY one JSON object:
{
 "scores": {"win_odds": 0-5, "deadline": 0-5, "resources": 0-5, "cash": 0-5},
 "total": 0-20,
 "verdict": "go" | "maybe" | "skip",
 "why": [string, string, string],
 "blockers": [string],
 "plan": [{"date": "YYYY-MM-DD", "task": string, "owner": "team"|"human-only"}]
}
Rules:
- win_odds: more winners, narrower pool (language/region/age-restricted), and fit with the team's strengths raise it. Huge global pools lower it.
- deadline: 5 = comfortably enough time for the deliverables, 0 = passed or impossible.
- resources: 5 = the team already has almost everything, 0 = needs skills/hardware it lacks.
- cash: 5 = real cash prizes, lower for tokens, raffles, vouchers, swag.
- If the deadline has passed or the team is not eligible, verdict must be "skip".
- plan: concrete dated steps from today to the deadline. Mark sign-ups, identity checks, payments and final submission as "human-only".
- Ground every claim in the facts given. Say "unknown" instead of inventing.
Write text in the requested output language.`;

// ---------- demo mode (no API key): transparent rule-based fallback ----------

function demoExtract(text, url, today) {
  const firstLine = text.split('\n').map((s) => s.trim()).find((s) => s.length > 3) || 'Untitled contest';
  // Collect every date on the page; the latest one is the best guess for the deadline.
  const found = [];
  const pad = (n) => String(n).padStart(2, '0');
  let year = String(today || new Date().toISOString()).slice(0, 4); // pages often omit the year
  for (const m of text.matchAll(/(?:(20\d\d)\s*[-./년]\s*)?(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/g)) {
    if (m[1]) year = m[1];
    if (year && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) found.push({ iso: `${year}-${pad(m[2])}-${pad(m[3])}`, as: m[0].trim() });
  }
  for (const m of text.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}),? (20\d\d)/gi)) {
    const mi = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[1].slice(0, 3).toLowerCase()) / 3 + 1;
    found.push({ iso: `${m[3]}-${pad(mi)}-${pad(m[2])}`, as: m[0] });
  }
  found.sort((a, b) => a.iso.localeCompare(b.iso));
  const last = found[found.length - 1];
  const iso = last ? `${last.iso}T23:59:00+09:00` : null;
  const asWritten = last ? last.as : null;
  const money = text.match(/\$\s?[\d,]+(?:\.\d+)?|[\d,]+\s?(?:만\s?원|억\s?원|원|USD)/);
  return {
    name: firstLine.slice(0, 80), organizer: null, url: url || null,
    deadline: { iso, as_written: asWritten, evidence: asWritten },
    eligibility: { summary: null, individuals_ok: null, online: /online|온라인/i.test(text) || null, countries: null, age: null, evidence: null },
    prizes: { summary: money ? money[0] : null, cash: money ? true : null, top_amount: money ? money[0] : null, winner_count: null, evidence: money ? money[0] : null },
    deliverables: [], judging: [], required_tech: [], language: null,
    red_flags: ['Demo mode: rule-based guess, not AI. Add NEBIUS_API_KEY for real extraction.'],
  };
}

function demoScore(contest, today) {
  const days = contest.deadline?.iso ? Math.floor((new Date(contest.deadline.iso) - new Date(today)) / 86400000) : null;
  const deadline = days == null ? 2 : days < 0 ? 0 : days < 7 ? 2 : days < 21 ? 4 : 5;
  const scores = { win_odds: 2, deadline, resources: 2, cash: contest.prizes?.cash ? 4 : 1 };
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return {
    scores, total, verdict: deadline === 0 ? 'skip' : total >= 12 ? 'maybe' : 'skip',
    why: [days == null ? 'Deadline not found' : `${days} days left`, 'Demo mode cannot judge fit', 'Add NEBIUS_API_KEY for a reasoned score'],
    blockers: [], plan: [],
  };
}

// ---------- routes ----------

async function analyze(body, ip) {
  const today = body.today || new Date().toISOString().slice(0, 10);
  const lang = body.lang === 'ko' ? 'Korean' : 'English';
  let text = (body.text || '').trim();
  const url = (body.url || '').trim();
  let source = 'pasted text';
  if (!text && url) { text = await fetchPage(url); source = url; }
  if (text.length < 40) throw new Error('Paste the contest page text or give a public URL');
  text = text.slice(0, MAX_PAGE_CHARS);

  if (!NEBIUS_KEY) {
    const contest = demoExtract(text, url, today);
    return { mode: 'demo', source, contest, score: demoScore(contest, today), usage: [] };
  }

  const key = cacheKey({ text, lang, today, profile: body.profile || {} });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return { ...hit.value, cached: true };
  const blocked = allowLive(ip);
  if (blocked) throw new Error(blocked);

  const ex = await chat(models.fast, EXTRACT_SYSTEM, `Output language: ${lang}\nToday: ${today}\nSource: ${source}\n\nPAGE TEXT:\n${text}`, 4000, false);
  const contest = parseJson(ex.content);
  if (url && !contest.url) contest.url = url;

  const profile = body.profile || {};
  const sc = await chat(
    models.reason,
    SCORE_SYSTEM,
    `Output language: ${lang}\nToday: ${today}\nTEAM PROFILE:\n${JSON.stringify(profile, null, 1)}\n\nCONTEST FACTS:\n${JSON.stringify(contest, null, 1)}`,
    8000,
  );
  const score = parseJson(sc.content);
  const value = { mode: 'live', source, contest, score, usage: [{ step: 'extract', model: ex.model, ...ex.usage }, { step: 'score', model: sc.model, ...sc.usage }] };
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function discover(body) {
  const query = (body.query || '').trim();
  if (!query) throw new Error('Type what kind of contest to look for');
  if (!TAVILY_KEY) return { mode: 'demo', results: [], note: 'Add TAVILY_API_KEY to search the web. You can still paste URLs.' };
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_KEY}` },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 8, include_answer: false }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Tavily error ${r.status}: ${data.detail || data.error || ''}`);
  return { mode: 'live', results: (data.results || []).map((x) => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 220) })) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, { mode: NEBIUS_KEY ? 'live' : 'demo', models, search: Boolean(TAVILY_KEY) });
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      return send(res, 200, await analyze(await readBody(req), ip));
    }
    if (req.method === 'POST' && pathname === '/api/discover') return send(res, 200, await discover(await readBody(req)));
    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

pickModels().then(() => {
  server.listen(PORT, () => {
    console.log(`Contest Scout on http://localhost:${PORT}  (mode: ${NEBIUS_KEY ? 'live' : 'demo'}, fast=${models.fast || '-'}, reason=${models.reason || '-'})`);
  });
});
