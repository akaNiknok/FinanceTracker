/**
 * worker.js — the whole backend. Cloudflare Worker + D1, as of v2.0.0.
 *
 * Before v2 this file was a 178-line proxy in front of an Apps Script web app: it
 * existed because Telegram rejects a redirecting webhook and Apps Script 302s every
 * POST, and it grew /api and the SPA because GAS cannot send CORS headers either.
 * The Sheet is now a frozen archive, D1 is the source of truth, and the proxy is the
 * application.
 *
 * Routes (everything else is a static asset from public/, free and unmetered):
 *   POST /tg     — the Telegram webhook. Same URL as before, so no setWebhook re-run.
 *                  Answers 200 immediately and does the work in waitUntil, because a
 *                  Gemini round trip is slower than Telegram's patience.
 *   POST /login  — passphrase -> sha256(APP_PASS) cookie (HttpOnly/Secure/Lax, 1yr).
 *   GET|POST /api — the JSON API. GET = reads, POST = writes; the split comes from the
 *                  handler name's get…/list… prefix, which is also how the SPA's gs()
 *                  picks its method, so there is exactly one list to keep in sync.
 *
 * Auth on /api: the ft_auth cookie (the SPA) OR `Authorization: Bearer INGEST_TOKEN`
 * (the two remaining Apps Script jobs — the Gmail courier and the backup puller).
 * 401 is JSON, never a redirect: that is what lets gs() prompt for the passphrase and
 * retry the call in place. A request whose HOST is localhost skips the check entirely
 * (see isLocalDev) — that is `wrangler dev`, and Cloudflare cannot route a production
 * request to that hostname.
 *
 * The KV edge read cache is GONE. It existed to hide Apps Script latency and D1 is the
 * thing it was faking; the namespace is rebound as FX_CACHE (see src/fx.js). The
 * client's own cache is untouched — it is still the offline story — and every GET read
 * carries an ETag it revalidates against (see readResponse).
 *
 * Secrets (wrangler secret put ...):
 *   APP_PASS, SECRET_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, GEMINI_API_KEY,
 *   INGEST_TOKEN, IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID
 * Bindings: DB (D1), FX_CACHE (KV, optional — unbound just means every FX lookup fetches).
 */
import {
  getBootstrap, getDashboard, getAccounts, getBudgets, getInvestments, getRecurring,
  getLedger, listTransactions, listTable, getExportAll,
  createTransaction, createTransfer, updateTransaction, deleteTransaction, updateAccount,
  bulkUpdateTransactions, bulkDeleteTransactions, updateLedgerCell, appendLedgerRow,
  deleteLedgerRow, updateTableCell, insertTableRow, deleteTableRow
} from './src/api.js';
import { handleUpdate, ingestEmail } from './src/telegram.js';
import { runCron } from './src/jobs.js';

const COOKIE = 'ft_auth';

/**
 * GET-only, side-effect-free. Names MUST stay get…/list… — worker/public/app.js picks
 * GET vs POST off that prefix rather than shipping a second copy of this table, and
 * test.js fails the build if a route is ever named against the rule.
 */
export const ROUTES_READ = {
  getBootstrap, getDashboard, getAccounts, getBudgets, getInvestments, getRecurring,
  getLedger, listTransactions,
  listTable,        // admin grid
  getExportAll      // backup puller + the admin screen's CSV
};

export const ROUTES_WRITE = {
  createTransaction, createTransfer, updateTransaction, deleteTransaction, updateAccount,
  bulkUpdateTransactions, bulkDeleteTransactions,
  updateLedgerCell, appendLedgerRow, deleteLedgerRow,
  updateTableCell, insertTableRow, deleteTableRow,   // admin grid
  ingestEmail                                        // the Gmail courier
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The receipt's "Edit details" button links back into the SPA, which is this same
    // origin now — no WEBHOOK_URL-minus-/tg derivation and no WEB_APP_URL trap left.
    env.APP_URL = url.origin;
    // A webhook carries no cookie, so /tg is gated by SECRET_TOKEN instead. It MUST be
    // /tg and not "/": a POST to "/" is answered 405 by the static-asset handler and
    // never reaches this script, because assets match before the Worker and only serve
    // GET/HEAD. Verified with `wrangler dev`; undocumented either way, so do not
    // re-derive it.
    if (request.method === 'POST' && url.pathname === '/tg') return telegram(request, env, ctx);
    if (url.pathname === '/login') return login(request, env);
    if (url.pathname === '/api') return api(request, env, url);
    return new Response('not found', { status: 404 });   // assets never reach here
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  }
};

async function telegram(request, env, ctx) {
  if (env.SECRET_TOKEN &&
      request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SECRET_TOKEN) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => null);
  // Answer first, work after: Telegram redelivers anything it has not heard back from,
  // and a Gemini parse plus a few D1 round trips is well inside waitUntil but not
  // inside Telegram's patience. handleUpdate never throws.
  ctx.waitUntil(handleUpdate(env, update));
  return new Response('ok');
}

/** POST {pass} -> sets the session cookie. The SPA calls this on a 401 from /api. */
async function login(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const body = await request.json().catch(() => ({}));
  // ponytail: plain compare, no rate limiting — use a long random passphrase and the
  // free plan's 100k requests/day is the brute-force ceiling. Add Turnstile or a KV
  // attempt counter only if this ever gets more than one user.
  if (!env.APP_PASS || body.pass !== env.APP_PASS) return new Response('unauthorized', { status: 401 });
  return new Response('ok', {
    headers: {
      'Set-Cookie': `${COOKIE}=${await sha256(env.APP_PASS)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

/**
 * Is the caller allowed? The SPA presents the cookie; the two Apps Script jobs present
 * the bearer token. Either is the owner — there is one user — so both are accepted on
 * every action rather than maintaining a per-route credential matrix.
 */
async function authorized(request, env) {
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (env.INGEST_TOKEN && bearer && bearer === env.INGEST_TOKEN) return true;
  if (!env.APP_PASS) return false;
  const want = `${COOKIE}=${await sha256(env.APP_PASS)}`;
  return (request.headers.get('Cookie') || '').split(/;\s*/).includes(want);
}

/**
 * A `wrangler dev` server is not gated. The passphrase protects the DEPLOYED app; asking
 * for it locally only blocked the agents and the fresh checkouts that have no
 * `worker/.dev.vars` at all, and a local D1 holds `seed.sql`'s invented data anyway.
 * Cloudflare routes to a Worker BY HOSTNAME, so a production request can never arrive
 * with Host: localhost — this is inert once deployed.
 * ponytail: a hostname test, not a DEV flag. A flag has to be planted in every checkout
 * and could be set on the real Worker by accident; a hostname cannot.
 */
const isLocalDev = (url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

/** The JSON API. Handlers throw; a throw becomes {status:'error', message}. */
async function api(request, env, url) {
  if (!isLocalDev(url)) {
    if (!env.APP_PASS) return json({ status: 'error', message: 'APP_PASS is not set on the Worker.' }, 503);
    if (!await authorized(request, env)) return json({ status: 'error', message: 'Locked' }, 401);
  }
  if (!env.DB) return json({ status: 'error', message: 'The D1 binding DB is not configured.' }, 503);

  // Query params + JSON body merged into one args object, body winning. Port of rt_args_.
  const args = {};
  url.searchParams.forEach((v, k) => { args[k] = v; });
  let body = null;
  if (request.method === 'POST') {
    try { body = await request.json(); }
    catch (err) { return json({ status: 'error', message: 'Invalid JSON body: ' + err.message }); }
    Object.keys(body || {}).forEach((k) => { args[k] = body[k]; });
  }

  const action = args.action || '';
  const read = ROUTES_READ[action], write = ROUTES_WRITE[action];
  // Never mutate over GET — link previewers and scanners prefetch URLs.
  if (request.method === 'GET' && write) return json({ status: 'error', message: "Action '" + action + "' requires POST." });
  const handler = request.method === 'GET' ? read : (write || null);
  if (!handler) {
    return json({ status: 'error', message: 'Unknown action: ' + action,
                  knownActions: Object.keys(request.method === 'GET' ? ROUTES_READ : ROUTES_WRITE) });
  }
  try {
    const body = await handler(args, env);
    return request.method === 'GET' ? readResponse(body, request) : json(body);
  } catch (err) {
    console.error(action + ': ' + (err && err.stack ? err.stack : err));
    return json({ status: 'error', message: (err && err.message) ? err.message : String(err) });
  }
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/**
 * A read, answered with an ETag over its own bytes — and 304 when the caller already
 * holds them. This REPLACED meta.data_version (v2.9.0): one counter could only say
 * "something, somewhere, changed", so a Telegram ingest at 03:00 re-downloaded the
 * dashboard, the accounts, the tax year and every admin page the phone had cached.
 * A hash of the payload answers the question the client is actually asking — "is THIS
 * screen different?" — and it answers it for the month-, year- and page-scoped cache
 * keys too, which no counter could see. It also needs nothing from the write handlers,
 * so a new route (or a new cron write) can never forget to invalidate.
 *
 * The tag must be stable for identical data, so a read payload must never carry a
 * clock. test-api.js calls every read route twice and fails if a tag moves.
 * `Cache-Control: no-store` stays: the SPA holds the tag in its own persisted cache and
 * sends If-None-Match itself, so the browser's HTTP cache is not in the path at all —
 * one cache, and it is the one that already survives a reload and works offline.
 */
async function readResponse(body, request) {
  const s = JSON.stringify(body);
  const tag = '"' + (await sha256(s)).slice(0, 32) + '"';
  const headers = Object.assign({ ETag: tag }, HEADERS);
  if (request.headers.get('If-None-Match') === tag) return new Response(null, { status: 304, headers });
  return new Response(s, { status: 200, headers });
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
