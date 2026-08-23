#!/usr/bin/env node
/**
 * verify.js — the /api contract test for the v2.0.0 cutover. Node 18+, no dependencies.
 *
 *   BEFORE the cutover, against the live v1 app:
 *     node migrate/verify.js capture https://<worker>.workers.dev '<passphrase>'
 *   AFTER the import, against the same URL now serving v2:
 *     node migrate/verify.js check   https://<worker>.workers.dev '<passphrase>'
 *
 * `capture` writes one JSON file per read route into migrate/fixtures/ (gitignored —
 * it is real financial data). `check` calls the same routes again and diffs.
 *
 * TWO KINDS OF FINDING, and only one of them is a failure:
 *
 *   STRUCTURE (fatal). A key that appeared in v1 and not in v2, or the other way, or a
 *   type that changed. The prime directive of the migration is that the JSON contract
 *   does not move, so app.js keeps working untouched; this is what proves it.
 *
 *   VALUES (reported, judged by a human). Numbers are compared with a tolerance
 *   because two of them legitimately move between the two runs: the USD/PHP rate is
 *   live in both v1 and v2, and share prices come from GOOGLEFINANCE in v1 and IBKR in
 *   v2. A PHP balance on a USD or Shares account is therefore EXPECTED to drift a
 *   little. A PHP-only account that moves at all is not — that is a real bug, and the
 *   report prints the FX rates side by side so you can tell the two apart.
 *
 * The exact-to-the-centavo check is a different tool: migrate/import.js reconciles
 * every native balance against the frozen sheet before the database is even created.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'fixtures');

// One entry per fixture: a file name and the request that produces it. Dashboard and
// Budgets are captured for three months because they are the two month-scoped payloads
// and a quarter boundary is where the period logic goes wrong.
function plan(month, prev1, prev2) {
  return [
    ['getBootstrap', {}],
    ['getDataVersion', {}],
    ['getAccounts', {}],
    ['getCategories', {}],
    ['getRecurring', {}],
    ['getInvestments', {}],
    ['getLedger', {}],
    ['getDashboard', { month }],
    ['getDashboard-prev1', { action: 'getDashboard', month: prev1 }],
    ['getDashboard-prev2', { action: 'getDashboard', month: prev2 }],
    ['getBudgets', { month }],
    ['getBudgets-prev1', { action: 'getBudgets', month: prev1 }],
    ['listTransactions', { limit: 200 }],
    ['listTransactions-month', { action: 'listTransactions', month, limit: 200 }],
    ['listTransactions-search', { action: 'listTransactions', search: 'a', limit: 50 }]
  ];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function manilaMonths() {
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' })
    .format(new Date());
  const y = +now.slice(0, 4), m = +now.slice(5, 7) - 1;
  const key = (d) => { const t = y * 12 + m + d; return Math.floor(t / 12) + '-' + MONTHS[((t % 12) + 12) % 12]; };
  return [key(0), key(-1), key(-2)];
}

async function login(base, pass) {
  const res = await fetch(base + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass })
  });
  if (!res.ok) throw new Error('login failed: HTTP ' + res.status);
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('login returned no cookie');
  return raw.split(';')[0];
}

async function read(base, cookie, name, args) {
  const action = args.action || name;
  const q = new URLSearchParams({ action });
  Object.keys(args).forEach((k) => { if (k !== 'action') q.set(k, args[k]); });
  const res = await fetch(base + '/api?' + q, { headers: { Cookie: cookie } });
  const body = await res.json();
  if (body && body.status === 'error') throw new Error(action + ': ' + body.message);
  return body;
}

// ── diffing ──────────────────────────────────────────────────────────────────
// Fields that are SUPPOSED to differ between the two runs and carry no contract weight.
const VOLATILE = /(^|\.)version$|(^|\.)exportedAt$/;
const TOL_ABS = 0.005;     // a centavo
const TOL_REL = 0.005;     // 0.5% — covers a live-FX / price-source shift, not a bug

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function diff(a, b, p, structure, values) {
  if (VOLATILE.test(p)) return;
  if (kind(a) !== kind(b)) { structure.push(p + ': ' + kind(a) + ' -> ' + kind(b)); return; }
  if (kind(a) === 'array') {
    if (a.length !== b.length) values.push(p + ': length ' + a.length + ' -> ' + b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], p + '[' + i + ']', structure, values);
    return;
  }
  if (kind(a) === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    ka.filter((k) => !(k in b)).forEach((k) => structure.push(p + '.' + k + ': missing in v2'));
    kb.filter((k) => !(k in a)).forEach((k) => structure.push(p + '.' + k + ': new in v2'));
    ka.filter((k) => k in b).forEach((k) => diff(a[k], b[k], p ? p + '.' + k : k, structure, values));
    return;
  }
  if (kind(a) === 'number') {
    const d = Math.abs(a - b);
    if (d > TOL_ABS && d > Math.abs(a) * TOL_REL) values.push(p + ': ' + a + ' -> ' + b);
    return;
  }
  if (a !== b) values.push(p + ': ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b));
}

// ── entry ────────────────────────────────────────────────────────────────────
(async function main() {
  const [mode, base, pass] = process.argv.slice(2);
  if (!/^(capture|check)$/.test(mode || '') || !base || !pass) {
    console.error("usage: node migrate/verify.js capture|check <https://worker-url> '<passphrase>'");
    process.exit(2);
  }
  const cookie = await login(base.replace(/\/+$/, ''), pass);
  const url = base.replace(/\/+$/, '');
  const items = plan(...manilaMonths());

  if (mode === 'capture') {
    fs.mkdirSync(DIR, { recursive: true });
    for (const [name, args] of items) {
      const body = await read(url, cookie, name, args);
      fs.writeFileSync(path.join(DIR, name + '.json'), JSON.stringify(body, null, 1));
      console.log('captured ' + name);
    }
    console.log('\n' + items.length + ' fixtures in ' + DIR + '. Re-run with `check` after the import.');
    return;
  }

  if (!fs.existsSync(DIR)) { console.error('No fixtures in ' + DIR + ' — run `capture` against v1 first.'); process.exit(2); }
  let structural = 0, valued = 0;
  const notes = [];
  for (const [name, args] of items) {
    const file = path.join(DIR, name + '.json');
    if (!fs.existsSync(file)) { console.log('SKIP ' + name + ' (no fixture)'); continue; }
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    let after;
    try { after = await read(url, cookie, name, args); }
    catch (err) { console.log('FAIL ' + name + ': ' + err.message); structural++; continue; }
    const structure = [], values = [];
    diff(before, after, '', structure, values);
    structural += structure.length; valued += values.length;
    console.log((structure.length ? 'STRUCTURE ' : values.length ? 'values    ' : 'ok        ') + name +
      (structure.length || values.length ? '  (' + structure.length + ' structural, ' + values.length + ' value)' : ''));
    structure.forEach((s) => console.log('    ! ' + s));
    values.slice(0, 12).forEach((s) => console.log('      ~ ' + s));
    if (values.length > 12) console.log('      ~ …' + (values.length - 12) + ' more');
    if (name === 'getBootstrap') notes.push('  fxUsdPhp: ' + before.fxUsdPhp + ' -> ' + after.fxUsdPhp +
      '   (both live; every USD/Shares PHP figure moves with it)');
  }
  console.log('\n' + notes.join('\n'));
  console.log('\n' + (structural
    ? structural + ' STRUCTURAL difference(s) — the contract moved, app.js will break. Fix before cutover.'
    : 'Contract intact: no structural differences.'));
  console.log(valued + ' value difference(s) beyond ' + TOL_ABS + ' / ' + (TOL_REL * 100) +
    '% — read them against the FX note above; a PHP-only account must not move at all.');
  process.exit(structural ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
