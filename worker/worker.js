/**
 * Cloudflare Worker — hosts the FinanceTracker SPA and fronts the Apps Script API.
 *
 * Two jobs, and the second is why the first lives here too:
 *
 * 1. The Telegram proxy (the original reason this Worker exists). Telegram refuses
 *    a webhook that answers with a redirect ("Wrong response from the webhook: 302
 *    Found") and keeps redelivering, and an Apps Script /exec URL always answers
 *    POST with a 302 to script.googleusercontent.com. So this answers Telegram
 *    200 immediately and forwards the update to GAS via waitUntil.
 *
 * 2. /api — the SPA's data path. GAS cannot send CORS headers and 302s every
 *    request, so the browser can never call it directly; something has to sit in
 *    front either way. Since it does, the SPA is served from this same Worker
 *    (public/ static assets) and is therefore SAME-ORIGIN with /api: no CORS, no
 *    preflight round trip on writes. Static assets are free and unmetered and
 *    bypass this script entirely — only /api, /login and /tg burn invocations.
 *
 * Auth: /api needs an ft_auth cookie (see /login); the app shell is public, which
 * is fine because it holds no data and no secrets. Deliberately NOT Cloudflare
 * Access — that needs a domain on a Cloudflare zone and there isn't one.
 *
 * Don't add a /mail route to open the receipt's ⌕ Email button in Gmail — it was tried
 * and it cannot work; CLAUDE.md's worker/ row has the why.
 *
 * Secrets (wrangler secret put ...):
 *   GAS_URL       — the full endpoint, incl. ?action=telegram and &token= if
 *                   ENFORCE_TOKEN is on. Run tg_gasEndpoint() in the Apps Script
 *                   editor to print exactly this string. /api reuses it: the exec
 *                   base and the token are parsed back out of it, so there is one
 *                   GAS secret here, not three.
 *   APP_PASS      — the SPA passphrase. Unset = /api is closed, not open.
 *   SECRET_TOKEN  — optional; must equal the secret_token registered by
 *                   tg_setWebhook. Set both or neither.
 *
 * Bindings (wrangler.toml):
 *   API_CACHE     — optional KV namespace, the edge read cache. Unbound = no
 *                   caching, everything still works; see cacheableRead().
 */

const COOKIE = "ft_auth";

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // A webhook carries no cookie, so this route is gated by SECRET_TOKEN instead.
    // It MUST be /tg, not "/" as before v1.6.0: verified with `wrangler dev` — a POST
    // to "/" is answered 405 by the static-asset handler and never reaches this
    // script, because assets are matched before the Worker and only serve GET/HEAD.
    // So set WEBHOOK_URL to <worker>/tg and re-run tg_setWebhook.
    if (request.method === "POST" && path === "/tg") return telegram(request, env, ctx);
    if (path === "/login") return login(request, env);
    if (path === "/api") return api(request, env, ctx);
    return new Response("not found", { status: 404 });   // assets never reach here
  }
};

function telegram(request, env, ctx) {
  if (env.SECRET_TOKEN &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  // waitUntil keeps the fetch alive after we have already answered Telegram.
  // The GAS execution happens on the POST itself, so the 302 that comes back
  // is of no interest — it is neither followed nor read.
  return request.text().then((update) => {
    ctx.waitUntil(fetch(env.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: update
    }));
    return new Response("ok");
  });
}

/** POST {pass} → sets the session cookie. The SPA calls this on a 401 from /api. */
async function login(request, env) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await request.json().catch(() => ({}));
  // ponytail: plain compare, no rate limiting — use a long random passphrase and
  // the free plan's 100k requests/day is the brute-force ceiling. Add Turnstile or
  // a KV attempt counter only if this ever gets more than one user.
  if (!env.APP_PASS || body.pass !== env.APP_PASS) return new Response("unauthorized", { status: 401 });
  // Hashed so the passphrase itself never sits in the cookie jar. Year-long, since
  // rotating APP_PASS invalidates every cookie anyway (the hash changes).
  return new Response("ok", {
    headers: {
      "Set-Cookie": `${COOKIE}=${await sha256(env.APP_PASS)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

/**
 * Is this GET worth putting in the edge cache?
 *
 * `_v` is the SPA's DATA_VERSION, stamped onto every read by gs(). Keying on it
 * means a write bumps the version, the next read asks for a different key, and a
 * stale payload becomes unreachable by construction — no purge logic, no TTL race,
 * and the payload carries its own `version` anyway, so the key is only a bucket
 * hint and can never be the thing that decides freshness. A request with no `_v`
 * (a cold boot that has not learned the version yet) simply bypasses.
 *
 * getDataVersion is the exception and MUST stay one: it is the oracle the SPA
 * gates its own cache on, so caching it would make every other entry
 * unfalsifiable — the app would sit on stale data until the entry expired.
 *
 * KV rather than the Cache API on purpose: caches.default is a silent no-op on a
 * .workers.dev subdomain (it needs a zone, i.e. a domain, which this deploy has
 * no more than Cloudflare Access did). Swap it back if a domain ever appears.
 */
export function cacheableRead(method, params) {
  return method === "GET" && params.has("_v") && params.get("action") !== "getDataVersion";
}

const CACHE_TTL = 600;   // seconds; entries are version-keyed, so this only bounds junk

/** Gated proxy to GAS. GET ?action=<read>&… / POST {action,…}. */
async function api(request, env, ctx) {
  if (!env.APP_PASS) return json({ status: "error", message: "APP_PASS is not set on the Worker." }, 503);
  const want = `${COOKIE}=${await sha256(env.APP_PASS)}`;
  if (!(request.headers.get("Cookie") || "").split(/;\s*/).includes(want)) {
    return json({ status: "error", message: "Locked" }, 401);
  }

  const src = new URL(request.url);
  const key = src.pathname + src.search;
  // ponytail: hit rate is modest by design — the SPA's own persisted S.cache already
  // covers repeat reads on one device, so this earns its keep on the SECOND device, a
  // wiped client and post-Refresh. A >400-char key (a long search filter) just skips
  // rather than risking KV's 512-byte key limit. Move to a shared read model in D1
  // only if that stops being enough.
  const kv = env.API_CACHE;
  const hot = !!kv && key.length <= 400 && cacheableRead(request.method, src.searchParams);
  if (hot) {
    const hit = await kv.get(key, { cacheTtl: CACHE_TTL });
    if (hit) return json(hit);
  }

  const gas = new URL(env.GAS_URL);                    // <exec>?action=telegram&token=<tok>
  const target = new URL(gas.origin + gas.pathname);
  const token = gas.searchParams.get("token");

  let init = { method: "GET" };
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (token) body.token = token;                     // auth_extractToken_ reads body.token
    target.searchParams.set("action", body.action || src.searchParams.get("action") || "");
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  } else {
    src.searchParams.forEach((v, k) => target.searchParams.set(k, v));
    target.searchParams.delete("_v");                  // ours; rt_args_ never needs to see it
    if (token) target.searchParams.set("token", token);
  }

  // GAS answers /exec with a 302 to script.googleusercontent.com; fetch follows it
  // by default and the JSON comes off the final hop. This is the whole reason the
  // browser cannot talk to GAS itself.
  const res = await fetch(target, init);
  const body = await res.text();
  // GAS answers a payload it refused with HTTP 200 + {status:"error"} — never cache that.
  if (hot && res.ok && !isError(body)) {
    ctx.waitUntil(kv.put(key, body, { expirationTtl: CACHE_TTL }));
  }
  return json(body, res.status);
}

function isError(body) {
  try { return JSON.parse(body).status === "error"; } catch { return true; }
}

const json = (body, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
