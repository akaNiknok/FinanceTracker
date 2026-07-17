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

// ponytail: Logger is the only GAS global the pure tests touch — stub just that.
const sandbox = {
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
process.exit(failed ? 1 : 0);
