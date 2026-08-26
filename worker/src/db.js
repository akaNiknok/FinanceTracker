/**
 * db.js — the D1 data layer: the micros boundary, Manila-time helpers, reference
 * maps, and the balance derivation the Accounts sheet used to do with formulas.
 *
 * Two rules the rest of the Worker relies on:
 *   1. MICROS AT THE EDGE. Everything below `_u` is an integer count of millionths
 *      of a native unit. Convert with toU/fromU in the handler that touches the
 *      wire, never mid-calculation — a decimal that sneaks into the middle of a
 *      sum is exactly the drift the integers exist to prevent.
 *   2. ONE "TODAY". Workers and D1 run in UTC; this app is Asia/Manila. Every
 *      today/closed-day/quarter question goes through manilaToday() here. A bare
 *      `new Date()` in ported code is a bug waiting for 16:00 UTC.
 */

export const M = 1e6;
export const toU = (v) => Math.round(Number(v || 0) * M);
export const fromU = (u) => (u == null ? null : u / M);
/** 2-decimal money rounding — the shape every v1 payload rounded to. */
export const q2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const BASE_CURRENCY = 'PHP';

// ── Manila time ──────────────────────────────────────────────────────────────
const MANILA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
});
/** 'yyyy-MM-dd' in Manila. The only source of "today" in this codebase. */
export function manilaToday(d) { return MANILA.format(d || new Date()); }
/** 'yyyy-MM-dd' -> 'yyyy-MMM' (the month key shape used everywhere, DB included). */
export function monthOf(iso) { return String(iso).slice(0, 4) + '-' + MONTHS[Number(String(iso).slice(5, 7)) - 1]; }
export function manilaMonth(d) { return monthOf(manilaToday(d)); }
/** {y, m} (m is 0-11) from a 'yyyy-MMM' or 'yyyy-MM' key; null when unparseable. */
export function parseMonthKey(s) {
  const m = /^(\d{4})-(\d{1,2}|[A-Za-z]{3,})$/.exec(String(s || '').trim());
  if (!m) return null;
  const i = /^\d+$/.test(m[2])
    ? parseInt(m[2], 10) - 1
    : MONTHS.findIndex((n) => n.toLowerCase() === m[2].slice(0, 3).toLowerCase());
  return (i >= 0 && i <= 11) ? { y: parseInt(m[1], 10), m: i } : null;
}
export const monthKey = (y, m) => y + '-' + MONTHS[m];
/** Shift a {y,m} pair by whole months, wrapping the year. */
export function shiftMonth(y, m, delta) {
  const t = y * 12 + m + delta;
  return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
}
/** The 'yyyy-MMM' keys of the month, or of the calendar quarter, containing {y,m}. */
export function periodMonths(period, ref) {
  if (period !== 'Quarterly') return [monthKey(ref.y, ref.m)];
  const start = Math.floor(ref.m / 3) * 3;
  return [0, 1, 2].map((i) => monthKey(ref.y, start + i));
}

// ── input coercion (ports of tx_parseDate_ / tx_parsePeriod_) ────────────────
/** Client date -> 'yyyy-MM-dd'. Blank means today (Manila). Rejects nothing else. */
export function parseDate(v) {
  if (v === undefined || v === null || v === '') return manilaToday();
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? manilaToday() : manilaToday(d);
}
/**
 * Client period -> canonical 'yyyy-MMM', or '' to clear the override. A typo would
 * silently match no month in ANY reporting path (cash flow, budgets, filters), so
 * garbage throws rather than writing a dead key. Port of tx_parsePeriod_.
 */
export function parsePeriod(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s === '') return '';
  const p = parseMonthKey(s);
  if (!p) throw new Error('Invalid Period: "' + v + '" (expected yyyy-MMM, e.g. 2026-Aug).');
  return monthKey(p.y, p.m);
}

// ── reference data + meta ────────────────────────────────────────────────────
/** Accounts (with their derived Type) and Categories, indexed by name and by id. */
export async function refs(env) {
  const [ar, cr] = await env.DB.batch([
    env.DB.prepare('SELECT a.*, t.type AS type FROM accounts a JOIN account_types t ON t.subtype = a.subtype ORDER BY a.id'),
    env.DB.prepare('SELECT * FROM categories ORDER BY id')
  ]);
  const index = (rows, k) => rows.reduce((m, r) => { m[r[k]] = r; return m; }, Object.create(null));
  return {
    accounts: ar.results, categories: cr.results,
    acctByName: index(ar.results, 'name'), acctById: index(ar.results, 'id'),
    catByName: index(cr.results, 'name'), catById: index(cr.results, 'id')
  };
}

export async function metaAll(env) {
  const r = await env.DB.prepare('SELECT key, value FROM meta').all();
  return r.results.reduce((m, x) => { m[x.key] = x.value; return m; }, {});
}
export async function metaGet(env, key, fallback) {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return (r && r.value !== null && r.value !== '') ? r.value : fallback;
}
export async function metaSet(env, key, value) {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}
export async function dataVersion(env) {
  return Number(await metaGet(env, 'data_version', '0')) || 0;
}
/**
 * The version bump, as a statement to append to a write's own batch. D1 batches are
 * transactional, so "write + bump" is atomic — which is what replaces v1's su_lock_()
 * plus cache_bumpVersion_() pair entirely.
 */
export const bumpStmt = (env) =>
  env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'");

// ── balances (the port of "derivation lives in the Sheet") ───────────────────
/**
 * Net native movement per account id, from the ledger. `asOf` ('yyyy-MM-dd',
 * inclusive) gives the CLOSING position of a past day, which the sheet's balance
 * formula could never do and the interest job needs.
 *
 * Sign rules copied verbatim from acct_computeDeltas_: Income adds, Expense and
 * Transfer subtract from the source, a transfer adds to_amount to the destination,
 * and a LIABILITY account's delta is inverted because it tracks an amount OWED
 * (a charge raises the balance).
 */
export async function deltas(env, refs, asOf) {
  const cut = asOf ? ' AND t.date <= ?' : '';
  const bind = asOf ? [asOf] : [];
  const src = env.DB.prepare(
    'SELECT t.account_id AS id, c.type AS type, SUM(t.amount_u) AS s FROM transactions t ' +
    'JOIN categories c ON c.id = t.category_id WHERE 1 = 1' + cut + ' GROUP BY t.account_id, c.type');
  const dst = env.DB.prepare(
    'SELECT t.to_account_id AS id, SUM(t.to_amount_u) AS s FROM transactions t ' +
    'WHERE t.to_account_id IS NOT NULL' + cut + ' GROUP BY t.to_account_id');
  const [a, b] = await env.DB.batch([
    bind.length ? src.bind(...bind) : src,
    bind.length ? dst.bind(...bind) : dst
  ]);

  const net = Object.create(null);
  const add = (id, u) => {
    if (!id) return;
    const acct = refs.acctById[id];
    net[id] = (net[id] || 0) + (acct && acct.type === 'Liability' ? -u : u);
  };
  a.results.forEach((r) => add(r.id, r.type === 'Income' ? r.s : -r.s));
  b.results.forEach((r) => add(r.id, r.s));
  return net;
}

/** symbol -> {price, currency, priced_at} for the newest row per symbol. */
export async function latestPrices(env) {
  const r = await env.DB.prepare(
    'SELECT p.symbol, p.price, p.currency, p.priced_at FROM prices p ' +
    'JOIN (SELECT symbol, MAX(priced_at) AS m FROM prices GROUP BY symbol) x ' +
    'ON x.symbol = p.symbol AND x.m = p.priced_at').all();
  return r.results.reduce((m, x) => { m[x.symbol] = x; return m; }, Object.create(null));
}

export const isSharesAcct = (a) =>
  String(a.currency).toUpperCase() === 'SHARES' || /share|stock/i.test(String(a.subtype || ''));
/** "Counts as an investment" — drives the Holdings card. Broad: any share-priced
 * account is a position you hold and price, even one parked as near-cash. */
export const isInvestmentAcct = (a) =>
  String(a.currency).toUpperCase() === 'SHARES' || /share|stock|invest|etf/i.test(String(a.subtype || ''));
/** "Counts as invested for the liquid-vs-invested net-worth split" — NARROWER than
 * isInvestmentAcct: keyed on SUBTYPE only, so a share-priced holding filed under a
 * liquid subtype (e.g. a short-term treasury ETF held as an emergency fund, subtype
 * EF) is priced as a share but sits with LIQUID, not invested. Deliberately not the
 * same as isInvestmentAcct: the Holdings card still shows such a holding as a
 * position, while the net-worth chart and the Invested tile treat it as liquid. */
export const isInvestedNetWorth = (a) => /share|stock|invest|etf/i.test(String(a.subtype || ''));

/**
 * The api_getAccounts row shape, byte for byte as v1 emitted it. `fx` is a
 * {CUR: phpPerUnit} map, `prices` the latestPrices() map.
 *
 * balancePhp is "as shown" (a liability is a positive amount owed); netWorthPhp is
 * signed. For a Shares account balanceNative is the QUANTITY, priced through the
 * prices table (what GOOGLEFINANCE used to do inside the sheet).
 */
export function shapeAccounts(refs, net, prices, fx) {
  const rate = (c) => {
    const k = String(c || BASE_CURRENCY).toUpperCase();
    return k === BASE_CURRENCY ? 1 : (fx[k] || 0);
  };
  return refs.accounts.map((a) => {
    const isLiability = a.type === 'Liability';
    const shares = isSharesAcct(a);
    const balanceNative = fromU((a.starting_balance_u || 0) + (net[a.id] || 0));
    let php;
    if (shares) {
      const p = a.symbol ? prices[a.symbol] : null;
      // No price is only unknowable while shares are actually held: IBKR reports no
      // open position for a closed holding, and zero shares are worth zero at any price.
      php = p ? q2(balanceNative * p.price * rate(p.currency)) : (balanceNative ? null : 0);
    } else {
      const r = rate(a.currency);
      php = r ? q2(balanceNative * r) : null;
    }
    const limit = fromU(a.credit_limit_u);
    return {
      name: a.name,
      currency: a.currency || null,
      type: a.type || null,
      subtype: a.subtype || null,
      startingBalance: fromU(a.starting_balance_u),
      balancePhp: php,
      balanceNative: balanceNative,
      netWorthPhp: php === null ? null : (isLiability ? -php : php),
      availableCredit: (isLiability && limit !== null && php !== null) ? q2(limit - php) : null,
      isLiability: isLiability,
      isShares: shares,
      isInvestment: isInvestmentAcct(a),
      // REFERENCE NOTES, deliberately: nothing computes with these since the daily
      // interest job was deleted in v2.0.1. They are the owner's own record of what a
      // bank pays, editable on the account modal. Not dead code — kept on purpose.
      interestFrequency: a.interest_frequency || null,
      interestRate: a.interest_rate || null,   // v1 was `|| null`: a 0% rate reads as blank
      creditLimit: limit,
      notes: a.notes || null,
      color: a.color || null
    };
  });
}

// ── transaction shaping ──────────────────────────────────────────────────────
/**
 * A joined transactions row -> the object v1's sheet reads produced. Every key here
 * is part of the /api contract: the SPA reads ID/Date/Period/Category/Description/
 * Account/Amount/'Amount (PHP)'/Currency/Type/ToAccount/ToAmount/ExchangeRate, and
 * the bot reads 'Amount (PHP)'. Blank cells were '' in the sheet, so they are '' here.
 */
export function shapeTx(r, refs) {
  const a = refs.acctById[r.account_id], c = refs.catById[r.category_id];
  const to = r.to_account_id ? refs.acctById[r.to_account_id] : null;
  return {
    ID: r.id,
    Date: r.date,
    Period: r.period || '',
    Category: c ? c.name : '',
    Description: r.description || '',
    Account: a ? a.name : '',
    Amount: fromU(r.amount_u),
    ExchangeRate: r.fx_rate == null ? '' : r.fx_rate,
    ToAccount: to ? to.name : '',
    ToAmount: r.to_amount_u == null ? '' : fromU(r.to_amount_u),
    Month: r.month,
    Type: c ? c.type : '',
    Segment: c ? (c.segment || '') : '',
    Currency: a ? a.currency : '',
    'Amount (PHP)': fromU(r.amount_php_u),
    ToCurrency: to ? to.currency : ''
  };
}
