// Daily auto-discovery: search the web for new contests, analyze the new ones, and write public/daily.json.
// Nobody has to paste links: the site shows "Today's picks" from this file.
// Run: node scripts/daily.js   (GitHub Actions runs it every morning, see .github/workflows/daily.yml)
'use strict';

const fs = require('fs');
const path = require('path');
const { analyze, discover, hasKeys } = require('../lib/core');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'daily', 'config.json'), 'utf8'));
const OUT = path.join(ROOT, 'public', 'daily.json');

// Korea time is the team's working day.
const todayKst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return u; } };
const skipRe = cfg.skip_url_patterns.map((p) => new RegExp(p, 'i'));

async function main() {
  const keys = hasKeys();
  // Test switch: DAILY_TEST_URLS="url1 url2" skips the web search and analyzes these pages.
  const testUrls = (process.env.DAILY_TEST_URLS || '').split(/\s+/).filter(Boolean);
  if (!keys.tavily && !testUrls.length) throw new Error('TAVILY_API_KEY is missing');
  if (!keys.nebius) throw new Error('NEBIUS_API_KEY is missing');
  const today = todayKst();
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { items: [], seen: {} };
  const cutoff = new Date(Date.now() - cfg.keep_days * 86400_000).toISOString().slice(0, 10);

  // Forget pages seen long ago; keep open contests only.
  const seen = Object.fromEntries(Object.entries(prev.seen || {}).filter(([, d]) => d >= cutoff));
  const stillOpen = (x) => !x.contest?.deadline?.iso || Date.parse(x.contest.deadline.iso) >= Date.now();
  const items = (prev.items || []).filter(stillOpen);

  // 1) find
  const found = testUrls.map((url) => ({ url, title: url, score: 1, query: '(test)' }));
  for (const q of testUrls.length ? [] : cfg.queries) {
    try {
      const r = await discover({ query: q, raw: true, max: 8 });
      for (const x of r.results) found.push({ ...x, query: q });
    } catch (e) { console.warn(`search failed "${q}": ${e.message}`); }
  }
  const fresh = [];
  const urls = new Set();
  for (const x of found) {
    const u = norm(x.url);
    if (urls.has(u) || seen[u] || skipRe.some((re) => re.test(u))) continue;
    urls.add(u);
    fresh.push({ ...x, url: u });
  }
  fresh.sort((a, b) => (b.score || 0) - (a.score || 0));
  console.log(`found ${found.length}, new ${fresh.length}, analyzing up to ${cfg.max_new_per_day}`);

  // 2) analyze the new ones (capped to protect credits)
  let analyzed = 0, failed = 0;
  for (const x of fresh.slice(0, cfg.max_new_per_day)) {
    seen[x.url] = today;
    try {
      const r = await analyze({ url: x.url, lang: cfg.lang, today, profile: cfg.profile }, 'daily', { trusted: true });
      analyzed++;
      if (!stillOpen(r)) { console.log(`closed: ${x.url}`); continue; }
      if (!r.contest?.name) continue;
      items.push({ id: `daily-${today}-${analyzed}`, found_at: today, query: x.query, title: x.title, ...r });
      console.log(`${r.score?.verdict} ${r.score?.total}/20  ${r.contest.name}`);
    } catch (e) {
      failed++;
      console.warn(`analyze failed ${x.url}: ${e.message}`);
      if (/Token Factory error (401|402|403)/.test(e.message)) break; // credits or key problem: stop for today
    }
  }

  // 3) write: go first, then maybe, then the rest; drop skips older than a week
  const rank = { go: 0, maybe: 1, skip: 2 };
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const out = items
    .filter((x) => x.score?.verdict !== 'skip' || x.found_at >= weekAgo)
    .sort((a, b) => (rank[a.score?.verdict] ?? 3) - (rank[b.score?.verdict] ?? 3) || (b.score?.total ?? 0) - (a.score?.total ?? 0));
  fs.writeFileSync(OUT, JSON.stringify({ updated_at: new Date().toISOString(), date: today, analyzed, failed, items: out, seen }, null, 1));
  console.log(`wrote ${out.length} items (analyzed ${analyzed}, failed ${failed})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
