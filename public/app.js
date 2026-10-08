'use strict';

const $ = (id) => document.getElementById(id);
const STORE = 'contest-scout:v1';

const DEFAULT_PROFILE = {
  who: 'A one-person creator studio run with AI agents (X account, blog, short videos).',
  strengths: 'Writing, AI images, short-form video, Korean + basic English, fast turnaround.',
  limits: 'No hardware or robotics, no offline travel abroad, small budget, one human for sign-ups.',
  country: 'South Korea / Korean',
  hours: 10,
};

let state = load();
let selected = null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (s && Array.isArray(s.items)) return { profile: { ...DEFAULT_PROFILE, ...s.profile }, items: s.items };
  } catch { /* storage unavailable: start fresh */ }
  return { profile: { ...DEFAULT_PROFILE }, items: [] };
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* ignore */ }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysLeft(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86400000);
}
function localDeadline(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return 'unknown';
  return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

// ---------- status ----------

fetch('/api/status').then((r) => r.json()).then((s) => {
  const m = $('mode');
  if (s.mode === 'live') {
    m.textContent = `Live · ${s.models.reason || s.models.fast}`;
    m.classList.add('live');
  } else {
    m.textContent = 'Demo mode (no API key)';
  }
}).catch(() => { $('mode').textContent = 'Server offline'; });

// ---------- profile ----------

const PF = { who: 'p-who', strengths: 'p-strengths', limits: 'p-limits', country: 'p-country', hours: 'p-hours' };
for (const [k, id] of Object.entries(PF)) $(id).value = state.profile[k] ?? '';
$('profile-save').onclick = () => {
  for (const [k, id] of Object.entries(PF)) state.profile[k] = k === 'hours' ? Number($(id).value || 0) : $(id).value.trim();
  save();
  $('profile-save').textContent = 'Saved';
  setTimeout(() => { $('profile-save').textContent = 'Save profile'; }, 1200);
};

// ---------- analyze ----------

$('analyze-form').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('url').value.trim();
  const text = $('text').value.trim();
  const msg = $('analyze-msg');
  if (!url && !text) { msg.textContent = 'Give a URL or paste the page text.'; msg.className = 'msg err'; return; }
  $('analyze-btn').disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Reading the page and scoring it… (extract → score, two model calls)';
  try {
    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, text, lang: $('lang').value, today: today(), profile: state.profile }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const item = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), addedAt: new Date().toISOString(), done: {}, ...data };
    state.items.push(item);
    save();
    $('url').value = ''; $('text').value = '';
    msg.textContent = data.mode === 'demo' ? 'Added (demo mode: rule-based guess).' : `Added. Tokens: ${data.usage.map((u) => u.total_tokens ?? '?').join(' + ')}`;
    selected = item.id;
    render();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  } finally {
    $('analyze-btn').disabled = false;
  }
};

// ---------- discover ----------

$('discover-form').onsubmit = async (e) => {
  e.preventDefault();
  const list = $('discover-list');
  list.innerHTML = '<li>Searching…</li>';
  try {
    const r = await fetch('/api/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: $('query').value }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (!data.results.length) { list.innerHTML = `<li>${esc(data.note || 'No results.')}</li>`; return; }
    list.innerHTML = data.results.map((x, i) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><br>${esc(x.snippet)}<br><button class="link" type="button" data-i="${i}">Analyze this</button></li>`).join('');
    list.querySelectorAll('button[data-i]').forEach((b) => {
      b.onclick = () => { $('url').value = data.results[b.dataset.i].url; $('text').value = ''; $('analyze-form').requestSubmit(); };
    });
  } catch (err) {
    list.innerHTML = `<li class="msg err">${esc(err.message)}</li>`;
  }
};

// ---------- board ----------

function sorted() {
  const rank = { go: 0, maybe: 1, skip: 2 };
  return [...state.items].sort((a, b) =>
    (rank[a.score?.verdict] ?? 3) - (rank[b.score?.verdict] ?? 3) ||
    (b.score?.total ?? 0) - (a.score?.total ?? 0) ||
    (daysLeft(a.contest?.deadline?.iso) ?? 9999) - (daysLeft(b.contest?.deadline?.iso) ?? 9999));
}

function render() {
  const hide = $('hide-skip').checked;
  const items = sorted().filter((x) => !hide || x.score?.verdict !== 'skip' || x.id === selected);
  $('board-empty').hidden = state.items.length > 0;
  $('board').innerHTML = items.map((x) => {
    const d = daysLeft(x.contest?.deadline?.iso);
    const dd = d == null ? 'deadline ?' : d < 0 ? 'closed' : `D-${d}`;
    const v = x.score?.verdict || 'maybe';
    return `<li class="card" tabindex="0" data-id="${x.id}" aria-current="${x.id === selected}">
      <div class="score">${x.score?.total ?? '–'}<small>/20</small></div>
      <div><div class="name">${esc(x.contest?.name)}</div>
        <div class="meta"><span class="dday ${d != null && d >= 0 && d <= 7 ? 'urgent' : ''}">${dd}</span> · ${esc(x.contest?.prizes?.summary || 'prize ?')}${x.mode === 'demo' ? ' · demo' : ''}${x.sample ? ' · sample' : ''}</div></div>
      <span class="verdict ${v}">${v}</span></li>`;
  }).join('');
  $('board').querySelectorAll('.card').forEach((c) => {
    const open = () => { selected = c.dataset.id; render(); $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    c.onclick = open;
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  renderDetail();
}
$('hide-skip').onchange = render;

function fact(label, value, evidence) {
  if (value == null || value === '') value = 'unknown';
  return `<dt>${esc(label)}</dt><dd>${esc(value)}${evidence ? `<q>${esc(evidence)}</q>` : ''}</dd>`;
}

function renderDetail() {
  const x = state.items.find((i) => i.id === selected);
  $('detail').hidden = !x;
  if (!x) return;
  const c = x.contest || {}, s = x.score || {};
  const sc = s.scores || {};
  const el = c.eligibility || {}, pr = c.prizes || {};
  const plan = s.plan || [];
  $('detail-body').innerHTML = `
    <h3>${esc(c.name)} ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">↗</a>` : ''}</h3>
    <div class="bars">
      <div class="bar"><b>${sc.win_odds ?? '–'}/5</b>Win odds</div>
      <div class="bar"><b>${sc.deadline ?? '–'}/5</b>Time</div>
      <div class="bar"><b>${sc.resources ?? '–'}/5</b>Resources</div>
      <div class="bar"><b>${sc.cash ?? '–'}/5</b>Cash</div>
    </div>
    <ul>${(s.why || []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    ${(s.blockers || []).length ? `<p class="flags"><b>Blockers:</b> ${s.blockers.map(esc).join(' · ')}</p>` : ''}
    <h3>Plan to the deadline</h3>
    ${plan.length ? `<ul class="plan">${plan.map((p, i) => `<li class="${x.done[i] ? 'done' : ''}">
        <input type="checkbox" data-i="${i}" ${x.done[i] ? 'checked' : ''} aria-label="done">
        <span class="date">${esc(p.date)}</span><span class="task">${esc(p.task)}</span>
        ${p.owner === 'human-only' ? '<span class="human">human only</span>' : ''}</li>`).join('')}</ul>` : '<p class="empty">No plan (demo mode or skipped).</p>'}
    <h3>Facts from the page</h3>
    <dl class="facts">
      ${fact('Deadline', `${localDeadline(c.deadline?.iso)}${c.deadline?.as_written ? ` (page: ${c.deadline.as_written})` : ''}`, c.deadline?.evidence)}
      ${fact('Who can enter', el.summary, el.evidence)}
      ${fact('Individuals OK', el.individuals_ok == null ? null : el.individuals_ok ? 'yes' : 'no')}
      ${fact('Online', el.online == null ? null : el.online ? 'yes' : 'no')}
      ${fact('Prizes', pr.summary, pr.evidence)}
      ${fact('Winners', pr.winner_count)}
      ${fact('Required tech', (c.required_tech || []).join(', '))}
      ${fact('Submit', (c.deliverables || []).map((d) => d.item).join(' · '))}
      ${fact('Judged on', (c.judging || []).join(' · '))}
    </dl>
    ${(c.red_flags || []).length ? `<p class="flags">⚠ ${c.red_flags.map(esc).join(' · ')}</p>` : ''}`;
  $('detail-body').querySelectorAll('.plan input').forEach((cb) => {
    cb.onchange = () => { x.done[cb.dataset.i] = cb.checked; save(); renderDetail(); };
  });
}

$('remove').onclick = () => {
  state.items = state.items.filter((i) => i.id !== selected);
  selected = null;
  save();
  render();
};

// ---------- export ----------

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('export-ics').onclick = () => {
  const x = state.items.find((i) => i.id === selected);
  if (!x) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const events = (x.score?.plan || []).map((p, i) => [
    'BEGIN:VEVENT', `UID:${x.id}-${i}@contest-scout`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${p.date.replace(/-/g, '')}`, `SUMMARY:${(x.contest.name + ': ' + p.task).replace(/[,;\n]/g, ' ')}`, 'END:VEVENT']);
  if (x.contest?.deadline?.iso) {
    const t = new Date(x.contest.deadline.iso).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    events.push(['BEGIN:VEVENT', `UID:${x.id}-deadline@contest-scout`, `DTSTAMP:${stamp}`, `DTSTART:${t}`, `SUMMARY:DEADLINE ${x.contest.name.replace(/[,;\n]/g, ' ')}`, 'END:VEVENT']);
  }
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Contest Scout//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  download('contest-plan.ics', ics, 'text/calendar');
};

$('export-md').onclick = () => {
  const rows = sorted().map((x) => {
    const d = daysLeft(x.contest?.deadline?.iso);
    return `| ${x.score?.total ?? '-'} | ${x.score?.verdict ?? '-'} | ${x.contest?.name ?? ''} | ${localDeadline(x.contest?.deadline?.iso)} (${d == null ? '?' : 'D-' + d}) | ${x.contest?.prizes?.summary ?? ''} | ${x.contest?.url ?? ''} |`;
  });
  download(`contest-board-${today()}.md`, `# Contest board ${today()}\n\n| Score | Verdict | Contest | Deadline | Prizes | Link |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`, 'text/markdown');
};

// ---------- sample board ----------

$('load-sample').onclick = async () => {
  try {
    const items = await (await fetch('sample-board.json')).json();
    state.items.push(...items.map((x) => ({ ...x, done: {}, sample: true })));
    save();
    render();
  } catch (e) {
    $('analyze-msg').textContent = 'Could not load sample: ' + e.message;
  }
};

render();
