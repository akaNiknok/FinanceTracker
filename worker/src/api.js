/**
 * api.js — every /api handler. The port of Router.gs's two route tables plus
 * Transactions/Accounts/Budgets/Reads/Dashboard/Ledger/Cache .gs.
 *
 * THE PRIME DIRECTIVE OF THIS FILE: the JSON contract does not change. Same action
 * names, same argument names (the sheet's header casing — `Category`, `Amount`,
 * `Amount (PHP)`), same response keys, same {status:'error'|'duplicate'} semantics.
 * worker/public/app.js is untouched by the platform swap except for the new admin
 * screen. (The one contract change since: the `version` field went away in v2.9.0 —
 * an ETag over the response bytes replaced it, see worker.js readResponse.) The v1
 * fixture diff that proved it (migrate/verify.js) retired with the cutover;
 * test-api.js is the standing check.
 *
 * What DID change, and why it is less code rather than more:
 *   * su_lock_() + cache_bumpVersion_() are gone, and so is the data version that
 *     replaced them (v2.9.0). D1 batch() is transactional, so a write needs no lock;
 *     a read carries an ETag over its own bytes, so no write has a cache to bump.
 *   * the derivation band (ARRAYFORMULAs) is gone. Month and Amount (PHP) are
 *     generated columns; Type/Segment/Currency are JOINs. There is no "never write a
 *     derived column" rule left to break.
 *   * balances are computed here (db.js shapeAccounts) instead of read out of sheet
 *     formulas. Same numbers — reconciled to the centavo at the v2.0.0 cutover.
 *
 * Handler signature is (args, env) and handlers THROW on rejection; worker.js turns
 * a throw into {status:'error', message}, exactly as Router.gs's try/catch did.
 */
import {
  refs, deltas, latestPrices, shapeAccounts, shapeTx, metaGet, metaAll,
  toU, fromU, q2, parseDate, parsePeriod, parseMonthKey,
  monthKey, monthOf, shiftMonth, periodMonths, manilaMonth, manilaToday, manilaYesterday, BASE_CURRENCY,
  isInvestedNetWorth, isPulseAcct, isSharesAcct, NOT_SHARES_SRC, resolveAccount, resolveCategory
} from './db.js';
import { fxMap, resolveRate } from './fx.js';

// The Ledger's column names, which are still the sheet's — the Tax screen renders
// these strings and LEDGER_COL_ORDER in app.js sorts by them.
const LEDGER_TXID = 'Transaction ID';
const LEDGER_TX_CATEGORY = 'Income: Salary';   // the only category the Tax screen links
const LEDGER_DERIVED = ['Date Received', 'Reporting Period', 'Wise Amount', 'Total Income', '8% Tax'];
const LEDGER_COLS = ['Date Received', 'Reporting Period', 'Filed?', 'Wise Amount',
                     'BSP Reference Rate', 'Total Income', '8% Tax', LEDGER_TXID];
const LEDGER_EDIT = { 'BSP Reference Rate': 'bsp_rate', 'Filed?': 'filed', [LEDGER_TXID]: 'tx_id' };

// Fields a client may supply on a transaction create/update (port of TX_CLIENT_FIELDS).
const TX_CLIENT_FIELDS = ['Date', 'Period', 'Category', 'Description', 'Account',
                          'Amount', 'ExchangeRate', 'ToAccount', 'ToAmount'];

// ── shared helpers ───────────────────────────────────────────────────────────
const list = (n) => new Array(n).fill('?').join(',');

/**
 * Invariant, unchanged from tx_assertShape_: a Transfer-type category iff the row
 * carries a destination. A mismatch makes the balance math and the budgets read the
 * row wrong, so every create/update/bulk path rejects it.
 */
function assertShape(type, hasTo) {
  if (type === 'Transfer' && !hasTo) throw new Error('A Transfer category requires a destination account (ToAccount).');
  if (type !== 'Transfer' && hasTo) throw new Error('Only a Transfer category may have a ToAccount.');
}
const hasTo = (v) => !!(v && String(v).trim() !== '');

/**
 * A zero row is never a real event: it moves nothing, it renders as a blank line and
 * it is what an empty form or a mis-parsed message produces. Checked in MICROS, so
 * an amount that rounds to zero is caught too — the same test Release 2's
 * CHECK (amount_u != 0) will make the database enforce. A NEGATIVE amount is legal:
 * that is how a refund is recorded (negative expense, original category).
 */
function assertNonZero(label, v) {
  if (toU(v) === 0) throw new Error(label + ' must not be zero.');
}

/**
 * F16 advisory: the same account, category, amount and date, twice, from two different
 * ids. Idempotency only catches a REPLAY of one id, so a genuine double-log (two
 * Telegram messages, one purchase) sails through. Advisory on purpose — same-day
 * repeats are real (two coffees), so this warns and never blocks.
 */
async function duplicateWarning(env, id, row) {
  const hit = await env.DB.prepare(
    'SELECT id FROM transactions WHERE account_id = ? AND category_id = ? AND amount_u = ? ' +
    'AND date = ? AND id != ? LIMIT 1')
    .bind(row.account_id, row.category_id, row.amount_u, row.date, id).first();
  return hit ? 'Similar transaction exists (' + hit.id + ') — undo if duplicate.' : null;
}

/**
 * A same-currency transfer stores ToAmount == Amount, so an Amount-only edit has to
 * move both — otherwise the destination keeps crediting the old figure while the
 * source moves. An unequal pair is a deliberate cross-currency amount and is left
 * alone, as is an explicit ToAmount. Returns the ToAmount to write, or undefined.
 * Port of tx_mirrorToAmount_.
 */
function mirrorToAmount(cur, patch) {
  if (patch.Amount === undefined || patch.ToAmount !== undefined) return undefined;
  if (!hasTo(cur.ToAccount)) return undefined;
  if (Number(cur.ToAmount) !== Number(cur.Amount)) return undefined;
  return patch.Amount;
}

async function txById(env, r, id) {
  const row = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first();
  return row ? shapeTx(row, r) : null;
}

/** Accounts + the FX map they were priced with — the basis of four screens. */
async function accountsList(env, r) {
  const [net, prices] = await Promise.all([deltas(env, r), latestPrices(env)]);
  // USD is always resolved even when no account holds it: getDashboard reuses this map
  // for the budget bars, and a USD-capped target must not go null there while the
  // Budgets screen (which asks for USD explicitly) shows a figure.
  const fx = await fxMap(env, r.accounts.map((a) => a.currency)
    .concat(Object.values(prices).map((p) => p.currency)).concat(['USD']));
  return { accounts: shapeAccounts(r, net, prices, fx), fx };
}

// ── reads ────────────────────────────────────────────────────────────────────
export async function getAccounts(args, env) {
  const r = await refs(env);
  const { accounts } = await accountsList(env, r);
  return { status: 'success', accounts };
}

export async function getRecurring(args, env) {
  const rows = (await env.DB.prepare('SELECT * FROM recurring ORDER BY id').all()).results;
  return { status: 'success', rows: rows.map((r) => ({
    Description: r.description || '',
    Currency: r.currency || '',
    // Blank sheet cells were '' in v1, and the Recurring rows are full of them.
    Amount: r.amount_u == null ? '' : fromU(r.amount_u),
    'Transaction Fee': r.fee_u == null ? '' : fromU(r.fee_u),
    'Months Left': r.months_left == null ? '' : r.months_left,
    Group: r.grp || ''
  })) };
}

export async function listTransactions(args, env) {
  const r = await refs(env);
  const where = ['1 = 1'], bind = [];
  const add = (sql, ...v) => { where.push(sql); bind.push(...v); };
  if (args.id) add('t.id = ?', String(args.id));
  if (args.month) add('t.month = ?', String(args.month));
  if (args.date) add('t.date = ?', String(args.date));
  if (args.account) add('(a.name = ? OR ta.name = ?)', String(args.account), String(args.account));
  if (args.category) add('c.name = ?', String(args.category));
  if (args.segment) add('c.segment = ?', String(args.segment));
  if (args.type) add('c.type = ?', String(args.type));
  // The v1 haystack was Description + " " + Category, matched as one string — keep it
  // concatenated so a term spanning the two still matches. LIKE is ASCII-case-insensitive.
  if (args.search) add("(COALESCE(t.description,'') || ' ' || c.name) LIKE ?", '%' + String(args.search) + '%');

  const from = ' FROM transactions t JOIN categories c ON c.id = t.category_id ' +
               'JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id ' +
               'WHERE ' + where.join(' AND ');
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const limit = Math.max(1, parseInt(args.limit, 10) || 100);
  // rowid desc as the tie-break = insertion order, matching v1's __row tie-break, so
  // two same-day rows still show latest-entered first.
  const [cnt, page] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n' + from).bind(...bind),
    env.DB.prepare('SELECT t.*' + from + ' ORDER BY t.date DESC, t.rowid DESC LIMIT ? OFFSET ?')
      .bind(...bind, limit, offset)
  ]);
  return {
    status: 'success',
    total: cnt.results[0].n, offset, limit,
    transactions: page.results.map((row) => shapeTx(row, r))
  };
}

/**
 * Budget targets vs computed actuals. The plan lives in the budgets table; actuals
 * are one GROUP BY over the ledger and are never stored — same reasoning as
 * Budgets.gs, one query instead of a full-sheet scan.
 *
 * Actuals count Expense AND Transfer: a segment like Growth is funded by moving cash
 * into an investment account, so that transfer must draw the Growth budget down.
 *
 * The sums are SIGNED, not ABS: a refund is a negative-amount row in the original
 * expense category, and it must net the spend down. ABS() made a refund INFLATE the
 * figure it should reduce. Every ordinary row is positive by convention, so the two
 * agree everywhere except on a refund.
 */
async function budgetsPayload(env, monthArg, fx) {
  const ref = parseMonthKey(monthArg) || parseMonthKey(manilaMonth());
  const rows = (await env.DB.prepare('SELECT * FROM budgets ORDER BY id').all()).results;
  const incomePhp = Number(await metaGet(env, 'monthly_income_php', '0')) || 0;
  const usd = fx.USD || null;

  const needed = new Set();
  rows.forEach((b) => periodMonths(b.period, ref).forEach((m) => needed.add(m)));
  const keys = [...needed];
  const actual = Object.create(null);
  if (keys.length) {
    // Budgets count Transfers, so they are the one report a SELL leg can reach: its
    // amount_u is a share quantity. NOT_SHARES_SRC keeps quantities out of the peso
    // and dollar sums; the buy leg (IBKR -> ticker, real dollars) still counts.
    // Three sums per segment-month, because a budget is measured in the currency it
    // is planned in: `s` is the PHP total every other read speaks, `usd_s` is the
    // dollar total of the rows already denominated in dollars, and `rest_s` is the
    // PHP total of everything else (converted at the live rate when a USD budget
    // needs it). Summing dollars natively keeps a USD meter still while the peso
    // moves — the round trip through amount_php_u and back reprices every past row.
    const q = await env.DB.prepare(
      'SELECT TRIM(c.segment) AS seg, t.month AS m, SUM(t.amount_php_u) AS s, ' +
      "SUM(CASE WHEN a.currency = 'USD' THEN t.amount_u ELSE 0 END) AS usd_s, " +
      "SUM(CASE WHEN a.currency = 'USD' THEN 0 ELSE t.amount_php_u END) AS rest_s " +
      'FROM transactions t JOIN categories c ON c.id = t.category_id ' +
      'JOIN accounts a ON a.id = t.account_id ' +
      "WHERE c.type IN ('Expense','Transfer') AND " + NOT_SHARES_SRC +
      ' AND t.month IN (' + list(keys.length) + ') ' +
      'GROUP BY seg, m').bind(...keys).all();
    q.results.forEach((x) => { actual[x.seg + '|' + x.m] = x; });
  }

  const budgets = rows.map((b) => {
    const months = periodMonths(b.period, ref);
    const seg = String(b.segment).trim();
    const sum = (col) => months.reduce((s, m) => {
      const x = actual[seg + '|' + m];
      return s + (x ? (x[col] || 0) : 0);
    }, 0);
    const actualPhp = q2(fromU(sum('s')));
    // A Percent target is a share of PHP income, so it is planned in pesos whatever
    // the currency column says.
    const isUsd = b.target_type !== 'Percent' &&
                  String(b.currency || BASE_CURRENCY).toUpperCase() === 'USD';
    let targetPhp;
    if (b.target_type === 'Percent') {
      targetPhp = incomePhp ? q2((b.period === 'Quarterly' ? incomePhp * 3 : incomePhp) * b.target / 100) : null;
    } else if (isUsd) {
      targetPhp = usd ? q2(b.target * usd) : null;
    } else {
      targetPhp = q2(b.target);
    }
    const remaining = targetPhp === null ? null : q2(targetPhp - actualPhp);
    // The figures the meter reads, in `currency`. Dollar rows count as dollars; a
    // peso row inside a dollar budget is converted at the live rate, which is the
    // only rate that can express it (nothing stamps a PHP->USD rate at write time).
    const targetNative = isUsd ? q2(b.target) : targetPhp;
    const actualNative = isUsd
      ? q2(fromU(sum('usd_s')) + (usd ? fromU(sum('rest_s')) / usd : 0))
      : actualPhp;
    const remainingNative = targetNative === null ? null : q2(targetNative - actualNative);
    return {
      segment: b.segment, period: b.period, targetType: b.target_type,
      targetValue: b.target,
      // The currency the *Native figures are in — always a real code, so the client
      // formats them without knowing the plan's rules.
      currency: isUsd ? 'USD' : BASE_CURRENCY,
      targetPhp, actualPhp, remainingPhp: remaining,
      targetNative, actualNative, remainingNative,
      pctUsed: (targetNative === null || targetNative === 0) ? null : Math.round(actualNative / targetNative * 1000) / 10,
      isOver: remainingNative !== null && remainingNative < 0,
      window: months, notes: b.notes || null
    };
  });

  return { month: monthKey(ref.y, ref.m), incomePhp, fxUsdPhp: usd, budgets,
           essentialsRewards: combine(budgets, ['Essentials', 'Rewards']) };
}

/** Roll a few segments into one figure (Essentials + Rewards). Port of bud_combine_. */
function combine(budgets, names) {
  const picked = budgets.filter((b) => names.indexOf(b.segment) !== -1);
  if (!picked.length) return null;
  let target = 0, actual = 0, anyTarget = false;
  picked.forEach((b) => {
    actual += b.actualPhp || 0;
    if (b.targetPhp !== null) { target += b.targetPhp; anyTarget = true; }
  });
  const targetPhp = anyTarget ? q2(target) : null;
  const actualPhp = q2(actual);
  const remaining = targetPhp === null ? null : q2(targetPhp - actualPhp);
  return {
    segments: picked.map((b) => b.segment),
    targetPhp, actualPhp, remainingPhp: remaining,
    pctUsed: (targetPhp === null || targetPhp === 0) ? null : Math.round(actualPhp / targetPhp * 1000) / 10,
    isOver: remaining !== null && remaining < 0
  };
}

/**
 * The whole Budgets screen in one response. `recurring` rides along because the screen
 * always draws both and getRecurring is a handful of rows: two GETs meant two ETags to
 * revalidate and two round trips on a cell connection to learn nothing changed.
 * getRecurring stays a route of its own — getBootstrap and the admin grid still use it.
 */
export async function getBudgets(args, env) {
  const r = await refs(env);
  const fx = await fxMap(env, r.accounts.map((a) => a.currency).concat(['USD']));
  const [payload, recurring] = await Promise.all([
    budgetsPayload(env, args.month, fx),
    getRecurring({}, env)
  ]);
  return Object.assign({ status: 'success', recurring: recurring.rows }, payload);
}

/** The net-worth fold over shaped accounts, in raw PHP (q2 at the boundary).
 * Signs match what is STORED and what the API reports: `liabilities` is NEGATIVE
 * (it sums netWorthPhp, which is already signed), netWorth is signed, shares are a
 * subset of assets. The SPA's hero takes Math.abs of it. Do not "fix" the sign —
 * every nw_snapshots row on disk holds it this way. sharesValue uses
 * isInvestedNetWorth (subtype-based, NARROWER than the Holdings card's isInvestment)
 * so a near-cash share holding — a treasury ETF held as an EF, say — sits with liquid
 * here while still showing in Holdings. Shared by getDashboard and snapshotNetWorth
 * so the tile, chart and snapshot agree exactly.
 *
 * A RECEIVABLE that has gone negative is money the owner OWES, not an asset worth
 * less: it reports under liabilities, so a debt cannot hide inside the asset total. */
export function netWorthTotals(accounts) {
  let netWorth = 0, assets = 0, liabilities = 0, sharesValue = 0;
  accounts.forEach((a) => {
    const php = a.netWorthPhp == null ? 0 : a.netWorthPhp;
    if (isInvestedNetWorth(a)) sharesValue += a.balancePhp || 0;
    netWorth += php;
    if (a.isLiability || (php < 0 && isReceivable(a))) liabilities += php; else assets += php;
  });
  return { netWorth, assets, liabilities, sharesValue };
}

/** Money lent out (an Asset subtype). Negative means the flow reversed and the owner
 * is the borrower — the sign, not the subtype, says which way the debt runs. */
const isReceivable = (a) => /receivable/i.test(String(a.subtype || ''));

/** Cron: record this month's net worth (jobs.js runs it after prices, so it uses
 * fresh quotes). Upsert by month — the last write of a month is its close. Not an
 * /api write and not user data the SPA caches, so it deliberately does NOT bump
 * the data version: the current-month point on the chart uses live netWorth, and
 * a closed month's snapshot never changes. */
export async function snapshotNetWorth(env) {
  const r = await refs(env);
  const { accounts } = await accountsList(env, r);
  const t = netWorthTotals(accounts);
  // Yesterday's month, not today's. The cron runs 06:00 Manila, so the last run INSIDE
  // a month happens on its last day and would close the month without that day's
  // activity; the run on the 1st now writes the previous month's TRUE close. Days 2..n
  // still refresh the current month, so nothing else about the upsert changes. Same
  // convention as migrate/backfill-nw.js, which valued real month-ends.
  const month = monthOf(manilaYesterday());
  await env.DB.prepare(
    'INSERT INTO nw_snapshots (month, net_worth_u, assets_u, liabilities_u, shares_u, taken_at) ' +
    'VALUES (?,?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET net_worth_u = excluded.net_worth_u, ' +
    'assets_u = excluded.assets_u, liabilities_u = excluded.liabilities_u, ' +
    'shares_u = excluded.shares_u, taken_at = excluded.taken_at')
    .bind(month, toU(t.netWorth), toU(t.assets), toU(t.liabilities), toU(t.sharesValue), new Date().toISOString())
    .run();
  return { month, netWorth: q2(t.netWorth) };
}

export async function getDashboard(args, env) {
  const month = args.month ? String(args.month) : manilaMonth();
  const ref = parseMonthKey(month) || parseMonthKey(manilaMonth());
  const r = await refs(env);
  const { accounts, fx } = await accountsList(env, r);
  const totals = netWorthTotals(accounts);

  // Chart window, client-chosen (6 on a phone, 12 on a big screen, 24 on request).
  // Clamped because every key becomes a bound parameter in two queries below.
  const months = Math.min(24, Math.max(2, Math.round(Number(args.months)) || 6));
  const flowKeys = [];
  for (let i = months - 1; i >= 0; i--) { const s = shiftMonth(ref.y, ref.m, -i); flowKeys.push(monthKey(s.y, s.m)); }

  // Aggregation in SQL, not JS: the 10ms CPU budget is the one real constraint on
  // this handler, and a full-table scan in JS is what would break it.
  // Signed sums, no ABS: a refund is a negative expense row and nets its category down.
  const [spend, flow, recent, snaps] = await env.DB.batch([
    env.DB.prepare(
      // Single quotes only: SQLite reads "" as an identifier, not an empty string.
      "SELECT COALESCE(NULLIF(TRIM(c.segment), ''), 'Unsegmented') AS seg, c.name AS cat, " +
      'SUM(t.amount_php_u) AS s FROM transactions t JOIN categories c ON c.id = t.category_id ' +
      "WHERE t.month = ? AND c.type = 'Expense' GROUP BY seg, cat").bind(month),
    env.DB.prepare(
      'SELECT t.month AS m, c.type AS type, SUM(t.amount_php_u) AS s FROM transactions t ' +
      'JOIN categories c ON c.id = t.category_id ' +
      "WHERE t.month IN (" + list(flowKeys.length) + ") AND c.type IN ('Income','Expense') " +
      'GROUP BY m, type').bind(...flowKeys),
    env.DB.prepare('SELECT * FROM transactions ORDER BY date DESC, rowid DESC LIMIT 10'),
    env.DB.prepare('SELECT month, net_worth_u, shares_u FROM nw_snapshots WHERE month IN (' + list(flowKeys.length) + ')').bind(...flowKeys)
  ]);

  const spendBySegment = {}, spendByCategory = {};
  spend.results.forEach((x) => {
    spendBySegment[x.seg] = q2((spendBySegment[x.seg] || 0) + fromU(x.s));
    spendByCategory[x.cat] = q2((spendByCategory[x.cat] || 0) + fromU(x.s));
  });
  const byMonth = {};
  flowKeys.forEach((k) => { byMonth[k] = { month: k, income: 0, expense: 0 }; });
  flow.results.forEach((x) => {
    if (byMonth[x.m]) byMonth[x.m][x.type === 'Income' ? 'income' : 'expense'] = q2(fromU(x.s));
  });
  // Real historical net worth per month (nulls where no snapshot exists yet — the
  // client falls back to rolling cash flow backward for those). The live month is
  // omitted deliberately: the chart uses `netWorth` (now) for it, always fresher.
  // netWorthHistory = total; sharesHistory = the invested subset. The client
  // derives the liquid (non-shares) line as total − shares, so the cash-flow
  // bars and their overlaid line move together, and stacks the two into the
  // Net worth chart. Both omit the live month (chart uses live figures there).
  const netWorthHistory = {}, sharesHistory = {}, snapNw = {};
  snaps.results.forEach((s) => {
    snapNw[s.month] = q2(fromU(s.net_worth_u));
    if (s.month === manilaMonth()) return;
    netWorthHistory[s.month] = q2(fromU(s.net_worth_u));
    sharesHistory[s.month] = q2(fromU(s.shares_u));
  });

  return {
    status: 'success', month,
    netWorth: q2(totals.netWorth), assets: q2(totals.assets), liabilities: q2(totals.liabilities),
    sharesValue: q2(totals.sharesValue),
    spendBySegment, spendByCategory,
    cashflow: flowKeys.map((k) => byMonth[k]),
    netWorthHistory, sharesHistory,
    bridge: nwBridge(month, snapNw, byMonth, ref, totals.netWorth),
    budgets: (await budgetsPayload(env, month, fx)).budgets,
    recentTransactions: recent.results.map((row) => shapeTx(row, r))
  };
}

/**
 * The net-worth bridge: why did net worth move this much? Delta splits into what the
 * ledger explains (income - expense) and what it does not. The residual is market and
 * FX movement plus timing (a Period override reports a flow in a month its cash left
 * in another) — and, when it is large and unexplained, unlogged spending. Five weeks
 * of it once piled up into a single 33.7k catch-up row before anybody saw it.
 *
 * A closed month bridges snapshot to snapshot. The live month bridges the last
 * snapshot to live net worth, so today's figure is comparable. Null when the previous
 * month has no snapshot — history only accrues forward, so early months never bridge.
 */
export function nwBridge(month, snapNw, byMonth, ref, liveNetWorth) {
  const p = shiftMonth(ref.y, ref.m, -1);
  const from = monthKey(p.y, p.m);
  const live = month === manilaMonth();
  const start = snapNw[from];
  const end = live ? q2(liveNetWorth) : snapNw[month];
  const f = byMonth[month];
  if (start == null || end == null || !f) return null;
  const savings = q2(f.income - f.expense);
  return {
    month, from, live,
    startNetWorth: start, endNetWorth: end,
    deltaNetWorth: q2(end - start),
    savings,
    residual: q2(end - start - savings)
  };
}

/** 'yyyy-MM-dd' -> 'yyyy-Qn' (calendar quarter, same as the investment pulse). */
const quarterOf = (d) => d.slice(0, 4) + '-Q' + Math.ceil(+d.slice(5, 7) / 3);

export async function getInvestments(args, env) {
  const r = await refs(env);
  const { accounts } = await accountsList(env, r);
  const positions = accounts.filter((a) => a.isInvestment).map((a) => ({
    name: a.name, subtype: a.subtype, currency: a.currency,
    quantity: a.isShares ? a.balanceNative : null,
    valuePhp: a.balancePhp
  }));
  const total = positions.reduce((s, p) => s + (p.valuePhp || 0), 0);
  positions.forEach((p) => { p.weightPct = total ? Math.round((p.valuePhp || 0) / total * 1000) / 10 : 0; });

  // The trade legs ARE transfers into and out of share-priced accounts, so the history
  // needs no category discipline — it is derived from account subtypes and works
  // retroactively. Funding legs (Wise→IBKR) never appear here: IBKR itself is not
  // share-priced. A BUY runs cash→ticker, a SELL runs ticker→cash, and the two sides
  // swap meaning: on a sell, amount_u is the QUANTITY and to_amount_u is the money. One
  // UNION ALL normalises them to (cash, qty, side). A ticker→ticker move is neither and
  // is excluded from both arms, so nothing is counted twice.
  // This set is the BROAD one (isSharesAcct) because it also feeds the cost basis, which
  // every holding needs. The quarterly pulse takes a narrower slice of the same rows —
  // see pulseSymbols below.
  const shareIds = r.accounts.filter(isSharesAcct).map((a) => a.id);
  const ids = shareIds.length ? list(shareIds.length) : 'NULL';
  const monthKeys = [];   // last 3 CLOSED months, for the runway's average spend
  const ref = parseMonthKey(manilaMonth());
  for (let i = 3; i >= 1; i--) { const s = shiftMonth(ref.y, ref.m, -i); monthKeys.push(monthKey(s.y, s.m)); }
  const [legsQ, spendQ] = await env.DB.batch([
    env.DB.prepare(
      'SELECT t.date AS d, t.amount_u AS cash, t.to_amount_u AS qty, t.amount_php_u AS cash_php, ' +
      "b.name AS symbol, COALESCE(a.currency, 'USD') AS cur, 'buy' AS side FROM transactions t " +
      'JOIN accounts b ON b.id = t.to_account_id LEFT JOIN accounts a ON a.id = t.account_id ' +
      'WHERE t.to_account_id IN (' + ids + ') AND t.account_id NOT IN (' + ids + ') ' +
      'UNION ALL ' +
      // cash_php is NULL on a sell on purpose: amount_php_u there is a share count read
      // as pesos. A sale's peso cost comes out of the basis pool, never off the row.
      "SELECT t.date, t.to_amount_u, t.amount_u, NULL, a.name, COALESCE(b.currency, 'USD'), 'sell' " +
      'FROM transactions t JOIN accounts a ON a.id = t.account_id ' +
      'LEFT JOIN accounts b ON b.id = t.to_account_id ' +
      'WHERE t.account_id IN (' + ids + ') AND t.to_account_id IS NOT NULL ' +
      'AND t.to_account_id NOT IN (' + ids + ') ' +
      'ORDER BY d DESC').bind(...shareIds, ...shareIds, ...shareIds, ...shareIds),
    env.DB.prepare(
      'SELECT SUM(t.amount_php_u) AS s FROM transactions t JOIN categories c ON c.id = t.category_id ' +
      "WHERE c.type = 'Expense' AND t.month IN (" + list(monthKeys.length) + ')').bind(...monthKeys)
  ]);

  // Cost basis, average-cost method, walked oldest-first. A buy puts cash in the pool
  // and shares in the count; a sell takes cost OUT in proportion to the shares leaving,
  // so the average entry price does not move when you sell. Two pools, because the two
  // questions differ: poolNative is dollars actually paid, poolPhp is those dollars at
  // the rate stamped on the day (the historical peso cost, comparable to valuePhp).
  // investedNative is the separate house-money figure — cash in minus proceeds out — and
  // it goes NEGATIVE once a position has returned more than it ever cost.
  const basis = Object.create(null);
  for (let i = legsQ.results.length - 1; i >= 0; i--) {
    const x = legsQ.results[i];
    const b = basis[x.symbol] || (basis[x.symbol] =
      { qty: 0, poolNative: 0, poolPhp: 0, investedNative: 0, currency: x.cur });
    const cash = fromU(x.cash) || 0, qty = fromU(x.qty) || 0;
    if (x.side === 'buy') {
      // Funded from two different currencies over the position's life? Then no native
      // figure is true and only the peso pool means anything — every buy leg carries a
      // stamped rate, so poolPhp is always well defined.
      if (x.cur !== b.currency) b.mixed = true;
      b.qty += qty; b.poolNative += cash; b.poolPhp += fromU(x.cash_php) || 0;
      b.investedNative += cash;
    } else {
      const f = b.qty > 0 ? Math.min(1, qty / b.qty) : 0;
      b.qty -= qty; b.poolNative -= b.poolNative * f; b.poolPhp -= b.poolPhp * f;
      b.investedNative -= cash;
    }
  }
  positions.forEach((p) => {
    const b = basis[p.name];
    if (!b) return;
    p.costCurrency = b.mixed ? null : b.currency;
    p.investedNative = b.mixed ? null : q2(b.investedNative);
    p.avgCostNative = (b.mixed || b.qty <= 0) ? null : Math.round(b.poolNative / b.qty * 10000) / 10000;
    p.costPhp = q2(b.poolPhp);
    p.gainPhp = p.valuePhp == null ? null : q2(p.valuePhp - b.poolPhp);
    p.gainPct = (p.valuePhp == null || !b.poolPhp) ? null
      : Math.round((p.valuePhp / b.poolPhp - 1) * 1000) / 10;
  });
  const totalCostPhp = positions.reduce((s, p) => s + (p.costPhp || 0), 0);

  // Quarterly pulse: GROWTH holdings only. A leg into or out of a share-priced account
  // filed under a cash-like subtype (IB01, subtype EF) is EF parking, not investing, and
  // the runway card already measures it — counting it here reported the same peso twice
  // and inflated the quarter. Symbol is the ticker account's name on both arms, so one
  // name set filters the rows the pulse may see; the cost basis above still walks all of
  // them. Newest quarter first; the SPA flags the current quarter when it has no buys.
  const pulseSymbols = new Set(r.accounts.filter(isPulseAcct).map((a) => a.name));
  const quarters = [];
  legsQ.results.forEach((x) => {
    if (!pulseSymbols.has(x.symbol)) return;
    const q = quarterOf(x.d);
    let row = quarters[quarters.length - 1];
    if (!row || row.quarter !== q) { row = { quarter: q, totalUsd: 0, buys: [] }; quarters.push(row); }
    const amt = q2(fromU(x.cash));
    row.buys.push({ date: x.d, symbol: x.symbol, amount: amt, currency: x.cur,
                   quantity: fromU(x.qty), side: x.side });
    // A sale is negative flow in its quarter: the pulse answers "did I park money this
    // quarter", and money taken back out is not parking.
    if (x.cur === 'USD') row.totalUsd = q2(row.totalUsd + (x.side === 'sell' ? -amt : amt));
  });

  // Emergency runway: EF pesos are commingled with spending money (no dedicated EF
  // account), so the honest figure is the whole cash-like pool, expressed in months
  // of average spend. "Cash-like" reuses the net-worth liquid/invested split
  // (isInvestedNetWorth: IB01-as-EF counts, growth tickers don't) minus receivables
  // (money lent is not reachable in an emergency) minus credit balances.
  // ponytail: targetMonths is the doc's fixed 4-month rule; make it a meta key if it ever moves.
  const efPhp = accounts.reduce((s, a) => {
    if (a.isLiability) return s - (a.balancePhp || 0);
    if (isInvestedNetWorth(a)) return s;
    // A receivable is asymmetric on purpose: money LENT is not reachable in an
    // emergency, so a positive balance adds nothing — but a NEGATIVE one is money the
    // owner owes, and a debt does shorten the runway. Excluding both hid ₱13.6k of it.
    if (isReceivable(a)) return s + Math.min(0, a.balancePhp || 0);
    return s + (a.balancePhp || 0);
  }, 0);
  const avg = spendQ.results[0] && spendQ.results[0].s ? fromU(spendQ.results[0].s) / monthKeys.length : 0;
  const runway = {
    efPhp: q2(efPhp),
    avgMonthlyExpensePhp: q2(avg),
    months: avg ? Math.round(efPhp / avg * 10) / 10 : null,
    targetMonths: 4,
    targetPhp: avg ? q2(avg * 4) : null
  };

  return {
    status: 'success',
    totalValuePhp: q2(total), totalCostPhp: q2(totalCostPhp),
    totalGainPhp: q2(total - totalCostPhp), positions,
    pulse: { currentQuarter: quarterOf(manilaToday()), quarters },
    runway,
    coreTargets: { 60: 'Core', 25: 'Growth', 15: 'Speculative' },
    // Reference figures for the Accounts card, not a computed thing. These SUM TO 85
    // ON PURPOSE: Stability was removed in v2.3.0 (the EF accrues as unspent residue,
    // which no monthly meter can track — the runway card is its only measure), and the
    // missing 15 IS that residue. Do not "correct" it back to 100.
    segmentTargets: { Essentials: 50, Rewards: 10, Growth: 25 }
  };
}

export async function getBootstrap(args, env) {
  const r = await refs(env);
  const [{ accounts, fx }, meta, recurring, minRow] = await Promise.all([
    accountsList(env, r),
    metaAll(env),
    getRecurring({}, env),
    env.DB.prepare('SELECT MIN(date) AS d FROM transactions').first()
  ]);
  const categories = {};
  r.categories.forEach((c) => {
    categories[c.name] = { Type: c.type || null, Segment: c.segment || null, Description: c.description || null };
  });
  return {
    status: 'success',
    owner: meta.owner_email || '',
    baseCurrency: BASE_CURRENCY,
    categories,
    accounts,
    budgets: (await budgetsPayload(env, args.month, fx)).budgets,
    recurring: recurring.rows,
    fxUsdPhp: fx.USD || null,
    // Oldest ledger month, so the month pickers reach all history.
    minMonth: minRow && minRow.d ? monthOf(minRow.d) : null
  };
}

// ── ledger (Tax screen) ──────────────────────────────────────────────────────
/** One ledger_view row -> the {header: value} object the Tax screen renders. */
function shapeLedger(v) {
  return {
    __row: v.id,                       // the opaque row handle the UI sends back
    [LEDGER_TXID]: v.tx_id || '',
    'BSP Reference Rate': v.bsp_rate == null ? '' : v.bsp_rate,
    'Filed?': v.filed || '',
    // The sheet formula rendered this warning when the linked tx was gone; the
    // LEFT JOIN miss is the same condition, so the same string keeps the UI honest.
    'Date Received': v.tx_deleted ? '⚠ transaction deleted' : (v.date_received || ''),
    'Reporting Period': v.reporting_period || '',
    'Wise Amount': fromU(v.wise_amount_u),
    'Total Income': fromU(v.total_income_u),
    '8% Tax': fromU(v.tax_u)
  };
}

/**
 * ONE TAX YEAR, not the whole ledger. BIR files per year and the screen sorts newest
 * first, so every row before January was payload the phone downloaded to scroll past.
 * The set only grows — it is one row per payslip, forever — so an unbounded read was a
 * bill that went up every month.
 *
 * A row with NO date is always included, whatever the year: that is a link to a deleted
 * transaction (the view's tx_deleted), and a year filter must never be the reason a
 * broken row stops being visible. `years` is what the client's picker is drawn from.
 */
export async function getLedger(args, env) {
  const r = await refs(env);
  const cat = r.catByName[LEDGER_TX_CATEGORY];
  const [years, view, unlinked] = await env.DB.batch([
    env.DB.prepare("SELECT DISTINCT substr(date_received,1,4) AS y FROM ledger_view " +
      "WHERE date_received IS NOT NULL AND date_received <> '' ORDER BY y DESC"),
    env.DB.prepare("SELECT * FROM ledger_view WHERE substr(date_received,1,4) = ? " +
      "OR date_received IS NULL OR date_received = '' ORDER BY id")
      .bind(String(args.year || manilaToday().slice(0, 4))),
    env.DB.prepare('SELECT t.* FROM transactions t WHERE t.category_id = ? ' +
      'AND t.id NOT IN (SELECT tx_id FROM ledger WHERE tx_id IS NOT NULL) ' +
      'ORDER BY t.date DESC, t.rowid DESC').bind(cat ? cat.id : -1)
  ]);
  return {
    status: 'success',
    year: String(args.year || manilaToday().slice(0, 4)),
    years: years.results.map((x) => x.y),
    rows: view.results.map(shapeLedger),
    cols: LEDGER_COLS, derived: LEDGER_DERIVED, txIdCol: LEDGER_TXID,
    unlinked: unlinked.results.map((row) => shapeTx(row, r))
  };
}

/** Coerce a numeric-looking string to a Number so it feeds the view's arithmetic. */
function ledgerCoerce(v) {
  if (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, ''))) {
    return Number(v.replace(/,/g, ''));
  }
  return v == null ? '' : v;
}
/** header -> {column, value} for the three typed ledger columns. Throws otherwise. */
function ledgerCell(header, value) {
  const col = LEDGER_EDIT[header];
  if (!col) {
    if (LEDGER_DERIVED.indexOf(header) !== -1)
      throw new Error("'" + header + "' is formula-derived and can't be edited.");
    throw new Error('Unknown Ledger column: ' + header);
  }
  const v = ledgerCoerce(value);
  return { col, value: (v === '' ? null : (col === 'bsp_rate' ? Number(v) : String(v))) };
}

export async function updateLedgerCell(args, env) {
  const row = parseInt(args.row, 10);
  if (!row) throw new Error('updateLedgerCell requires a valid data row.');
  if (!args.header) throw new Error('updateLedgerCell requires a column header.');
  const { col, value } = ledgerCell(args.header, args.value);
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE ledger SET ' + col + ' = ? WHERE id = ?').bind(value, row)
  ]);
  if (!res.meta.changes) throw new Error('No ledger row ' + row + '.');
  const fresh = await env.DB.prepare('SELECT * FROM ledger_view WHERE id = ?').bind(row).first();
  return { status: 'success', row, header: args.header, values: shapeLedger(fresh) };
}

export async function appendLedgerRow(args, env) {
  const cols = [], vals = [];
  Object.keys(args).forEach((header) => {
    if (!LEDGER_EDIT[header]) return;                   // derived / unknown -> ignored, as in v1
    if (args[header] === undefined || args[header] === null || args[header] === '') return;
    const { col, value } = ledgerCell(header, args[header]);
    cols.push(col); vals.push(value);
  });
  if (!cols.length) throw new Error('Nothing to add — fill at least one editable field.');
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO ledger (' + cols.join(',') + ') VALUES (' + list(cols.length) + ')').bind(...vals)
  ]);
  return { status: 'success', row: res.meta.last_row_id };
}

export async function deleteLedgerRow(args, env) {
  const row = parseInt(args.row, 10);
  if (!row) throw new Error('deleteLedgerRow requires a valid data row.');
  const [res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM ledger WHERE id = ?').bind(row)
  ]);
  if (!res.meta.changes) throw new Error('No ledger row ' + row + '.');
  return { status: 'success', row };
}

// ── transaction writes ───────────────────────────────────────────────────────
/**
 * Create. Idempotent on a caller-supplied ID: ON CONFLICT DO NOTHING plus a
 * changes===0 check reports {status:'duplicate'} instead of a second row. The SPA's
 * offline queue and Telegram's retry dedup BOTH depend on that exact contract —
 * test.js fails if either half goes missing.
 *
 * ponytail: the version bump rides in the batch even when the insert was a duplicate.
 * A no-op replay therefore invalidates client caches once; that is one extra refetch
 * against saving a round trip on every real write. Split the batch only if replays
 * ever stop being rare.
 */
export async function createTransaction(args, env) {
  const r = await refs(env);
  if (!args.Category) throw new Error('Missing required field: Category');
  if (!args.Account) throw new Error('Missing required field: Account');
  const cat = resolveCategory(r, args.Category);
  if (!cat) throw new Error('Unknown Category: ' + args.Category);
  const acct = resolveAccount(r, args.Account);
  if (!acct) throw new Error('Unknown Account: ' + args.Account);
  if (args.Amount === undefined || args.Amount === '' || isNaN(parseFloat(args.Amount)))
    throw new Error('Missing/invalid required field: Amount');
  assertNonZero('Amount', args.Amount);
  assertShape(cat.type, false);   // a plain tx never has a destination

  const id = args.ID || crypto.randomUUID();
  const fx = await resolveRate(env, acct.currency, args.ExchangeRate);
  const row = { date: parseDate(args.Date), category_id: cat.id, account_id: acct.id, amount_u: toU(args.Amount) };
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO transactions (id, date, period, category_id, description, account_id, amount_u, fx_rate) ' +
      'VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id, row.date, parsePeriod(args.Period) || null, cat.id,
            args.Description || '', acct.id, row.amount_u, fx.blank ? null : fx.rate)
  ]);
  const transaction = await txById(env, r, id);
  if (!res.meta.changes) return { status: 'duplicate', message: 'ID already exists.', transaction };
  const out = { status: 'success', message: 'Transaction created.', transaction };
  const dup = await duplicateWarning(env, id, row);
  if (fx.warning || dup) out.warning = [fx.warning, dup].filter(Boolean).join(' ');
  return out;
}

/**
 * The rate to stamp on a transfer. A conversion that LANDS IN PESOS already knows its
 * own rate — ToAmount/Amount is the rate the transfer actually realised, spread and
 * fees included. The live rate is a different number, so stamping it valued the source
 * leg at a rate nobody got and made the conversion spread vanish from the books
 * (two prod rows, ~₱65 of phantom money). An explicit ExchangeRate still wins, and
 * every other shape falls through to resolveRate unchanged.
 *
 * Only a PHP destination qualifies: fx_rate converts the SOURCE amount to pesos, so
 * ToAmount/Amount is that rate only when ToAmount is in pesos. A PHP source needs no
 * rate at all (resolveRate returns blank), and a Shares leg is a quantity, not money.
 */
async function impliedRate(env, from, to, amount, toAmount, override) {
  const src = String(from.currency || '').toUpperCase(), dst = String(to.currency || '').toUpperCase();
  const usable = (override === undefined || override === null || override === '') &&
    src !== dst && dst === BASE_CURRENCY && src !== 'SHARES' &&
    Number(amount) && Number(toAmount);
  if (usable) return { rate: Math.abs(toAmount / amount), blank: false, source: 'implied' };
  return resolveRate(env, from.currency, override);
}

/** Transfer: ONE row carrying both sides, same as the sheet. Same idempotency contract. */
export async function createTransfer(args, env) {
  const r = await refs(env);
  if (!args.Account || !args.ToAccount) throw new Error('Transfer needs both Account and ToAccount.');
  const acct = resolveAccount(r, args.Account);
  if (!acct) throw new Error('Unknown Account: ' + args.Account);
  const to = resolveAccount(r, args.ToAccount);
  if (!to) throw new Error('Unknown ToAccount: ' + args.ToAccount);
  // Compare the RESOLVED rows, not the strings: "maribank" and "MariBank" name one
  // account, and a self-transfer would otherwise slip through as two different names.
  if (acct.id === to.id) throw new Error('Account and ToAccount must differ.');
  if (!args.Category) throw new Error('Transfer needs a Category (Transfer type).');
  const cat = resolveCategory(r, args.Category);
  if (!cat) throw new Error('Unknown Category: ' + args.Category);
  assertShape(cat.type, true);
  if (args.Amount === undefined || isNaN(parseFloat(args.Amount)))
    throw new Error('Missing/invalid Amount (source amount).');
  assertNonZero('Amount', args.Amount);

  const toAmount = (args.ToAmount !== undefined && args.ToAmount !== '')
    ? parseFloat(args.ToAmount) : parseFloat(args.Amount);
  assertNonZero('ToAmount', toAmount);
  const id = args.ID || crypto.randomUUID();
  const fx = await impliedRate(env, acct, to, args.Amount, toAmount, args.ExchangeRate);
  const row = { date: parseDate(args.Date), category_id: cat.id, account_id: acct.id, amount_u: toU(args.Amount) };
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO transactions (id, date, period, category_id, description, account_id, amount_u, fx_rate, to_account_id, to_amount_u) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id, row.date, parsePeriod(args.Period) || null, cat.id,
            args.Description || '', acct.id, row.amount_u, fx.blank ? null : fx.rate,
            to.id, toU(toAmount))
  ]);
  const transaction = await txById(env, r, id);
  if (!res.meta.changes) return { status: 'duplicate', message: 'ID already exists.', transaction };
  const out = { status: 'success', message: 'Transfer created.', transaction };
  const dup = await duplicateWarning(env, id, row);
  if (fx.warning || dup) out.warning = [fx.warning, dup].filter(Boolean).join(' ');
  return out;
}

export async function updateTransaction(args, env) {
  if (!args.ID) throw new Error('update requires an ID.');
  const r = await refs(env);
  const cur = await txById(env, r, args.ID);
  if (!cur) throw new Error('No transaction with ID: ' + args.ID);

  const nCat = args.Category === undefined ? null : resolveCategory(r, args.Category);
  const nAcct = args.Account === undefined ? null : resolveAccount(r, args.Account);
  const nTo = (args.ToAccount === undefined || args.ToAccount === '') ? null : resolveAccount(r, args.ToAccount);
  if (args.Category !== undefined && !nCat) throw new Error('Unknown Category: ' + args.Category);
  if (args.Account !== undefined && !nAcct) throw new Error('Unknown Account: ' + args.Account);
  if (args.ToAccount !== undefined && args.ToAccount !== '' && !nTo)
    throw new Error('Unknown ToAccount: ' + args.ToAccount);

  const patch = {};
  TX_CLIENT_FIELDS.forEach((f) => { if (args[f] !== undefined) patch[f] = args[f]; });
  // Canonical names from here down — every lookup below indexes the exact-name maps.
  if (nCat) patch.Category = nCat.name;
  if (nAcct) patch.Account = nAcct.name;
  if (nTo) patch.ToAccount = nTo.name;
  if (!Object.keys(patch).length) throw new Error('Nothing to update.');

  if (patch.Amount !== undefined) assertNonZero('Amount', patch.Amount);
  if (patch.ToAmount !== undefined && patch.ToAmount !== '') assertNonZero('ToAmount', patch.ToAmount);

  const effCat = patch.Category !== undefined ? patch.Category : cur.Category;
  const effTo = patch.ToAccount !== undefined ? patch.ToAccount : cur.ToAccount;
  assertShape(r.catByName[effCat] ? r.catByName[effCat].type : null, hasTo(effTo));
  const mirrored = mirrorToAmount(cur, patch);
  if (mirrored !== undefined) patch.ToAmount = mirrored;

  const set = [], bind = [];
  const put = (col, v) => { set.push(col + ' = ?'); bind.push(v); };
  if (patch.Date !== undefined) put('date', parseDate(patch.Date));
  if (patch.Period !== undefined) put('period', parsePeriod(patch.Period) || null);
  if (patch.Category !== undefined) put('category_id', r.catByName[patch.Category].id);
  if (patch.Description !== undefined) put('description', patch.Description || '');
  if (patch.Account !== undefined) put('account_id', r.acctByName[patch.Account].id);
  if (patch.Amount !== undefined) put('amount_u', toU(patch.Amount));
  if (patch.ToAccount !== undefined) put('to_account_id', hasTo(patch.ToAccount) ? r.acctByName[patch.ToAccount].id : null);
  if (patch.ToAmount !== undefined) put('to_amount_u', patch.ToAmount === '' ? null : toU(patch.ToAmount));
  // Re-stamp the rate when the account (and so the currency) changed, or when the
  // client sent one explicitly — including '' to clear a manual override. Untouched
  // otherwise, so history never reprices.
  if (patch.Account !== undefined || args.ExchangeRate !== undefined) {
    const eff = patch.Account !== undefined ? patch.Account : cur.Account;
    const acct = r.acctByName[eff];
    const fx = await resolveRate(env, acct ? acct.currency : '', args.ExchangeRate);
    put('fx_rate', fx.blank ? null : fx.rate);
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE transactions SET ' + set.join(', ') + ' WHERE id = ?').bind(...bind, args.ID)
  ]);
  return { status: 'success', message: 'Transaction updated.', transaction: await txById(env, r, args.ID) };
}

export async function deleteTransaction(args, env) {
  if (!args.ID) throw new Error('delete requires an ID.');
  const r = await refs(env);
  const snapshot = await txById(env, r, args.ID);
  if (!snapshot) throw new Error('No transaction with ID: ' + args.ID);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(args.ID)
  ]);
  return { status: 'success', message: 'Transaction deleted.', transaction: snapshot };
}

export async function bulkUpdateTransactions(args, env) {
  const ids = (args.ids || []).map(String);
  const patch = args.patch || {};
  if (!ids.length) throw new Error('bulkUpdate requires a non-empty ids[].');
  const r = await refs(env);
  const nCat = patch.Category === undefined ? null : resolveCategory(r, patch.Category);
  const nAcct = patch.Account === undefined ? null : resolveAccount(r, patch.Account);
  const nTo = (patch.ToAccount === undefined || patch.ToAccount === '') ? null : resolveAccount(r, patch.ToAccount);
  if (patch.Category !== undefined && !nCat) throw new Error('Unknown Category: ' + patch.Category);
  if (patch.Account !== undefined && !nAcct) throw new Error('Unknown Account: ' + patch.Account);
  if (patch.ToAccount !== undefined && patch.ToAccount !== '' && !nTo)
    throw new Error('Unknown ToAccount: ' + patch.ToAccount);

  const p = {};
  TX_CLIENT_FIELDS.forEach((f) => { if (patch[f] !== undefined) p[f] = patch[f]; });
  // Canonical names from here down — every lookup below indexes the exact-name maps.
  if (nCat) p.Category = nCat.name;
  if (nAcct) p.Account = nAcct.name;
  if (nTo) p.ToAccount = nTo.name;
  if (!Object.keys(p).length) throw new Error('Nothing to update.');

  if (p.Amount !== undefined) assertNonZero('Amount', p.Amount);
  if (p.ToAmount !== undefined && p.ToAmount !== '') assertNonZero('ToAmount', p.ToAmount);

  const found = (await env.DB.prepare(
    'SELECT t.id, t.to_account_id, c.type AS type FROM transactions t JOIN categories c ON c.id = t.category_id ' +
    'WHERE t.id IN (' + list(ids.length) + ')').bind(...ids).all()).results;
  const have = new Set(found.map((x) => x.id));
  const skipped = ids.filter((id) => !have.has(id));

  // Shape guard: reject a Category/ToAccount mismatch on ANY affected row before
  // touching the first one (v1 did the same, per-row, off two column reads).
  if (p.Category !== undefined || p.ToAccount !== undefined) {
    found.forEach((row) => {
      const type = p.Category !== undefined ? r.catByName[p.Category].type : row.type;
      const to = p.ToAccount !== undefined ? p.ToAccount : row.to_account_id;
      assertShape(type, hasTo(to));
    });
  }

  const set = [], bind = [];
  const put = (col, v) => { set.push(col + ' = ?'); bind.push(v); };
  if (p.Date !== undefined) put('date', parseDate(p.Date));
  if (p.Period !== undefined) put('period', parsePeriod(p.Period) || null);
  if (p.Category !== undefined) put('category_id', r.catByName[p.Category].id);
  if (p.Description !== undefined) put('description', p.Description || '');
  if (p.Account !== undefined) put('account_id', r.acctByName[p.Account].id);
  if (p.Amount !== undefined) put('amount_u', toU(p.Amount));
  if (p.ToAccount !== undefined) put('to_account_id', hasTo(p.ToAccount) ? r.acctByName[p.ToAccount].id : null);
  if (p.ToAmount !== undefined) put('to_amount_u', p.ToAmount === '' ? null : toU(p.ToAmount));
  // ponytail: a bulk clear with no Account change resolves against the reassigned
  // account's currency for every row — fine for reassigns, which is the only UI path.
  if (p.Account !== undefined || patch.ExchangeRate !== undefined) {
    const acct = p.Account !== undefined ? r.acctByName[p.Account] : null;
    const fx = await resolveRate(env, acct ? acct.currency : '', patch.ExchangeRate);
    put('fx_rate', fx.blank ? null : fx.rate);
  }

  const targets = [...have];
  if (targets.length) {
    await env.DB.batch([
      env.DB.prepare('UPDATE transactions SET ' + set.join(', ') + ' WHERE id IN (' + list(targets.length) + ')')
        .bind(...bind, ...targets)
    ]);
  }
  return { status: 'success', message: 'Bulk update complete.', updated: targets.length, skipped };
}

export async function bulkDeleteTransactions(args, env) {
  const ids = (args.ids || []).map(String);
  if (!ids.length) throw new Error('bulkDelete requires a non-empty ids[].');
  const found = (await env.DB.prepare('SELECT id FROM transactions WHERE id IN (' + list(ids.length) + ')')
    .bind(...ids).all()).results.map((x) => x.id);
  const have = new Set(found);
  if (found.length) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM transactions WHERE id IN (' + list(found.length) + ')').bind(...found)
    ]);
  }
  return { status: 'success', message: 'Bulk delete complete.', deleted: found.length,
           skipped: ids.filter((id) => !have.has(id)) };
}

// ── accounts ─────────────────────────────────────────────────────────────────
// Editable account fields, keyed by the wire name the SPA still sends (the sheet's
// header text). Anything else in the payload is ignored, as ACCOUNT_EDITABLE did.
const ACCOUNT_EDITABLE = {
  'Starting Balance': ['starting_balance_u', 'money'],
  'Interest Frequency': ['interest_frequency', 'text'],
  'Interest Rate': ['interest_rate', 'num'],
  'Credit Limit': ['credit_limit_u', 'money'],
  Notes: ['notes', 'text'],
  Color: ['color', 'text']
};

export async function updateAccount(args, env) {
  if (!args.Name) throw new Error('updateAccount requires Name.');
  const set = [], bind = [];
  Object.keys(ACCOUNT_EDITABLE).forEach((field) => {
    if (args[field] === undefined) return;
    const [col, kind] = ACCOUNT_EDITABLE[field];
    const raw = args[field];
    let v;
    if (kind === 'money') v = (raw === '' || raw === null) ? null : toU(raw);
    else if (kind === 'num') v = (raw === '' || raw === null) ? null : Number(raw);
    else v = raw === null ? '' : String(raw);
    set.push(col + ' = ?'); bind.push(v);
  });
  if (!set.length) throw new Error('No editable fields supplied. Editable: ' + Object.keys(ACCOUNT_EDITABLE).join(', '));
  // Resolve the target first: the UPDATE matches on the exact name, so a case slip would
  // otherwise report "Unknown Account" for an account that is right there.
  const target = resolveAccount(await refs(env), args.Name);
  if (!target) throw new Error('Unknown Account: ' + args.Name);
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET ' + set.join(', ') + ' WHERE id = ?').bind(...bind, target.id)
  ]);
  if (!res.meta.changes) throw new Error('Unknown Account: ' + args.Name);
  return { status: 'success', message: 'Account updated.', name: target.name, fieldsWritten: set.length };
}

// ── admin grid + export ──────────────────────────────────────────────────────
/**
 * The server-side table whitelist behind the Admin screen. There is deliberately no
 * SQL console: anything this grid cannot express is `wrangler d1 execute` from the
 * owner's machine, where it belongs.
 *
 *   edit  — columns an UPDATE may touch
 *   add   — columns an INSERT may set (a natural primary key appears here, not in edit:
 *           renaming one under a live foreign key is a data-loss move, not a cell edit)
 *   money — micros columns, converted to/from decimals at this boundary like every
 *           other handler, so the grid shows 47200 and not 47200000000
 *
 * `transactions` is read + delete only: it has real handlers with validation, FX
 * stamping and version bumping, and the grid must not be a way around them. Delete
 * stays for surgery on a row the UI cannot reach.
 *
 * KEY ORDER IS THE ADMIN PICKER'S BUTTON ORDER — listTable ships `tables` and the
 * screen draws its row of buttons from that, so this is the only place the set of
 * tables (and the order they are offered in) is written down. Most-used first.
 */
const TABLES = {
  accounts: {
    pk: 'id',
    edit: ['name', 'currency', 'subtype', 'symbol', 'starting_balance_u', 'interest_frequency',
           'interest_rate', 'credit_limit_u', 'notes', 'color'],
    money: ['starting_balance_u', 'credit_limit_u']
  },
  categories: { pk: 'id', edit: ['name', 'type', 'segment', 'description'] },
  account_types: { pk: 'subtype', edit: ['type'], add: ['subtype', 'type'] },
  budgets: { pk: 'id', edit: ['segment', 'period', 'target_type', 'target', 'currency', 'notes'] },
  recurring: {
    pk: 'id', edit: ['description', 'currency', 'amount_u', 'fee_u', 'months_left', 'grp'],
    money: ['amount_u', 'fee_u']
  },
  ledger: { pk: 'id', edit: ['tx_id', 'bsp_rate', 'filed', 'date_received', 'wise_amount_u'],
            money: ['wise_amount_u'] },
  prices: { pk: 'rowid', edit: [], add: ['symbol', 'priced_at', 'price', 'currency'] },
  // Cron-owned history: fully read-only (nodelete) so the grid can't corrupt or
  // hole the net-worth line. money cols render as PHP, not micros.
  nw_snapshots: { pk: 'month', edit: [], nodelete: true,
                  money: ['net_worth_u', 'assets_u', 'liabilities_u', 'shares_u'] },
  meta: { pk: 'key', edit: ['value'], add: ['key', 'value'] },
  transactions: { pk: 'id', edit: [], money: ['amount_u', 'to_amount_u', 'amount_php_u'] },
  email_quotes: { pk: 'message_id', edit: [] }
};

function tableSpec(name) {
  const t = TABLES[String(name || '')];
  if (!t) throw new Error('Unknown table: ' + name + '. Allowed: ' + Object.keys(TABLES).join(', '));
  return t;
}
const moneyCols = (t) => t.money || [];
const addCols = (t) => t.add || t.edit;

export async function listTable(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  const limit = Math.min(1000, Math.max(1, parseInt(args.limit, 10) || 200));
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const pkSel = t.pk === 'rowid' ? 'rowid AS rowid, ' : '';
  const [cnt, page] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM ' + name),
    env.DB.prepare('SELECT ' + pkSel + '* FROM ' + name + ' ORDER BY ' + t.pk + ' LIMIT ? OFFSET ?')
      .bind(limit, offset)
  ]);
  const rows = page.results.map((row) => {
    const o = Object.assign({}, row);
    moneyCols(t).forEach((c) => { if (c in o) o[c] = fromU(o[c]); });
    return o;
  });
  return {
    status: 'success',
    table: name, pk: t.pk, editable: t.edit, addable: addCols(t), money: moneyCols(t),
    deletable: !t.nodelete,
    tables: Object.keys(TABLES),   // the Admin screen's picker buttons, in TABLES order
    cols: rows.length ? Object.keys(rows[0]) : addCols(t),
    total: cnt.results[0].n, offset, limit, rows
  };
}

/** Decimal -> micros for the whitelisted money columns; everything else passes through. */
function coerceCell(t, col, value) {
  if (moneyCols(t).indexOf(col) !== -1) return (value === '' || value == null) ? null : toU(value);
  if (value === '') return null;
  return value;
}

/**
 * Cells that rewrite the MEANING of history, not just a label. Flipping an
 * account_type Asset↔Liability inverts every past delta on every account of that
 * subtype; changing an account's currency reprices every fx-NULL row it carries;
 * changing a category's type breaks the Transfer⇔ToAccount invariant on rows already
 * written. Each is frozen while any transaction references the record — the numbers
 * would silently change under rows nobody re-checked. Escape hatch, deliberately
 * outside the app: `wrangler d1 execute`, followed by fixing up the affected rows.
 *
 * `binds` is how many times the pk goes into the statement.
 */
const FROZEN_CELLS = {
  'categories|type': { sql: 'SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', binds: 1 },
  'accounts|currency': { sql: 'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?', binds: 2 },
  'accounts|subtype': { sql: 'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?', binds: 2 },
  'account_types|type': { sql: 'SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ' +
                               'ON a.id = t.account_id OR a.id = t.to_account_id WHERE a.subtype = ?', binds: 1 }
};

async function assertNotFrozen(env, table, col, pk) {
  const f = FROZEN_CELLS[table + '|' + col];
  if (!f) return;
  const row = await env.DB.prepare(f.sql).bind(...new Array(f.binds).fill(pk)).first();
  if (row && row.n) throw new Error(
    table + '.' + col + ' is frozen: ' + row.n + ' transaction(s) reference this row, and changing it ' +
    'rewrites what they mean. Use `wrangler d1 execute` if that is really the intent.');
}

export async function updateTableCell(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  const col = String(args.column || '');
  if (t.edit.indexOf(col) === -1)
    throw new Error(col + ' is not editable on ' + name + '. Editable: ' + (t.edit.join(', ') || '(none)'));
  if (args.pk === undefined || args.pk === null || args.pk === '') throw new Error('updateTableCell requires pk.');
  await assertNotFrozen(env, name, col, args.pk);
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE ' + name + ' SET ' + col + ' = ? WHERE ' + t.pk + ' = ?')
      .bind(coerceCell(t, col, args.value), args.pk)
  ]);
  if (!res.meta.changes) throw new Error('No ' + name + ' row with ' + t.pk + ' = ' + args.pk);
  return { status: 'success', table: name, pk: args.pk, column: col };
}

export async function insertTableRow(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  const allowed = addCols(t);
  if (!allowed.length) throw new Error(name + ' is read-only in the admin grid.');
  const row = args.row || {};
  const cols = [], vals = [];
  Object.keys(row).forEach((c) => {
    if (allowed.indexOf(c) === -1) return;
    cols.push(c); vals.push(coerceCell(t, c, row[c]));
  });
  if (!cols.length) throw new Error('Nothing to insert. Settable: ' + allowed.join(', '));
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO ' + name + ' (' + cols.join(',') + ') VALUES (' + list(cols.length) + ')').bind(...vals)
  ]);
  return { status: 'success', table: name, pk: res.meta.last_row_id };
}

export async function deleteTableRow(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  if (t.nodelete) throw new Error(name + ' is read-only in the admin grid.');
  if (args.pk === undefined || args.pk === null || args.pk === '') throw new Error('deleteTableRow requires pk.');
  const [res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM ' + name + ' WHERE ' + t.pk + ' = ?').bind(args.pk)
  ]);
  if (!res.meta.changes) throw new Error('No ' + name + ' row with ' + t.pk + ' = ' + args.pk);
  return { status: 'success', table: name, pk: args.pk, deleted: res.meta.changes };
}

/**
 * Every table as raw JSON — backup layer 1 (the nightly GAS pull into a spreadsheet)
 * and the admin screen's CSV download. Raw means micros as stored: a backup is for
 * fidelity, not for reading.
 *
 * Named getExportAll rather than the plan's `exportAll` because the get…/list… prefix
 * is what picks GET vs POST in the SPA's gs(), and test.js enforces it.
 */
export async function getExportAll(args, env) {
  const names = Object.keys(TABLES);
  const res = await env.DB.batch(names.map((n) => env.DB.prepare('SELECT * FROM ' + n)));
  const tables = {};
  names.forEach((n, i) => { tables[n] = res[i].results; });
  return { status: 'success',
           exportedAt: new Date().toISOString(), tables };
}
