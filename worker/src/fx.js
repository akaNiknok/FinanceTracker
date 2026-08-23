/**
 * fx.js — exchange rates. Port of Fx.gs, minus the sheet.
 *
 * Policy is unchanged: a transaction's fx_rate is a STATIC value stamped once at
 * write time and never recomputed, so history never reprices. Read paths ask for a
 * live rate, but "live" means "the 6-hour KV entry", so a page load costs a network
 * hop at most four times a day.
 *
 * Own module rather than living in jobs.js (as the migration plan sketched) purely
 * to keep the import graph a DAG: api.js and jobs.js both need rates, and jobs.js
 * needs api.js.
 *
 * The KV namespace is the old API_CACHE one, rebound as FX_CACHE — the edge read
 * cache it used to hold existed to hide Apps Script latency and is deleted with GAS.
 * Unbound = every call fetches; everything still works.
 */
import { metaGet, BASE_CURRENCY } from './db.js';

const TTL = 21600;           // 6h, same as the CacheService window in Fx.gs
const SOURCE = 'https://open.er-api.com/v6/latest/';   // free, no key

/** <from> -> PHP, cached 6h. Returns a number, or 0 when it cannot be resolved. */
export async function fxRate(env, from) {
  const cur = String(from || '').toUpperCase();
  if (!cur || cur === BASE_CURRENCY) return 1;
  const key = 'fx:' + cur + ':' + BASE_CURRENCY;
  const kv = env.FX_CACHE;
  if (kv) {
    const hit = await kv.get(key);
    if (hit) return parseFloat(hit) || 0;
  }
  try {
    const res = await fetch(SOURCE + encodeURIComponent(cur));
    if (res.ok) {
      const data = await res.json();
      const rate = data && data.rates ? data.rates[BASE_CURRENCY] : 0;
      if (rate) {
        if (kv) await kv.put(key, String(rate), { expirationTtl: TTL });
        return rate;
      }
    }
  } catch (err) {
    console.warn('fxRate ' + cur + ' failed: ' + err);
  }
  // Only USD has a configured fallback — it is the only foreign currency the
  // tracker actually holds, and a made-up rate for anything else would be worse
  // than a visible null balance.
  if (cur === 'USD') return Number(await metaGet(env, 'usd_php_fallback', '0')) || 0;
  return 0;
}

/** {CUR: phpPerUnit} for the currencies asked for. PHP is always 1; SHARES is priced, not converted. */
export async function fxMap(env, currencies) {
  const want = [...new Set((currencies || []).map((c) => String(c || '').toUpperCase()))]
    .filter((c) => c && c !== BASE_CURRENCY && c !== 'SHARES');
  const out = { [BASE_CURRENCY]: 1 };
  for (const c of want) out[c] = await fxRate(env, c);
  return out;
}

/**
 * The rate to stamp on a new transaction. Resolution order, verbatim from Fx.gs:
 *   1. caller override, used as given
 *   2. base currency -> blank (NULL, which the Amount (PHP) expression treats as 1)
 *   3. live rate
 *   4. USD_PHP_FALLBACK (now meta.usd_php_fallback)
 *   5. blank + a warning, and the caller decides
 */
export async function resolveRate(env, currency, override) {
  if (override !== undefined && override !== null && override !== '') {
    const n = parseFloat(override);
    if (!isNaN(n)) return { rate: n, blank: false, source: 'override' };
  }
  const cur = String(currency || '').toUpperCase();
  // SHARES is a quantity, not a currency — there is no rate to fetch, and asking
  // open.er-api for one on every write to a holdings account is a wasted subrequest.
  if (!cur || cur === BASE_CURRENCY || cur === 'SHARES') return { rate: 1, blank: true, source: 'base' };
  const live = await fxRate(env, cur);
  if (live) return { rate: live, blank: false, source: 'live' };
  return { rate: 1, blank: true, source: 'unresolved',
           warning: 'Could not fetch live FX for ' + cur + '; ExchangeRate left blank (=1).' };
}
