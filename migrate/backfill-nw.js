#!/usr/bin/env node
/**
 * backfill-nw.js — reconstruct pre-migration monthly net worth into nw_snapshots.
 *
 *   npm run dev:pull                         # produces worker/.dev-data.sql (real data)
 *   node migrate/backfill-nw.js > backfill-nw.sql
 *   cd worker && npx wrangler d1 execute financetracker --remote --file=../backfill-nw.sql
 *
 * The cron (jobs.js snapshotNetWorth) only records net worth going forward. This
 * one-shot fills the past: for every month in the ledger that has no snapshot yet
 * it folds each account's native balance AS OF that month-end (db.js deltas), then
 * values it with the REAL FX and share prices of that month. It reuses the app's
 * own deltas / shapeAccounts / netWorthTotals, so a backfilled figure is computed
 * exactly like a live one — only the price/FX inputs are historical.
 *
 * DATA SOURCE: Yahoo Finance's v8 chart endpoint (keyless, needs a browser
 * User-Agent). It covers everything this portfolio holds, incl. the LSE-listed
 * UCITS ETFs (VWRA.L, IWVL.L, IB01.L, DFNS.L — all USD-quoted) and USD/PHP via
 * `USDPHP=X`, and it returns the quote currency in the response so nothing is
 * guessed. It is UNOFFICIAL — if Yahoo starts refusing, repoint `fetchDailySeries`
 * at a keyed provider. IBKR is NOT usable — Flex references one saved query whose
 * period is fixed in the portal (SendRequest takes no date), it only prices
 * currently-held symbols, and it has no PHP FX. Stooq's keyless CSV is now behind
 * a JavaScript proof-of-work wall.
 *
 * SYMBOL_MAP maps an IBKR ticker to its Yahoo symbol where they differ (the LSE
 * ETFs need a `.L` suffix; US names are identical and need no entry). A source
 * that fails for a symbol/currency is not fatal: that series is marked unavailable
 * and every month that needs it is SKIPPED and reported, so you get the months you
 * CAN value and a clear list of the ones you cannot.
 *
 * Output on stdout is SQL (ON CONFLICT DO NOTHING — never clobbers a real
 * snapshot); the report goes to stderr, so `> backfill-nw.sql` keeps them apart.
 * A month whose non-zero holding has no price/FX that far back is SKIPPED and
 * reported, never emitted half-valued.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) { console.error('backfill-nw needs Node 22+ (node:sqlite).'); process.exit(2); }

const DUMP = process.argv.find((a) => a.endsWith('.sql')) ||
  path.join(__dirname, '..', 'worker', '.dev-data.sql');
const SELFTEST = process.argv.includes('--self-test');
// --force (alias --all): re-value EVERY past month even where a snapshot already
// exists, and emit an upsert that OVERWRITES it (ON CONFLICT DO UPDATE) instead of
// the default DO NOTHING. This is how you re-run history after a valuation rule
// changes — e.g. reclassifying a near-cash ETF from invested to liquid — without
// first deleting production rows: applying the file just overwrites in place.
const FORCE = process.argv.includes('--force') || process.argv.includes('--all');

// IBKR ticker -> Yahoo symbol, where they differ. US names are identical (omit
// them); LSE-listed UCITS ETFs need the `.L` suffix. Quote currency is read from
// Yahoo's response, so it is not configured here.
const SYMBOL_MAP = { VWRA: 'VWRA.L', IWVL: 'IWVL.L', IB01: 'IB01.L', DFNS: 'DFNS.L' };
const yahooForSymbol = (sym) => SYMBOL_MAP[sym] || sym;
// Yahoo FX symbol for a currency quoted in PHP, e.g. USD -> 'USDPHP=X'.
const yahooForFx = (ccy) => ccy + 'PHP=X';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const M = 1e6;
const toU = (v) => Math.round(Number(v || 0) * M);
const log = (...a) => console.error(...a);

// ── the D1 shim over node:sqlite (same shape test-api.js uses) ────────────────
function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => {
      const st = db.prepare(sql);
      if (/^\s*(select|with)/i.test(sql)) return { results: st.all(...args) };
      const r = st.run(...args);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => s._exec()) };
}

// ── daily history — THE SWAP POINT (Yahoo Finance v8 chart, keyless) ──────────
// Returns { series:[{date:'yyyy-MM-dd', close:Number}] ascending, currency }, or
// throws. `sinceISO` bounds the fetch to the range we need (plus a buffer so the
// first month's as-of can still carry back to a prior trading day).
async function fetchDailySeries(yahooSym, sinceISO) {
  const p1 = Math.floor(Date.parse((sinceISO || '2000-01-01') + 'T00:00:00Z') / 1000) - 15 * 86400;
  const p2 = Math.floor(Date.now() / 1000);
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooSym) +
    '?period1=' + p1 + '&period2=' + p2 + '&interval=1d';
  const text = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error(yahooSym + ': not JSON (blocked?): ' + text.slice(0, 60).replace(/\s+/g, ' ')); }
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error(yahooSym + ': ' + ((j.chart && j.chart.error && j.chart.error.description) || 'no data'));
  const closes = r.indicators.quote[0].close;
  const series = r.timestamp.map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((x) => isFinite(x.close));
  series.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!series.length) throw new Error(yahooSym + ': no closes');
  return { series, currency: (r.meta && r.meta.currency) || null };
}
/** Latest close on or before asOf; null if the series does not reach that far back. */
function closeAsOf(series, asOf) {
  let v = null;
  for (const r of series) { if (r.date <= asOf) v = r.close; else break; }
  return v;
}

// Last calendar day of a month, as 'yyyy-MM-dd' (matches the ledger's local dates).
function monthEnd(y, m /* 0-based */) {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(last).padStart(2, '0');
}

// ── self-test: the valuation and the as-of lookup, no DB, no network ──────────
async function selfTest() {
  const assert = require('assert');
  const s = [{ date: '2026-03-30', close: 56 }, { date: '2026-03-31', close: 57 }, { date: '2026-04-01', close: 58 }];
  assert.strictEqual(closeAsOf(s, '2026-03-31'), 57);
  assert.strictEqual(closeAsOf(s, '2026-03-15'), null);   // before the series starts
  assert.strictEqual(closeAsOf(s, '2026-05-01'), 58);     // carries the last known close forward
  const db = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'db.js')).href);
  const api = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'api.js')).href);
  const refs = {
    accounts: [
      { id: 1, name: 'Bank', type: 'Asset', currency: 'PHP', subtype: 'Savings', starting_balance_u: toU(1000) },
      { id: 2, name: 'Wise', type: 'Asset', currency: 'USD', subtype: 'Savings', starting_balance_u: toU(100) },
      { id: 3, name: 'IBKR', type: 'Asset', currency: 'SHARES', subtype: 'Shares', symbol: 'VOO', starting_balance_u: toU(2) }
    ]
  };
  const accts = db.shapeAccounts(refs, {}, { VOO: { price: 300, currency: 'USD' } }, { USD: 50 });
  const t = api.netWorthTotals(accts);
  assert.strictEqual(t.netWorth, 1000 + 100 * 50 + 2 * 300 * 50);   // 1000 + 5000 + 30000
  assert.strictEqual(t.sharesValue, 30000);
  console.error('self-test passed.');
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'db.js')).href);
  const api = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'api.js')).href);
  const { refs, deltas, shapeAccounts, isSharesAcct, parseMonthKey, monthKey, monthOf, manilaMonth, shiftMonth } = db;

  if (!fs.existsSync(DUMP)) { log('No dump at ' + DUMP + ' — run `npm run dev:pull` first.'); process.exit(2); }
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(DUMP, 'utf8'));
  // The dump predates 0002 if it was taken before that migration hit prod; make
  // sure the table exists so the "already snapshotted" query works either way.
  try { sqlite.exec(fs.readFileSync(path.join(__dirname, '..', 'worker', 'migrations', '0002_nw_snapshots.sql'), 'utf8')); }
  catch (e) { /* already present in the dump */ }
  const env = { DB: d1(sqlite) };

  const r = await refs(env);
  const minRow = await env.DB.prepare('SELECT MIN(date) AS d FROM transactions').first();
  if (!minRow || !minRow.d) { log('No transactions — nothing to backfill.'); process.exit(0); }
  const have = new Set((await env.DB.prepare('SELECT month FROM nw_snapshots').all()).results.map((x) => x.month));

  // Backfill every month from the first ledger month up to LAST month (the live
  // month is left to the cron). Skip months that already have a snapshot.
  const first = parseMonthKey(monthOf(minRow.d));
  const liveKey = manilaMonth();
  const months = [];
  for (let c = first; monthKey(c.y, c.m) !== liveKey; c = shiftMonth(c.y, c.m, 1)) {
    const key = monthKey(c.y, c.m);
    if (FORCE || !have.has(key)) months.push({ key, y: c.y, m: c.m });
    if (months.length > 600) break;   // ~50 years, a sanity stop
  }
  if (!months.length) { log('Every past month already has a snapshot — nothing to do.'); process.exit(0); }

  // Distinct held symbols and the non-PHP currencies we must value.
  const symbols = [...new Set(r.accounts.filter((a) => isSharesAcct(a) && a.symbol).map((a) => a.symbol))];
  const currencies = [...new Set(r.accounts
    .filter((a) => !isSharesAcct(a) && String(a.currency).toUpperCase() !== 'PHP')
    .map((a) => String(a.currency).toUpperCase()))];

  log('Backfilling ' + months.length + ' month(s): ' + months[0].key + ' … ' + months[months.length - 1].key +
    (FORCE ? '  [--force: overwriting existing snapshots]' : ''));
  log('Share symbols: ' + (symbols.join(', ') || '(none)') + ' · currencies: ' + (currencies.join(', ') || '(none, PHP only)'));

  // Fetch each price/FX series once (bounded to the range we need), then read
  // as-of per month. A failure is recorded, not thrown: the honesty gate skips
  // the months it hits. Share currency comes from Yahoo's own response.
  const since = monthEnd(months[0].y, months[0].m);
  const priceSeries = {}, fxSeries = {}, failures = [];
  for (const sym of symbols) {
    const ysym = yahooForSymbol(sym);
    try { const d = await fetchDailySeries(ysym, since); priceSeries[sym] = d;
      log('  price ' + sym + ' <- ' + ysym + ' (' + d.series.length + ' days, ' + d.currency + ')'); }
    catch (e) { priceSeries[sym] = { series: [], currency: null }; failures.push('price ' + sym + ' (' + ysym + '): ' + e.message); log('  price ' + sym + ' — FAILED: ' + e.message); }
  }
  for (const ccy of currencies) {
    const ysym = yahooForFx(ccy);
    try { fxSeries[ccy] = (await fetchDailySeries(ysym, since)).series;
      log('  fx ' + ccy + '/PHP <- ' + ysym + ' (' + fxSeries[ccy].length + ' days)'); }
    catch (e) { fxSeries[ccy] = []; failures.push('fx ' + ccy + '/PHP (' + ysym + '): ' + e.message); log('  fx ' + ccy + '/PHP — FAILED: ' + e.message); }
  }

  const out = [];
  let skipped = 0;
  for (const mo of months) {
    const asOf = monthEnd(mo.y, mo.m);
    const net = await deltas(env, r, asOf);
    const fx = {}; currencies.forEach((c) => { const v = closeAsOf(fxSeries[c], asOf); if (v != null) fx[c] = v; });
    const prices = {};
    symbols.forEach((sym) => { const v = closeAsOf(priceSeries[sym].series, asOf); if (v != null) prices[sym] = { price: v, currency: priceSeries[sym].currency }; });

    const accts = shapeAccounts(r, net, prices, fx);
    // Honesty gate: a non-zero holding we could not value makes the total wrong.
    const gap = accts.find((a) => a.netWorthPhp === null && a.balanceNative);
    if (gap) { log('  SKIP ' + mo.key + ' — no ' + (gap.isShares ? 'price for ' + gap.name : 'FX for ' + gap.currency) + ' at ' + asOf); skipped++; continue; }

    const t = api.netWorthTotals(accts);
    const conflict = FORCE
      ? 'ON CONFLICT(month) DO UPDATE SET net_worth_u=excluded.net_worth_u, assets_u=excluded.assets_u, ' +
        'liabilities_u=excluded.liabilities_u, shares_u=excluded.shares_u, taken_at=excluded.taken_at'
      : 'ON CONFLICT(month) DO NOTHING';
    out.push("INSERT INTO nw_snapshots (month, net_worth_u, assets_u, liabilities_u, shares_u, taken_at) VALUES ('" +
      mo.key + "'," + toU(t.netWorth) + ',' + toU(t.assets) + ',' + toU(t.liabilities) + ',' + toU(t.sharesValue) +
      ",'" + asOf + "T00:00:00.000Z') " + conflict + ";");
    log('  ' + mo.key + '  net worth ' + Math.round(t.netWorth).toLocaleString());
  }

  if (out.length) {
    process.stdout.write('-- backfill-nw.sql — reconstructed monthly net worth (Yahoo Finance prices + FX)\n');
    process.stdout.write('-- Generated ' + new Date().toISOString() +
      (FORCE ? '. --force: OVERWRITES every past month in place (ON CONFLICT DO UPDATE).\n'
             : '. Apply once; ON CONFLICT keeps real snapshots.\n'));
    process.stdout.write(out.join('\n') + '\n');
  }
  if (failures.length) { log('\nData sources that failed (fix SYMBOL_MAP / repoint fetchDailySeries):'); failures.forEach((f) => log('  - ' + f)); }
  log('\nDone: ' + out.length + ' month(s) written, ' + skipped + ' skipped.');
  if (!out.length) log('Nothing was written — every month needs a series that could not be fetched.');
}

(SELFTEST ? selfTest() : main()).catch((e) => { console.error('backfill failed: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
