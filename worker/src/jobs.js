/**
 * jobs.js — the cron job.
 *
 *   prices (0 22 * * * UTC = 06:00 Manila) — IBKR Flex Web Service, the replacement
 *   for the GOOGLEFINANCE cells that vanished with the Sheet.
 *
 * The daily-interest job lived here until v2.0.1 and is gone: the bank's own interest
 * never agreed with daily-balance x rate, so the figure it posted was wrong more often
 * than it was useful. `git show v2.0.0:worker/src/jobs.js` if it is ever wanted back.
 * The `interest-*` rows it already posted stay as history.
 *
 * The free plan does NOT retry a failed cron, so the job is wrapped and a failure is
 * reported to the owner in Telegram. A missed night is harmless: prices just stay one
 * day staler (the read path never fetches, by design).
 */
import { manilaToday } from './db.js';
import { notifyOwner, msgOf } from './telegram.js';
import { snapshotNetWorth } from './api.js';

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
 * The job, wrapped. The free plan does not retry a failed cron, so the only failure
 * signal that exists is the Telegram message this sends.
 */
export async function runCron(env) {
  const out = {};
  try {
    out.prices = await pricesJob(env);
    console.log('prices: ' + JSON.stringify(out.prices));
  } catch (err) {
    console.error('prices failed: ' + (err && err.stack ? err.stack : err));
    await notifyOwner(env, '⛔ *prices job failed*\n› ' + msgOf(err));
    throw err;
  }
  // Snapshot AFTER prices so this month's net worth is stamped with fresh quotes.
  // Non-fatal on its own: prices (the critical job) already committed, a missed
  // snapshot just leaves this month's history to fill on the next daily run.
  try {
    out.snapshot = await snapshotNetWorth(env);
    console.log('nw snapshot: ' + JSON.stringify(out.snapshot));
  } catch (err) {
    console.error('nw snapshot failed: ' + (err && err.stack ? err.stack : err));
    await notifyOwner(env, '⛔ *net-worth snapshot failed*\n› ' + msgOf(err));
  }
  return out;
}
