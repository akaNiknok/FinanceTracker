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
import { notifyOwner, msgOf, drainUpdates } from './telegram.js';
import { snapshotNetWorth } from './api.js';

// ── IBKR Flex: share prices ──────────────────────────────────────────────────
// Two-step service: SendRequest hands back a ReferenceCode, GetStatement returns the
// report once it has been generated (a few seconds later, hence the poll). IBKR
// REQUIRES a User-Agent header and answers 403 to a bare request.
const FLEX_SEND = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const FLEX_UA = { 'User-Agent': 'FinanceTracker/2.0 (personal finance tracker)' };
// Paced against IBKR's published limit: ONE request per second and TEN per minute, per
// token. The worst case is one send + FLEX_TRIES polls, then a second send + FLEX_RETRY_TRIES
// polls = 10 requests over about 52s. The first GetStatement waits as well, because
// SendRequest has just spent this second and the statement is built asynchronously, so an
// instant ask can only ever be "not ready".
const FLEX_FIRST = 2000, FLEX_WAIT = 6000;
const FLEX_TRIES = 6;        // ~32s of patience for the statement to appear
const FLEX_RETRY_TRIES = 2;  // the second reference code gets a short look, not a full poll
// The pace is a parameter ONLY so a test can drive the two-code recovery without waiting
// 50 real seconds for it. Production never passes it; nothing else may vary.
export const FLEX_PACE = { first: FLEX_FIRST, wait: FLEX_WAIT,
                           tries: FLEX_TRIES, retryTries: FLEX_RETRY_TRIES };

/**
 * Which GetStatement errors are worth another poll.
 *
 * IBKR's own table splits cleanly: these all end "Please try again shortly" — the
 * request was accepted, the statement is simply not there yet.
 *
 * 1020 is here for a narrower reason than v2.8.2 claimed. Probing the live service
 * shows 1020 is what IBKR answers to a request it cannot PARSE (a non-numeric token, a
 * doubled "?"), while a well-formed request with a wrong token gets 1015. So 1020 does
 * not mean "transient" by itself. It earns its place because the request we send is
 * static and verified: the same URL shape returns 1015 for a bad token, i.e. it
 * validates. A 1020 against a shape that validates is therefore about the one part that
 * is NOT static — the reference code — or about IBKR refusing us at that moment. Both
 * are worth another look, and a reference code that keeps drawing 1020 is replaced
 * rather than replayed (FLEX_STALE_REF below).
 */
const FLEX_RETRY = new Set(['1001', '1004', '1005', '1006', '1007', '1008',
                            '1009', '1018', '1019', '1020', '1021']);
export const flexRetryable = (code) => FLEX_RETRY.has(String(code).trim());

/**
 * Codes that accuse the REFERENCE CODE rather than the statement. 1017 says so outright;
 * 1020 means IBKR could not validate a request whose only non-static part is that code.
 * Replaying the same code is the one response that cannot help either, so the job asks
 * for a fresh one instead — once.
 */
const FLEX_STALE_REF = new Set(['1017', '1020']);
export const flexStaleRef = (code) => FLEX_STALE_REF.has(String(code).trim());

/** What the owner must DO about a code that will not clear by itself. */
const FLEX_FIX = {
  1003: 'Check the Flex query still has an Open Positions section.',
  1010: 'The Flex query is legacy. Build it again as an Activity Flex query.',
  1011: 'Enable the Flex Web Service again in Client Portal.',
  1012: 'Make a new Flex token and set IBKR_FLEX_TOKEN.',
  1013: 'IBKR refuses this address. Remove the IP restriction from the token.',
  1014: 'Check IBKR_FLEX_QUERY_ID.',
  1015: 'Make a new Flex token and set IBKR_FLEX_TOKEN.',
  1016: 'The IBKR account is in an invalid state. Open Client Portal.',
  1017: 'IBKR refused a fresh reference code as well. Run the job again later.',
};

// Tolerant on purpose: IBKR may pretty-print, and a tag it decides to give an
// attribute must not read as absent. The trim matters twice — an untrimmed <Url> goes
// straight into fetch() and cannot be validated, and an untrimmed <ErrorCode> misses
// every code comparison below, so a plain "still generating" would read as a fault.
const xmlTag = (xml, tag) => {
  const m = new RegExp('<' + tag + '\\b[^>]*>([^<]*)</' + tag + '>').exec(xml);
  return m ? m[1].trim() : '';
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

/** One-line "what did IBKR actually say", for the failure message. */
export const flexWhy = (status, body) => status + ' ' +
  (xmlTag(body, 'ErrorCode')
    ? xmlTag(body, 'ErrorCode') + ' ' + xmlTag(body, 'ErrorMessage')
    : String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || '(empty body)');

/** Step one: ask for the report. Returns the reference code and the URL to poll. */
async function flexSend(t, q) {
  const sent = await (await fetch(FLEX_SEND + '?t=' + encodeURIComponent(t) +
    '&q=' + encodeURIComponent(q) + '&v=3', { headers: FLEX_UA })).text();
  const ref = xmlTag(sent, 'ReferenceCode');
  const url = xmlTag(sent, 'Url');
  // The Url is IBKR's to choose and it is NOT the host we just posted to (SendRequest is
  // ndcdyn, GetStatement comes back gdcdyn), so it is read from the reply, never assumed.
  if (!ref || !url) throw new Error('Flex SendRequest failed: ' + sent.slice(0, 300));
  return { ref, url };
}

/**
 * Step two: poll one reference code until the statement appears.
 *
 * Three ways out. The statement -> {xml}. A code that accuses the reference code ->
 * {stale}, so the caller can ask for a new one; polling that is pointless. A code that
 * needs a person -> throw, with the repair. Anything IBKR calls transient is polled.
 */
async function flexPoll(t, ref, url, tries, pace) {
  let last = '', code = '';
  for (let i = 0; i < tries; i++) {
    await sleep(i ? pace.wait : pace.first);
    const res = await fetch(url + '?q=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(t) + '&v=3',
      { headers: FLEX_UA });
    const xml = await res.text();
    if (xml.indexOf('<FlexQueryResponse') !== -1) return { xml };
    code = xmlTag(xml, 'ErrorCode');
    // 1017 says the code is bad outright. Nothing changes by asking again with it.
    if (code && flexStaleRef(code) && !flexRetryable(code)) return { stale: code, last: flexWhy(res.status, xml) };
    if (code && !flexRetryable(code))
      throw new Error('Flex GetStatement error ' + code + ': ' + xmlTag(xml, 'ErrorMessage') +
        (FLEX_FIX[code] ? ' — ' + FLEX_FIX[code] : ''));
    // The body is kept: a poll that ends with no <FlexQueryResponse> and no ErrorCode is
    // NOT necessarily "still generating" — a 403, a throttle page and an HTML error all
    // look identical from here. Without it there is nothing to diagnose the next morning.
    last = flexWhy(res.status, xml);
  }
  return { stale: flexStaleRef(code) ? code : '', last };
}

export async function pricesJob(env, pace = FLEX_PACE) {
  const t = env.IBKR_FLEX_TOKEN, q = env.IBKR_FLEX_QUERY_ID;
  if (!t || !q) return { skipped: 'IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not set' };

  let { ref, url } = await flexSend(t, q);
  let got = await flexPoll(t, ref, url, pace.tries, pace);

  // One fresh reference code, once. A 1020 against a URL shape that IBKR does validate
  // points at the code rather than the request, and v2.8.2 replayed the same code six
  // times before giving up — the one response that could not have helped.
  if (!got.xml && got.stale) {
    await sleep(pace.wait);          // do not stack the second send on the per-minute limit
    ({ ref, url } = await flexSend(t, q));
    const retry = await flexPoll(t, ref, url, pace.retryTries, pace);
    got = { xml: retry.xml, last: retry.last || got.last, stale: retry.stale, resent: true };
  }

  if (!got.xml)
    throw new Error('Flex statement not ready after ' + (got.resent ? 'two reference codes' :
      pace.tries + ' tries') + '. Last reply: ' + got.last);

  const positions = parsePositions(got.xml);
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
 * The two schedules, as strings, because the dispatch below compares against them and
 * wrangler.toml is the only other place they exist. A contract guard in test.js fails
 * the build if the two lists ever disagree — a drifted string would silently turn the
 * drain off AND run the IBKR job every two minutes, which its rate limit would refuse.
 */
export const CRON_DAILY = '0 22 * * *';
export const CRON_DRAIN = '*/2 * * * *';

/**
 * Route a cron firing to its job. Unknown schedules run NOTHING on purpose: guessing
 * would put the daily IBKR pull on whatever cadence the typo named.
 */
export async function runScheduled(env, cron) {
  if (cron === CRON_DRAIN) return drainUpdates(env);
  if (cron === CRON_DAILY || !cron) return runCron(env);
  console.warn('cron: no job is registered for "' + cron + '"');
}

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
