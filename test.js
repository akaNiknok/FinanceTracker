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
  if (!failed) console.log("Worker cacheableRead guard passed.");
  process.exit(failed ? 1 : 0);
})();
