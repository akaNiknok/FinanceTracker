/**
 * jobs.js — the two cron jobs.
 *
 *   1. interest  (30 16 * * * UTC = 00:30 Manila) — port of Interest.gs.
 *   2. prices    (0 22 * * *  UTC = 06:00 Manila) — IBKR Flex Web Service, the
 *      replacement for the GOOGLEFINANCE cells that vanished with the Sheet.
 *
 * The free plan does NOT retry a failed cron, so both are wrapped and a failure is
 * reported to the owner in Telegram. A missed night is harmless either way: interest
 * re-prices itself seven days back on the next run, and prices just stay one day
 * staler (the read path never fetches, by design).
 */
import { refs, deltas, addDays, manilaToday, fromU } from './db.js';
import { createTransaction, updateTransaction, deleteTransaction } from './api.js';
import { notifyOwner, msgOf } from './telegram.js';

// ── daily interest ───────────────────────────────────────────────────────────
const WITHHOLDING = 0.20;
const LOOKBACK_DAYS = 7;      // repair window; wider catches more late/backdated entries
const CENT_U = 10000;         // 0.01 in micros — the "already correct" threshold

/** Net interest on a day's closing balance: gross/365 less withholding, to the centavo. */
export function interestNetU(balanceU, rate) {
  return Math.round((balanceU * rate / 365) * (1 - WITHHOLDING) / CENT_U) * CENT_U;
}

/**
 * Credit one day of interest per Daily-interest account, for the last `lookbackDays`
 * CLOSED days. Every rule here is Interest.gs's, unchanged:
 *
 *   * the base is the day's CLOSING balance recomputed from the ledger, not the live
 *     balance at trigger time — so a transaction logged late still prices its own day;
 *   * today is never credited, so an evening entry lands before its day is priced;
 *   * the whole window is re-priced each run and the row is updated (or deleted) when
 *     the figure moved, with the previous amount subtracted from the base so a repair
 *     cannot compound on its own output;
 *   * oldest -> newest, so a repaired older day compounds forward. That is why each
 *     day's writes happen before the next day's deltas() call.
 *   * per-account try/catch: one bad account must not abort the run.
 *
 * Manual backfill after an outage: interestJob(env, 60).
 */
export async function interestJob(env, lookbackDays) {
  const days = Math.max(1, parseInt(lookbackDays, 10) || LOOKBACK_DAYS);
  const r = await refs(env);
  const accounts = r.accounts.filter((a) => String(a.interest_frequency) === 'Daily' && Number(a.interest_rate));
  if (!accounts.length) return { changed: 0, errors: [], message: 'No daily-interest accounts.' };

  // What we have already credited, by deterministic id — this is what tells a fresh
  // credit from a repair.
  const posted = Object.create(null);
  (await env.DB.prepare("SELECT id, amount_u FROM transactions WHERE id LIKE 'interest-%'").all())
    .results.forEach((x) => { posted[x.id] = x.amount_u; });

  const today = manilaToday();
  let changed = 0;
  const errors = [];
  for (let back = days; back >= 1; back--) {
    const day = addDays(today, -back);
    const net = await deltas(env, r, day);
    for (const a of accounts) {
      const id = 'interest-' + a.name + '-' + day;
      const priorU = posted[id] || 0;
      const balanceU = (a.starting_balance_u || 0) + (net[a.id] || 0) - priorU;
      const netU = interestNetU(balanceU, a.interest_rate);
      if (Math.abs(netU - priorU) < CENT_U / 2) continue;      // already correct (incl. both zero)
      try {
        if (!priorU) {
          await createTransaction({ ID: id, Date: day, Category: 'Income: Interest',
                                    Account: a.name, Amount: fromU(netU) }, env);
        } else if (netU) {
          await updateTransaction({ ID: id, Amount: fromU(netU) }, env);
        } else {
          await deleteTransaction({ ID: id }, env);            // balance went to zero -> the row is wrong
        }
        posted[id] = netU;
        changed++;
      } catch (err) {
        errors.push(a.name + ' ' + day + ': ' + msgOf(err));
      }
    }
  }
  return { changed, errors };
}

// ── IBKR Flex: share prices ──────────────────────────────────────────────────
// Two-step service: SendRequest hands back a ReferenceCode, GetStatement returns the
// report once it has been generated (a few seconds later, hence the poll). IBKR
// REQUIRES a User-Agent header and answers 403 to a bare request.
const FLEX_SEND = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const FLEX_UA = { 'User-Agent': 'FinanceTracker/2.0 (personal finance tracker)' };
const FLEX_TRIES = 6, FLEX_WAIT = 3000;

const xmlTag = (xml, tag) => {
  const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(xml);
  return m ? m[1] : '';
};
const xmlAttr = (frag, name) => {
  const m = new RegExp(name + '="([^"]*)"').exec(frag);
  return m ? m[1] : '';
};

/**
 * Open Positions out of a Flex statement. Regex rather than a parser because Workers
 * has no XML parser and the shape is one self-closing tag per position — the moment
 * this needs real XPath, the query is asking for too much.
 */
export function parsePositions(xml) {
  // toDate is the report's own date (yyyyMMdd); it is what the prices are AS OF.
  const raw = xmlAttr(xml, 'toDate');
  const pricedAt = /^\d{8}$/.test(raw)
    ? raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8)
    : manilaToday();
  const out = [];
  (xml.match(/<OpenPosition\b[^>]*>/g) || []).forEach((tag) => {
    const symbol = xmlAttr(tag, 'symbol');
    const price = parseFloat(xmlAttr(tag, 'markPrice'));
    if (!symbol || !isFinite(price) || !price) return;
    out.push({ symbol, price, currency: xmlAttr(tag, 'currency') || 'USD',
               position: parseFloat(xmlAttr(tag, 'position')) || 0, pricedAt });
  });
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pricesJob(env) {
  const t = env.IBKR_FLEX_TOKEN, q = env.IBKR_FLEX_QUERY_ID;
  if (!t || !q) return { skipped: 'IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not set' };

  const sent = await (await fetch(FLEX_SEND + '?t=' + encodeURIComponent(t) +
    '&q=' + encodeURIComponent(q) + '&v=3', { headers: FLEX_UA })).text();
  const ref = xmlTag(sent, 'ReferenceCode');
  const url = xmlTag(sent, 'Url');
  if (!ref || !url) throw new Error('Flex SendRequest failed: ' + sent.slice(0, 300));

  // Poll: the statement is generated asynchronously and answers ErrorCode 1019
  // ("statement generation in progress") until it is ready. This is I/O wait, which
  // does not count against the CPU limit.
  let xml = '';
  for (let i = 0; i < FLEX_TRIES; i++) {
    if (i) await sleep(FLEX_WAIT);
    xml = await (await fetch(url + '?q=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(t) + '&v=3',
      { headers: FLEX_UA })).text();
    if (xml.indexOf('<FlexQueryResponse') !== -1) break;
    const code = xmlTag(xml, 'ErrorCode');
    if (code && code !== '1019') throw new Error('Flex GetStatement error ' + code + ': ' + xmlTag(xml, 'ErrorMessage'));
  }
  if (xml.indexOf('<FlexQueryResponse') === -1) throw new Error('Flex statement not ready after ' + FLEX_TRIES + ' tries.');

  const positions = parsePositions(xml);
  if (!positions.length) return { written: 0, message: 'No open positions in the statement.' };
  await env.DB.batch(positions.map((p) => env.DB.prepare(
    'INSERT INTO prices (symbol, priced_at, price, currency) VALUES (?,?,?,?) ' +
    'ON CONFLICT(symbol, priced_at) DO UPDATE SET price = excluded.price, currency = excluded.currency')
    .bind(p.symbol, p.pricedAt, p.price, p.currency)));
  // Quantities are logged for reconciliation and deliberately NOT written: the ledger
  // stays the source of truth for how many shares are held, IBKR only prices them.
  console.log('prices: ' + positions.map((p) => p.symbol + '@' + p.price + ' x' + p.position).join(', '));
  return { written: positions.length, pricedAt: positions[0].pricedAt };
}

// ── cron dispatch ────────────────────────────────────────────────────────────
/**
 * Both jobs, wrapped. The free plan does not retry a failed cron, so the only failure
 * signal that exists is the Telegram message this sends.
 */
export async function runCron(env, cron) {
  const job = cron === '0 22 * * *' ? 'prices' : 'interest';
  try {
    const res = job === 'prices' ? await pricesJob(env) : await interestJob(env);
    if (res.errors && res.errors.length) {
      await notifyOwner(env, '⛔ *Interest job: ' + res.errors.length + ' account(s) failed*\n› ' +
        res.errors.join('\n› '));
    }
    console.log(job + ': ' + JSON.stringify(res));
    return res;
  } catch (err) {
    console.error(job + ' failed: ' + (err && err.stack ? err.stack : err));
    await notifyOwner(env, '⛔ *' + job + ' job failed*\n› ' + msgOf(err));
    throw err;
  }
}
