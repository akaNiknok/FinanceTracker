#!/usr/bin/env node
/**
 * test.js — `npm test`. No Google account, no Cloudflare account, no dependencies.
 *
 * Three layers, in the order they run:
 *   1. the Apps Script leftovers (Gmail.gs, Backup.gs) through a vm, the same flat-
 *      namespace trick as v1 — Tests.gs PURE_TESTS still drives them;
 *   2. worker/src/*.js as plain ESM imports. Most of what used to need a vm is now a
 *      normal module, so most of this is normal unit testing;
 *   3. contract guards — source-text assertions over things whose FAILURE IS SILENT:
 *      a write handler that forgets to bump the version, a create path that loses its
 *      idempotency clause, a read route named so the SPA would POST it. Each of these
 *      breaks something far away from the edit that caused it.
 *
 * What is NOT here: anything needing a real database. The end-to-end check is
 * migrate/verify.js against the deployed Worker, and the balance reconciliation is
 * migrate/import.js against the frozen sheet.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { pathToFileURL } = require('url');

let failed = 0;
const pending = [];
const why = (e) => (e && e.message ? e.message : e);
/** Handles both shapes: a test may return a promise, and its rejection must still FAIL. */
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => console.log('  ok   ' + name),
        (e) => { failed++; console.error('  FAIL ' + name + ': ' + why(e)); }));
    } else console.log('  ok   ' + name);
  } catch (e) { failed++; console.error('  FAIL ' + name + ': ' + why(e)); }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── 1. Apps Script leftovers ────────────────────────────────────────────────
console.log('\nApps Script (vm):');
{
  const src = fs.readdirSync(__dirname).filter((f) => f.endsWith('.gs')).sort()
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n;\n');
  // ponytail: Logger and console are the only globals the pure tests touch.
  const sandbox = { console, Logger: { log: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'all.gs' });
  sandbox.PURE_TESTS.forEach((name) => test(name, () => vm.runInContext(name + '()', sandbox)));
}

(async function () {
  const load = (p) => import(pathToFileURL(path.join(__dirname, 'worker', p)).href);
  const db = await load('src/db.js');
  const jobs = await load('src/jobs.js');
  const tg = await load('src/telegram.js');
  const worker = await load('worker.js');

  // ── 2. units ──────────────────────────────────────────────────────────────
  console.log('\nWorker units:');

  test('micros round-trip exactly', () => {
    [0, 1, 0.01, 1234.56, -47.89, 2.5, 1e6].forEach((v) => assert.strictEqual(db.fromU(db.toU(v)), v));
    assert.strictEqual(db.toU(1234.565), 1234565000);   // no float dust in the integer
  });

  test('month keys are yyyy-MMM, everywhere', () => {
    assert.strictEqual(db.monthOf('2026-08-23'), '2026-Aug');
    assert.strictEqual(db.monthOf('2026-01-01'), '2026-Jan');
    assert.strictEqual(db.monthOf('2026-12-31'), '2026-Dec');
    assert.deepStrictEqual(db.parseMonthKey('2026-08'), { y: 2026, m: 7 });
    assert.deepStrictEqual(db.parseMonthKey('2026-Aug'), { y: 2026, m: 7 });
    assert.deepStrictEqual(db.parseMonthKey('2026-august'), { y: 2026, m: 7 });
    assert.strictEqual(db.parseMonthKey('nonsense'), null);
    // The SQL generated column builds the same string with substr on the date — if
    // these two ever disagree, every month-keyed screen silently matches nothing.
    const sqlish = (iso) => iso.slice(0, 4) + '-' +
      'JanFebMarAprMayJunJulAugSepOctNovDec'.substr((Number(iso.slice(5, 7)) - 1) * 3, 3);
    ['2026-01-05', '2026-06-30', '2026-11-11'].forEach((d) => assert.strictEqual(db.monthOf(d), sqlish(d)));
  });

  test('shiftMonth wraps years in both directions', () => {
    assert.deepStrictEqual(db.shiftMonth(2026, 0, -1), { y: 2025, m: 11 });
    assert.deepStrictEqual(db.shiftMonth(2026, 11, 1), { y: 2027, m: 0 });
    assert.deepStrictEqual(db.shiftMonth(2026, 7, -5), { y: 2026, m: 2 });
  });

  test('periodMonths gives the calendar quarter', () => {
    assert.deepStrictEqual(db.periodMonths('Monthly', { y: 2026, m: 7 }), ['2026-Aug']);
    assert.deepStrictEqual(db.periodMonths('Quarterly', { y: 2026, m: 7 }), ['2026-Jul', '2026-Aug', '2026-Sep']);
    assert.deepStrictEqual(db.periodMonths('Quarterly', { y: 2026, m: 0 }), ['2026-Jan', '2026-Feb', '2026-Mar']);
  });

  test('addDays crosses months and years without a timezone slip', () => {
    assert.strictEqual(db.addDays('2026-03-01', -1), '2026-02-28');
    assert.strictEqual(db.addDays('2026-01-01', -1), '2025-12-31');
    assert.strictEqual(db.addDays('2024-02-28', 1), '2024-02-29');   // leap year
  });

  test('manilaToday is Manila, not UTC', () => {
    // 2026-08-23T17:00Z is already the 24th in Manila (UTC+8). A bare toISOString here
    // is the bug the helper exists to prevent — the interest job would credit the
    // wrong closed day for eight hours out of every twenty-four.
    assert.strictEqual(db.manilaToday(new Date('2026-08-23T17:00:00Z')), '2026-08-24');
    assert.strictEqual(db.manilaToday(new Date('2026-08-23T15:59:00Z')), '2026-08-23');
  });

  test('parsePeriod normalises or throws — never writes a dead key', () => {
    assert.strictEqual(db.parsePeriod('2026-08'), '2026-Aug');
    assert.strictEqual(db.parsePeriod('2026-AUGUST'), '2026-Aug');
    assert.strictEqual(db.parsePeriod(''), '');
    assert.strictEqual(db.parsePeriod(null), '');
    assert.throws(() => db.parsePeriod('Aug 2026'));
    assert.throws(() => db.parsePeriod('2026-13'));
  });

  test('parseDate keeps an ISO date and never day-shifts it', () => {
    assert.strictEqual(db.parseDate('2026-01-02'), '2026-01-02');
    assert.strictEqual(db.parseDate(''), db.manilaToday());
  });

  test('deltas: liabilities invert, transfers move both sides', () => {
    // The whole balance model in one fold. Asset 1 earns and spends, liability 2 is
    // charged and partly paid off by a transfer, asset 3 funds that transfer.
    const refs = { acctById: { 1: { type: 'Asset' }, 2: { type: 'Liability' }, 3: { type: 'Asset' } } };
    const canned = [
      [{ id: 1, type: 'Income', s: 1000 }, { id: 1, type: 'Expense', s: 400 },
       { id: 2, type: 'Expense', s: 250 }, { id: 3, type: 'Transfer', s: 100 }],
      [{ id: 2, s: 50 }]
    ];
    const stmt = { bind: () => stmt };
    const env = { DB: { prepare: () => stmt, batch: async () => canned.map((results) => ({ results })) } };
    return db.deltas(env, refs).then((net) => {
      assert.strictEqual(net[1], 600);          // +1000 -400
      assert.strictEqual(net[2], 200);          // liability: -(-250) + -(50) = +250 -50
      assert.strictEqual(net[3], -100);         // transfer out
    });
  });

  test('shapeAccounts: signs, credit, and share pricing', () => {
    const refs = { accounts: [
      { id: 1, name: 'Cash', currency: 'PHP', subtype: 'Savings', type: 'Asset', starting_balance_u: 1e6 },
      { id: 2, name: 'Card', currency: 'PHP', subtype: 'Credit', type: 'Liability', starting_balance_u: 0, credit_limit_u: 50e6 },
      { id: 3, name: 'IBKR', currency: 'SHARES', subtype: 'Shares', type: 'Asset', symbol: 'VOO', starting_balance_u: 0 }
    ] };
    const out = db.shapeAccounts(refs, { 1: 0.5e6, 2: 20e6, 3: 2.5e6 },
      { VOO: { price: 500, currency: 'USD' } }, { PHP: 1, USD: 50 });
    const by = Object.fromEntries(out.map((a) => [a.name, a]));
    assert.ok(near(by.Cash.balancePhp, 1.5) && near(by.Cash.netWorthPhp, 1.5));
    assert.strictEqual(by.Card.balancePhp, 20);        // as shown: a liability is positive
    assert.strictEqual(by.Card.netWorthPhp, -20);      // signed: it pulls net worth down
    assert.strictEqual(by.Card.availableCredit, 30);
    assert.strictEqual(by.Cash.availableCredit, null); // an asset has none
    assert.strictEqual(by.IBKR.balanceNative, 2.5);    // native = the QUANTITY
    assert.strictEqual(by.IBKR.balancePhp, 62500);     // 2.5 x $500 x 50
    assert.ok(by.IBKR.isShares && by.IBKR.isInvestment && !by.Cash.isInvestment);
  });

  test('shapeTx blanks are the sheet blanks the SPA expects', () => {
    const refs = { acctById: { 1: { name: 'Cash', currency: 'PHP' } },
                   catById: { 9: { name: 'Food', type: 'Expense', segment: 'Essentials' } } };
    const t = db.shapeTx({ id: 'x', date: '2026-08-01', period: null, category_id: 9, description: null,
                           account_id: 1, amount_u: 12345000, fx_rate: null, to_account_id: null,
                           to_amount_u: null, month: '2026-Aug', amount_php_u: 12345000 }, refs);
    assert.strictEqual(t.Amount, 12.345);
    assert.strictEqual(t['Amount (PHP)'], 12.345);
    ['Period', 'Description', 'ExchangeRate', 'ToAccount', 'ToAmount', 'ToCurrency']
      .forEach((k) => assert.strictEqual(t[k], '', k + ' must be "" and not null'));
    assert.strictEqual(t.Type, 'Expense');
  });

  test('interestNetU: gross/365 less 20% withholding, to the centavo', () => {
    // 100,000.00 at 4%: 100000*0.04/365 = 10.9589; x0.8 = 8.7671 -> 8.77
    assert.strictEqual(jobs.interestNetU(100000e6, 0.04), 8.77e6);
    assert.strictEqual(jobs.interestNetU(0, 0.04), 0);
  });

  test('parsePositions reads an IBKR Flex statement', () => {
    const xml = '<FlexQueryResponse><FlexStatement fromDate="20260822" toDate="20260822">' +
      '<OpenPositions><OpenPosition symbol="VOO" position="2.5" markPrice="512.34" currency="USD" />' +
      '<OpenPosition symbol="BAD" position="1" markPrice="" currency="USD" />' +
      '</OpenPositions></FlexStatement></FlexQueryResponse>';
    const p = jobs.parsePositions(xml);
    assert.strictEqual(p.length, 1);                   // a price-less row is skipped, not zeroed
    assert.deepStrictEqual(p[0], { symbol: 'VOO', price: 512.34, currency: 'USD', position: 2.5, pricedAt: '2026-08-22' });
  });

  test('telegram undo payloads round-trip inside the 64-byte cap', () => {
    assert.deepStrictEqual(tg.undoIds(tg.undoData('tg-90210', [0, 2])), ['tg-90210-0', 'tg-90210-2']);
    const gm = tg.undoData('gm-198f2a3b4c5d6e7f', [0]);
    assert.ok(gm.length <= 64);
    assert.deepStrictEqual(tg.undoIds(gm), ['gm-198f2a3b4c5d6e7f-0']);
    // Receipts sent before the prefix named a source are digits-only and mean Telegram.
    assert.deepStrictEqual(tg.undoIds('u:90210:1'), ['tg-90210-1']);
    ['', null, 'u:90210:', 'u::0', 'undo', 'u:90210:0;DROP'].forEach((bad) =>
      assert.strictEqual(tg.undoIds(bad).length, 0, 'accepted ' + JSON.stringify(bad)));
  });

  test('telegram account matching and balance text', () => {
    const accts = [{ name: 'Maya Savings', currency: 'PHP', balancePhp: 100, netWorthPhp: 100 },
                   { name: 'BPI', currency: 'PHP', balancePhp: 50, netWorthPhp: 50 },
                   { name: 'Card', currency: 'PHP', balancePhp: 20, netWorthPhp: -20, isLiability: true }];
    assert.strictEqual(tg.matchAccounts(accts, 'maya').length, 1);
    assert.strictEqual(tg.matchAccounts(accts, '').length, 3);
    const text = tg.balanceText(accts, null);
    assert.ok(text.includes('owed'), 'a liability must be marked owed');
    assert.ok(text.includes('₱130'), 'total is signed net worth (100+50-20), got: ' + text);
  });

  test('querySummary sums absolute PHP and caps the list', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      ({ Date: '2026-08-0' + (i + 1), Category: 'Food', 'Amount (PHP)': -10 }));
    const s = tg.querySummary(rows, 7);
    assert.ok(s.includes('₱70'), s);
    assert.ok(s.includes('2 more'), s);
    assert.strictEqual(tg.querySummary([], 0), 'No matching transactions.');
  });

  // ── 3. contract guards ────────────────────────────────────────────────────
  console.log('\nContract guards:');

  test('read routes are named get…/list…, write routes are not', () => {
    // worker/public/app.js picks GET vs POST off this prefix instead of shipping a
    // second copy of the table. Break the rule and the symptom is remote: a write
    // silently goes out as a GET and the API answers "requires POST".
    const READY = /^(get|list)/;
    Object.keys(worker.ROUTES_READ).forEach((a) =>
      assert.ok(READY.test(a), "read action '" + a + "' must be named get…/list…"));
    Object.keys(worker.ROUTES_WRITE).forEach((a) =>
      assert.ok(!READY.test(a), "write action '" + a + "' reads as a get…/list… name, so the SPA will GET it"));
  });

  test('every write handler bumps the data version in its own batch', () => {
    // The successor to "every write handler must end with cache_bumpVersion_()". Forget
    // it and the SPA keeps serving a cached screen after the write — no error anywhere.
    const DELEGATES = { ingestEmail: 1 };   // routes through createTransaction/createTransfer
    Object.keys(worker.ROUTES_WRITE).forEach((name) => {
      if (DELEGATES[name]) return;
      assert.ok(worker.ROUTES_WRITE[name].toString().includes('bumpStmt'),
        name + ' does not call bumpStmt — its writes would leave stale caches everywhere');
    });
  });

  test('both create paths keep their idempotency contract', () => {
    // The SPA's offline queue replays creates, and a replay may be of a write that
    // ALREADY landed (the connection can die after the row was committed). The only
    // thing making that safe is the conflict clause plus the 'duplicate' status; the
    // Telegram retry dedup rides on the same two.
    ['createTransaction', 'createTransfer'].forEach((name) => {
      const src = worker.ROUTES_WRITE[name].toString();
      assert.ok(src.includes('ON CONFLICT(id) DO NOTHING'), name + ' lost its ON CONFLICT clause');
      assert.ok(src.includes("'duplicate'"), name + ' no longer reports {status:"duplicate"}');
      assert.ok(src.includes('meta.changes'), name + ' no longer detects the no-op insert');
    });
  });

  test('button glyphs stay outside the emoji set', () => {
    // A text variation selector does NOT stop Telegram emoji-fying a glyph: it renders
    // every Emoji=Yes codepoint with its own emoji font and ignores U+FE0E, which is
    // how "↩︎ Undo" once shipped as a yellow ↩️. ❌ and ⛔ are deliberately emoji.
    // Comments stripped first: the file's own header names the banned glyphs in order
    // to explain the rule, and that must not trip the rule.
    const src = fs.readFileSync(path.join(__dirname, 'worker', 'src', 'telegram.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ['↩', '✉', '📧', '✏'].forEach((bad) =>
      assert.ok(!src.includes(bad), bad + ' is Emoji=Yes — use ↻ / ⌕ / ✎ instead'));
    ['↻', '⌕', '✎'].forEach((good) => assert.ok(src.includes(good), 'lost the ' + good + ' button glyph'));
  });

  test('the SPA loads and no longer stamps a _v cache bucket', () => {
    // The Worker's KV read cache went away with Apps Script; a `_v` on the URL would now
    // be a cache-buster on nothing. Running app.js here also proves it still parses.
    const noop = () => {};
    const app = {
      console: { log: noop, warn: noop, error: noop },
      navigator: {}, window: { addEventListener: noop },
      document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
      setTimeout, clearTimeout, Date, Math, JSON, encodeURIComponent, URLSearchParams,
      history: {}, location: { search: '', href: 'https://x/' }
    };
    app.globalThis = app;
    let seen = '';
    app.fetch = (u) => { seen = u; return Promise.resolve({ status: 200, json: () => Promise.resolve({ status: 'ok' }) }); };
    vm.createContext(app);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'worker', 'public', 'app.js'), 'utf8'), app, { filename: 'app.js' });
    assert.ok(app.SCREEN_FNS.admin, 'the Admin screen is not registered');
    app.S.dataVersion = 41; app.S._verAt = Date.now();
    return app.gs('api_getDashboard', {}).then(() => {
      assert.ok(!/_v=/.test(seen), 'gs() still stamps _v: ' + seen);
      assert.ok(/action=getDashboard/.test(seen), seen);
    });
  });

  await Promise.all(pending);
  console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nAll tests passed.');
  process.exit(failed ? 1 : 0);
})();
