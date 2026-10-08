// Accuracy check against contests whose facts we verified by hand.
// Start the server with a key first, then: node eval/run.js [http://localhost:8787]
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8787';
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));

function kstDate(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

(async () => {
  let pass = 0, total = 0, tokens = 0;
  for (const c of cases) {
    const started = Date.now();
    const r = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: c.url, text: c.text, lang: c.lang || 'en', today: c.today || '2026-10-09' }),
    });
    const data = await r.json();
    if (!r.ok) { console.log(`✗ ${c.name}: ${data.error}`); total += c.expect ? Object.keys(c.expect).length : 0; continue; }
    tokens += (data.usage || []).reduce((s, u) => s + (u.total_tokens || 0), 0);
    const got = {
      deadline_kst: kstDate(data.contest?.deadline?.iso),
      individuals_ok: data.contest?.eligibility?.individuals_ok,
      online: data.contest?.eligibility?.online,
      verdict: data.score?.verdict,
    };
    const checks = Object.entries(c.expect).map(([k, v]) => {
      const ok = Array.isArray(v) ? v.includes(got[k]) : got[k] === v;
      total += 1; if (ok) pass += 1;
      return `${ok ? '✓' : '✗'} ${k}=${JSON.stringify(got[k])}${ok ? '' : ` (want ${JSON.stringify(v)})`}`;
    });
    console.log(`${c.name} [${data.mode}${data.cached ? ', cached' : ''}, ${((Date.now() - started) / 1000).toFixed(1)}s]\n  ${checks.join('\n  ')}`);
  }
  console.log(`\n${pass}/${total} checks passed · ${tokens} tokens total`);
})();
