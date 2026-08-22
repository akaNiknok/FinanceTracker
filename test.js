#!/usr/bin/env node
/**
 * test.js — local runner for the PURE tests in Tests.gs (npm test).
 * Concatenates every .gs file into one vm context (flat namespace, same as GAS)
 * and runs the functions listed in Tests.gs PURE_TESTS. No Google account, no
 * deps. Sheet-bound tests (test_bootstrap, test_balanceReconciliation, ...)
 * still run in the GAS editor via test_all().
 * Not pushed to GAS (.claspignore).
 */
const fs = require("fs"), path = require("path"), vm = require("vm");

const src = fs.readdirSync(__dirname)
  .filter(function (f) { return f.endsWith(".gs"); }).sort()
  .map(function (f) { return fs.readFileSync(path.join(__dirname, f), "utf8"); })
  .join("\n;\n");

// ponytail: Logger (+ console, for tg_tryModels_'s fallback warning) are the only
// globals the pure tests touch — stub just those.
const sandbox = {
  console: console,
  Logger: { log: function () {
    const a = Array.prototype.slice.call(arguments);
    console.log("  " + (typeof a[0] === "string"
      ? a.slice(1).reduce(function (s, v) { return s.replace("%s", v); }, a[0])
      : a.join(" ")));
  } }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "all.gs" });

let failed = 0;
sandbox.PURE_TESTS.forEach(function (name) {
  try { vm.runInContext(name + "()", sandbox); }
  catch (e) { failed++; console.error("FAIL " + name + ": " + e.message); }
});
console.log(failed
  ? failed + " of " + sandbox.PURE_TESTS.length + " pure test(s) FAILED"
  : "All " + sandbox.PURE_TESTS.length + " pure tests passed.");

// The Worker is ESM and lives outside the .gs namespace, so it gets its own tiny
// check here rather than a second runner. Only one predicate is worth guarding:
// caching getDataVersion would freeze the SPA's freshness oracle app-wide, and it
// would fail silently — stale screens, no error anywhere.
(async function () {
  const { pathToFileURL } = require("url");
  const { cacheableRead } = await import(pathToFileURL(path.join(__dirname, "worker", "worker.js")).href);
  const q = (s) => new URLSearchParams(s);
  [["GET", "action=getDashboard&month=2026-Aug&_v=41", true,  "version-stamped read caches"],
   ["GET", "action=getDataVersion&_v=41",              false, "getDataVersion must never cache"],
   ["GET", "action=getDashboard&month=2026-Aug",       false, "no _v (cold boot) bypasses"],
   ["POST", "action=createTransaction&_v=41",          false, "writes never cache"]
  ].forEach(function (c) {
    if (cacheableRead(c[0], q(c[1])) !== c[2]) { failed++; console.error("FAIL cacheableRead: " + c[3]); }
  });
  // The other half of the same contract, client side: gs() must stamp `_v` ONLY when
  // verKnown(). A version we hold but have not confirmed may predate another device's
  // write, and stamping it reads that device's pre-write bucket out of KV — the exact
  // cross-device staleness reported after the first deploy. app.js runs in a vm here
  // because the bug was in what gs() BUILDS, which a source-text check would have missed.
  const noop = function () {};
  const app = {
    console: { log: noop, warn: noop, error: noop },
    navigator: {}, window: { addEventListener: noop },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout, clearTimeout, Date, Math, JSON, encodeURIComponent, URLSearchParams,
    history: {}, location: { search: "", href: "https://x/" }
  };
  app.globalThis = app;
  let seen = "";
  app.fetch = function (u) { seen = u; return Promise.resolve({ status: 200, json: () => Promise.resolve({ status: "ok" }) }); };
  vm.createContext(app);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "worker", "public", "app.js"), "utf8"), app, { filename: "app.js" });

  const read = async function (action, verAt) { app.S.dataVersion = 41; app.S._verAt = verAt; seen = ""; await app.gs("api_" + action, {}); return seen; };
  const stamped = (u) => /[?&]_v=41(&|$)/.test(u);
  const cases = [
    ["getDashboard", Date.now(),        true,  "a confirmed version is stamped"],
    ["getDashboard", 0,                 false, "an unconfirmed version is NEVER stamped (fill(null))"],
    ["getDashboard", Date.now() - 9000, false, "a version older than VER_TTL is not stamped"],
    ["getDataVersion", Date.now(),      false, "getDataVersion never carries _v"]
  ];
  for (const c of cases) {
    if (stamped(await read(c[0], c[1])) !== c[2]) { failed++; console.error("FAIL gs _v stamp: " + c[3]); }
  }

  if (!failed) console.log("Worker cache guards passed (cacheableRead + gs _v stamping).");
  process.exit(failed ? 1 : 0);
})();
