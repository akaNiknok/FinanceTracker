/**
 * Cache.gs — the app-wide data-version token + cheap version gate.
 *
 * `DATA_VERSION` is a monotonically increasing integer bumped on EVERY ledger /
 * account write. The SPA caches each screen's payload tagged with the version it
 * was fetched at; on navigation it calls api_getDataVersion (a tiny payload) and
 * only refetches the big payload when the version changed — stale-while-revalidate
 * that transfers almost nothing when nothing has been edited.
 *
 * Source of truth = Script Properties (durable across CacheService eviction),
 * mirrored into the script cache for fast reads.
 *
 * SCOPE: the version reflects ledger/account EDITS only — it does NOT bump on FX
 * drift (live rates have their own 6h cache in Fx.gs) or on Google-Finance share
 * repricing. The Refresh button (S.boot=null + S.cache={}) still forces a full
 * reload when you want absolutely-fresh balances.
 */

const CACHE_VERSION_KEY = "DATA_VERSION";

/** Current data version as an integer (0 if never set). */
function cache_getVersion_() {
  const c = CacheService.getScriptCache();
  const hit = c.get(CACHE_VERSION_KEY);
  if (hit !== null && hit !== undefined && hit !== "") return parseInt(hit, 10) || 0;
  const stored = PropertiesService.getScriptProperties().getProperty(CACHE_VERSION_KEY);
  const v = parseInt(stored, 10) || 0;
  c.put(CACHE_VERSION_KEY, String(v), 21600);
  return v;
}

/** Increment + persist the data version. Called at the end of every write. */
function cache_bumpVersion_() {
  const next = cache_getVersion_() + 1;
  PropertiesService.getScriptProperties().setProperty(CACHE_VERSION_KEY, String(next));
  CacheService.getScriptCache().put(CACHE_VERSION_KEY, String(next), 21600);
  return next;
}

/** Public (google.script.run): the version gate. Intentionally tiny. */
function api_getDataVersion() {
  return { status: "success", version: cache_getVersion_() };
}
