/**
 * Fx.gs — exchange-rate stamping for transactions.
 *
 * Policy (OVERHAUL_PLAN §4.1): ExchangeRate is a STATIC input column that the
 * service stamps once at write time and never recomputes — so historical rows
 * never reprice. Resolution order for a transaction in `currency`:
 *   1. caller-supplied ExchangeRate (manual override) — used verbatim
 *   2. base currency (PHP) — left blank (the Amount (PHP) formula treats blank as 1)
 *   3. live rate fetched + cached
 *   4. USD_PHP_FALLBACK script property, if set
 *   5. blank + a warning (caller decides what to do)
 *
 * Live rates come from open.er-api.com (free, no key) and are cached 6h. No
 * volatile GOOGLEFINANCE/TODAY in the derivation band — fetching happens here in
 * code, and only the resulting number is written.
 */

/**
 * Resolve the ExchangeRate to stamp. Returns { rate, blank, source, warning }.
 * `rate` is the value to write (number) when `blank` is false.
 */
function fx_resolveRate_(currency, overrideRate) {
  if (overrideRate !== undefined && overrideRate !== null && overrideRate !== "") {
    const n = parseFloat(overrideRate);
    if (!isNaN(n)) return { rate: n, blank: false, source: "override" };
  }
  if (!currency || String(currency).toUpperCase() === BASE_CURRENCY) {
    return { rate: 1, blank: true, source: "base" }; // PHP → leave cell blank
  }
  const live = fx_liveRate_(String(currency).toUpperCase(), BASE_CURRENCY);
  if (live) return { rate: live, blank: false, source: "live" };

  const fb = cfgUsdPhpFallback_();
  if (fb && String(currency).toUpperCase() === "USD") {
    return { rate: fb, blank: false, source: "fallback" };
  }
  return { rate: 1, blank: true, source: "unresolved",
           warning: "Could not fetch live FX for " + currency + "; ExchangeRate left blank (=1)." };
}

/** from→to rate, cached 6h. Returns a number or 0 on failure. */
function fx_liveRate_(from, to) {
  const cache = CacheService.getScriptCache();
  const key = "fx_" + from + "_" + to;
  const hit = cache.get(key);
  if (hit) return parseFloat(hit) || 0;
  try {
    const url = "https://open.er-api.com/v6/latest/" + encodeURIComponent(from);
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return 0;
    const data = JSON.parse(resp.getContentText());
    const rate = data && data.rates ? data.rates[to] : 0;
    if (rate) { cache.put(key, String(rate), 21600); return rate; }
  } catch (err) {
    Logger.log("fx_liveRate_ failed: " + err.message);
  }
  return 0;
}
