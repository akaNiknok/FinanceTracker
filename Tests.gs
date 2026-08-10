/**
 * Tests.gs — manual verification runners for the service layer.
 * Select a function in the Apps Script editor and Run, then read the Logs.
 * Nothing here is web-exposed. test_createReadDelete_ mutates then cleans up
 * after itself; test_balanceReconciliation is the one that validates the balance
 * assumptions documented in Accounts.gs.
 */

/** Pure tests — no sheet/network access. Also run locally by `npm test` (test.js). */
var PURE_TESTS = ["test_a1", "test_assertShape", "test_byDateDesc", "test_interestNet",
                  "test_isInvestment", "test_ledgerCoerce", "test_mergePartition",
                  "test_mirrorToAmount", "test_parseDate", "test_parsePeriod",
                  "test_telegram", "test_telegramQuery", "test_telegramBalance",
                  "test_telegramUndoData"];

function test_all() {
  PURE_TESTS.forEach(function (n) { globalThis[n](); });
  test_referenceData();
  test_fx();
  test_bootstrap();
  test_listTransactions();
  test_budgets();
  test_balanceReconciliation();
  test_createReadDelete();
  Logger.log("== test_all complete ==");
}

/** ledger_coerce_ — numeric strings become numbers (feed SUM); rest stays text. */
function test_ledgerCoerce() {
  const cases = [["1234", 1234], ["1,234.50", 1234.5], ["-42", -42],
                 ["2026-07-04", "2026-07-04"], ["Filed", "Filed"], ["", ""], [null, ""]];
  cases.forEach(function (c) {
    const got = ledger_coerce_(c[0]);
    if (got !== c[1]) throw new Error("ledger_coerce_ FAIL: " + JSON.stringify(c[0]) + " → " + JSON.stringify(got));
  });
  Logger.log("test_ledgerCoerce OK");
}

/** su_a1_ column-letter math (drives the RangeList bulk writes). */
function test_a1() {
  const cases = { "A1": [1, 1], "Z9": [9, 26], "AA10": [10, 27], "AZ2": [2, 52], "BA3": [3, 53] };
  Object.keys(cases).forEach(function (want) {
    const got = su_a1_(cases[want][0], cases[want][1]);
    if (got !== want) throw new Error("su_a1_ FAIL: expected " + want + ", got " + got);
  });
  Logger.log("test_a1 OK");
}

/** tx_assertShape_ — Transfer category ⇔ ToAccount present (issue #8). */
function test_assertShape() {
  tx_assertShape_("Transfer", true);   // ok
  tx_assertShape_("Expense", false);   // ok
  tx_assertShape_("Income", false);    // ok
  [["Transfer", false], ["Expense", true], ["Income", true], [null, true]].forEach(function (c) {
    let threw = false;
    try { tx_assertShape_(c[0], c[1]); } catch (e) { threw = true; }
    if (!threw) throw new Error("tx_assertShape_ FAIL: expected reject for " + JSON.stringify(c));
  });
  Logger.log("test_assertShape OK");
}

/** tx_mirrorToAmount_ — an Amount edit drags ToAmount along on same-currency transfers. */
function test_mirrorToAmount() {
  const xfer = { ToAccount: "IBKR", Amount: 500, ToAmount: 500 };
  const cases = [
    [xfer, { Amount: 600 }, 600],                                  // same-currency → mirror
    [xfer, { Amount: 600, ToAmount: 9 }, undefined],               // explicit override wins
    [xfer, { Description: "x" }, undefined],                       // Amount untouched
    [{ ToAccount: "IBKR", Amount: 5000, ToAmount: 81 }, { Amount: 6000 }, undefined], // cross-currency
    [{ ToAccount: "", Amount: 500, ToAmount: "" }, { Amount: 600 }, undefined]        // not a transfer
  ];
  cases.forEach(function (c) {
    const got = tx_mirrorToAmount_(c[0], c[1]);
    if (got !== c[2]) throw new Error("tx_mirrorToAmount_ FAIL: " + JSON.stringify(c[1]) +
                                      " → " + got + ", expected " + c[2]);
  });
  Logger.log("test_mirrorToAmount OK");
}

/**
 * tx_parsePeriod_ — normalizes the reporting-month override to the "yyyy-MMM" the
 * Month ARRAYFORMULA emits, and rejects anything that would write a key no report
 * can ever match.
 */
function test_parsePeriod() {
  const ok = { "2026-Aug": "2026-Aug", "2026-08": "2026-Aug", "2026-8": "2026-Aug",
               "2026-aug": "2026-Aug", "2026-AUGUST": "2026-Aug", " 2026-Jan ": "2026-Jan",
               "2026-12": "2026-Dec" };
  Object.keys(ok).forEach(function (input) {
    const got = tx_parsePeriod_(input);
    if (got !== ok[input]) throw new Error("tx_parsePeriod_ FAIL: " + input + " → " + got + " (want " + ok[input] + ")");
  });
  ["", null, undefined, "  "].forEach(function (blank) {
    if (tx_parsePeriod_(blank) !== "") throw new Error("tx_parsePeriod_ FAIL: blank should clear the override");
  });
  ["2026-13", "2026-00", "August", "2026", "26-Aug", "2026-Aug-01", "next month"].forEach(function (bad) {
    let threw = false;
    try { tx_parsePeriod_(bad); } catch (e) { threw = true; }
    if (!threw) throw new Error("tx_parsePeriod_ FAIL: expected reject for " + JSON.stringify(bad));
  });
  Logger.log("test_parsePeriod OK");
}

/** tx_byDateDesc_ — newest date first; same-day ties fall back to row order (later row first). */
function test_byDateDesc() {
  const rows = [
    { ID: "old",  Date: new Date(2026, 0, 1),  __row: 2 },
    { ID: "new",  Date: new Date(2026, 5, 1),  __row: 3 },
    { ID: "same-early", Date: new Date(2026, 5, 1), __row: 4 },  // same day as "new", later row
    { ID: "iso",  Date: "2026-03-15",            __row: 5 }       // string date still sorts
  ];
  const order = rows.slice().sort(tx_byDateDesc_).map(function (r) { return r.ID; });
  const want = ["same-early", "new", "iso", "old"];
  if (order.join(",") !== want.join(","))
    throw new Error("tx_byDateDesc_ FAIL: got " + order.join(",") + " want " + want.join(","));
  Logger.log("test_byDateDesc OK");
}

/** interest_net_ — daily accrual less 20% withholding, rounded to centavos. */
function test_interestNet() {
  const cases = [
    [100000, 0.0625, 13.7],    // 6.25% p.a. on 100k → 17.1233 gross → 13.70 net
    [0, 0.0625, 0], [100000, 0, 0],
    [-1000, 0.05, -0.11],      // overdrawn: negative accrual, not silently dropped
    [1, 0.0001, 0]             // rounds to nothing → caller treats as "no row"
  ];
  cases.forEach(function (c) {
    const got = interest_net_(c[0], c[1]);
    if (got !== c[2]) throw new Error("interest_net_ FAIL: (" + c[0] + "," + c[1] + ") → " + got + " want " + c[2]);
  });
  Logger.log("test_interestNet OK");
}

/** mig_mergePartition_ — an account merge must not delete and patch the same row. */
function test_mergePartition() {
  const rows = [
    { ID: 1, Account: "Maya Savings", ToAccount: "" },        // src
    { ID: 2, Account: "Maya", ToAccount: "" },                // untouched (survivor)
    { ID: 3, Account: "Maya", ToAccount: "Maya Savings" },    // self (both sides)
    { ID: 4, Account: "Maya Savings", ToAccount: "Maya" },    // self (other direction)
    { ID: 5, Account: "BPI", ToAccount: "Maya Savings" },     // dst
    { ID: 6, Account: "Maya Savings", ToAccount: "BPI" },     // src (transfer out)
    { ID: 7, Account: "BPI", ToAccount: null },               // untouched, null ToAccount
    { ID: 8, Account: "Maya Savings", ToAccount: "Maya Savings" } // legacy junk → self, not both
  ];
  const got = mig_mergePartition_(rows, "Maya Savings", "Maya");
  const want = { self: ["3", "4", "8"], src: ["1", "6"], dst: ["5"] };
  ["self", "src", "dst"].forEach(function (k) {
    if (got[k].join() !== want[k].join())
      throw new Error("mig_mergePartition_ FAIL " + k + ": " + got[k].join() + " want " + want[k].join());
  });
  Logger.log("test_mergePartition OK");
}

/** acct_isInvestment_ — Dashboard tile + Investments screen must agree on this predicate. */
function test_isInvestment() {
  const cases = [
    ["SHARES", "", true], ["PHP", "Investment", true], ["USD", "ETF Growth", true],
    ["PHP", "Stock", true], ["PHP", "Savings", false], ["USD", "Checking", false], ["PHP", "", false]
  ];
  cases.forEach(function (c) {
    const got = acct_isInvestment_(c[0], c[1]);
    if (got !== c[2]) throw new Error("acct_isInvestment_ FAIL: " + JSON.stringify(c) + " → " + got);
  });
  Logger.log("test_isInvestment OK");
}

/** Telegram bot pure bits: Gemini unwrap (incl. the empty-candidate case) + receipt shape. */
function test_telegram() {
  const ok = { candidates: [{ content: { parts: [{ text: '{"error":null}' }] } }] };
  if (tg_geminiText_(ok) !== '{"error":null}') throw new Error("tg_geminiText_ FAIL: text not extracted");
  [{}, { candidates: [] }, { candidates: [{ finishReason: "SAFETY", content: {} }] }].forEach(function (j) {
    let threw = false;
    try { tg_geminiText_(j); } catch (e) { threw = true; }
    if (!threw) throw new Error("tg_geminiText_ FAIL: expected throw for " + JSON.stringify(j));
  });

  const plain = tg_receipt_({ Date: "2026-07-29", Category: "Food", Description: "lunch",
                              Account: "Maya", Amount: 250, ToAccount: null, ToAmount: null }, "success");
  if (plain.indexOf("✦ *Logged*") !== 0 || plain.indexOf("To:") !== -1 || plain.split("\n").length !== 6)
    throw new Error("tg_receipt_ FAIL (plain): " + plain);
  const xfer = tg_receipt_({ Date: "2026-07-29", Category: "Investment: Growth", Description: "top up",
                             Account: "BPI", Amount: 5000, ToAccount: "IBKR", ToAmount: 81 }, "duplicate");
  if (xfer.indexOf("Already logged") === -1 || xfer.indexOf("› To: _IBKR_") === -1 || xfer.indexOf("`81`") === -1)
    throw new Error("tg_receipt_ FAIL (transfer): " + xfer);

  // Model fallback: first success wins, a dead model is skipped, all-dead rethrows.
  const tried = [];
  const call = function (failUntil) {
    return function (m) { tried.push(m); if (tried.length <= failUntil) throw new Error("503 " + m); return m; };
  };
  if (tg_tryModels_(["a", "b", "c"], call(0)) !== "a" || tried.length !== 1)
    throw new Error("tg_tryModels_ FAIL: should stop at the first success");
  tried.length = 0;
  if (tg_tryModels_(["a", "b", "c"], call(2)) !== "c" || tried.join() !== "a,b,c")
    throw new Error("tg_tryModels_ FAIL: should fall through to the last model");
  tried.length = 0;
  let threw = "";
  try { tg_tryModels_(["a", "b"], call(9)); } catch (e) { threw = e.message; }
  if (threw !== "503 b") throw new Error("tg_tryModels_ FAIL: last error should surface, got " + threw);
  Logger.log("test_telegram OK");
}

/** Telegram query path: month normalisation, filter mapping, summary arithmetic. */
function test_telegramQuery() {
  // Whatever form the model emits must become the sheet's derived Month key.
  if (tg_monthKey_("2026-08") !== "2026-Aug" || tg_monthKey_("2026-Aug") !== "2026-Aug")
    throw new Error("tg_monthKey_ FAIL: " + tg_monthKey_("2026-08") + " / " + tg_monthKey_("2026-Aug"));

  // Only the filters the model supplied are passed through — a blank must not
  // become month:"" (api_listTransactions would still treat it as unset, but an
  // empty category would silently match nothing).
  const all = tg_queryFilters_({ month: "2026-08", category: "Food", account: "Maya", search: "lunch" });
  if (all.month !== "2026-Aug" || all.category !== "Food" || all.account !== "Maya" ||
      all.search !== "lunch" || all.limit !== 500)
    throw new Error("tg_queryFilters_ FAIL (all): " + JSON.stringify(all));
  [null, {}, { month: "", category: null }].forEach(function (q) {
    const got = tg_queryFilters_(q);
    if (Object.keys(got).join() !== "limit")
      throw new Error("tg_queryFilters_ FAIL (empty): " + JSON.stringify(got));
  });

  if (tg_querySummary_([], 0) !== "No matching transactions.")
    throw new Error("tg_querySummary_ FAIL: empty result");
  // Income (+) and expense (−) rows both count toward "how much moved through".
  const rows = [{ Date: "2026-08-01", Category: "Food", Description: "lunch", "Amount (PHP)": -250 },
                { Date: "2026-08-02", Category: "Food", Description: "", "Amount (PHP)": 100.5 }];
  const s = tg_querySummary_(rows);
  if (s.indexOf("*₱350.5* across 2 tx") !== 0 || s.indexOf("— lunch `₱250`") === -1 || s.indexOf("more") !== -1)
    throw new Error("tg_querySummary_ FAIL: " + s);
  // total > rows.length (page cut short) reports the true count and says so.
  const capped = tg_querySummary_(rows, 9);
  if (capped.indexOf("across 9 tx") === -1 || capped.indexOf("› _…7 more_") === -1)
    throw new Error("tg_querySummary_ FAIL (capped): " + capped);
  Logger.log("test_telegramQuery OK");
}

/** tg_balanceText_ — account filtering, native-vs-PHP display, signed net-worth total. */
function test_telegramBalance() {
  const accts = [
    { name: "Maya", currency: "PHP", balancePhp: 1200.5, balanceNative: 1200.5, netWorthPhp: 1200.5, isLiability: false },
    { name: "IBKR USD", currency: "USD", balancePhp: 5600, balanceNative: 100, netWorthPhp: 5600, isLiability: false },
    { name: "BPI Credit Card", currency: "PHP", balancePhp: 8000, balanceNative: 8000, netWorthPhp: -8000, isLiability: true }
  ];
  const all = tg_balanceText_(accts, null);
  // Non-PHP leads native, PHP behind it; liabilities are flagged and pull the total down.
  if (all.indexOf("› _IBKR USD_ `$100` · `₱5,600`") === -1) throw new Error("tg_balanceText_ FAIL (native): " + all);
  if (all.indexOf("› _BPI Credit Card_ `₱8,000` owed") === -1) throw new Error("tg_balanceText_ FAIL (liability): " + all);
  if (all.indexOf("*Total* `-₱1,199.5`") === -1) throw new Error("tg_balanceText_ FAIL (total): " + all);

  // One account: case-insensitive partial name, and no total line for a single row.
  const one = tg_balanceText_(accts, "maya");
  if (one !== "💰 *Balance*\n› _Maya_ `₱1,200.5`") throw new Error("tg_balanceText_ FAIL (single): " + one);
  if (tg_balanceText_(accts, "gcash").indexOf("No account matching") === -1)
    throw new Error("tg_balanceText_ FAIL: unknown account should say so");
  Logger.log("test_telegramBalance OK");
}

/** Undo button payload — round-trips to the same IDs tg_logItems_ wrote, and only ours. */
function test_telegramUndoData() {
  const ids = tg_undoIds_(tg_undoData_(90210, [0, 2]));
  if (ids.join("|") !== "tg-90210-0|tg-90210-2")
    throw new Error("tg_undoIds_ FAIL: " + JSON.stringify(ids));
  ["", null, "u:90210:", "u:abc:0", "undo", "u:90210:0;DROP"].forEach(function (bad) {
    if (tg_undoIds_(bad).length) throw new Error("tg_undoIds_ FAIL: accepted " + JSON.stringify(bad));
  });
  Logger.log("test_telegramUndoData OK");
}

/** tx_parseDate_ — the Date gotcha: ISO "yyyy-MM-dd" parses as a LOCAL date (no UTC day-shift). */
function test_parseDate() {
  const d = tx_parseDate_("2026-01-02");
  if (d.getFullYear() !== 2026 || d.getMonth() !== 0 || d.getDate() !== 2)
    throw new Error("tx_parseDate_ FAIL: ISO string day-shifted → " + d);
  const real = new Date(2026, 5, 15);
  if (tx_parseDate_(real) !== real) throw new Error("tx_parseDate_ FAIL: Date not passed through");
  [undefined, null, "", "not-a-date"].forEach(function (v) {
    const got = tx_parseDate_(v);
    if (!(got instanceof Date) || isNaN(got.getTime()))
      throw new Error("tx_parseDate_ FAIL: no valid fallback for " + JSON.stringify(v));
  });
  Logger.log("test_parseDate OK");
}

function test_referenceData() {
  const cats = tx_categoriesMap_(), accts = tx_accountsMap_();
  Logger.log("Categories: %s · Accounts: %s", Object.keys(cats).length, Object.keys(accts).length);
  if (!Object.keys(cats).length) Logger.log("FAIL: no categories loaded.");
  if (!Object.keys(accts).length) Logger.log("FAIL: no accounts loaded.");
}

function test_fx() {
  Logger.log("Live USD→PHP: %s", fx_liveRate_("USD", BASE_CURRENCY));
}

function test_bootstrap() {
  const b = api_getBootstrap();
  Logger.log("Bootstrap keys: %s · accounts: %s · categories: %s",
    Object.keys(b).join(","), b.accounts.length, Object.keys(b.categories).length);
}

function test_listTransactions() {
  const r = api_listTransactions({ limit: 5 });
  Logger.log("listTransactions total=%s, returned=%s", r.total, r.transactions.length);
  if (r.transactions.length) Logger.log("newest: %s", JSON.stringify(r.transactions[0]));
}

/**
 * Integrity check: does the ledger (Transactions) agree with the Accounts sheet's
 * balance formula? Compares the sheet's NATIVE `Current Balance` against an
 * independent recompute (Starting Balance + Σ native deltas). This is in native
 * currency, so USD and Shares accounts reconcile too (no FX noise). Any flagged
 * row means the ledger and the sheet's SUMIF disagree — a real data issue to chase.
 */
function test_balanceReconciliation() {
  const accts = api_getAccounts().accounts;
  const deltas = acct_computeDeltas_();
  Logger.log("== Ledger vs sheet balance (native currency) ==");
  accts.forEach(function (a) {
    const start = a.startingBalance || 0;
    const recompute = Math.round((start + (deltas[a.name] ? deltas[a.name].net : 0)) * 100) / 100;
    const sheetNative = a.balanceNative;
    const diff = (sheetNative === null) ? "n/a" : Math.round((recompute - sheetNative) * 100) / 100;
    const flag = (diff !== "n/a" && Math.abs(diff) >= 0.01) ? "  <-- CHECK" : "";
    Logger.log(a.name + " (" + a.currency + ") | sheet=" + sheetNative + " ledger=" + recompute +
               " diff=" + diff + " | PHP=" + a.balancePhp + flag);
  });
  Logger.log("Flagged rows = ledger and sheet disagree. Clean = the sheet's balance formula matches the Transactions ledger.");
}

/** Budget targets resolve and actuals roll up. Prints each segment + the
 *  Essentials+Rewards combined figure. Flags any percent row that couldn't resolve
 *  (MONTHLY_INCOME_PHP unset) or USD cap with no FX. */
function test_budgets() {
  const b = api_getBudgets();
  Logger.log("== Budgets (month=%s, incomePHP=%s, fx=%s) ==", b.month, b.incomePhp, b.fxUsdPhp);
  b.budgets.forEach(function (x) {
    const flag = (x.targetPhp === null) ? "  <-- target unresolved" : "";
    Logger.log(x.segment + " [" + x.period + " " + x.targetType + " " + x.targetValue +
      (x.currency ? " " + x.currency : "") + "] target=" + x.targetPhp +
      " actual=" + x.actualPhp + " remaining=" + x.remainingPhp + " used=" + x.pctUsed + "%" +
      (x.isOver ? " OVER" : "") + flag);
  });
  if (b.essentialsRewards) {
    const er = b.essentialsRewards;
    Logger.log("Essentials+Rewards: target=" + er.targetPhp + " actual=" + er.actualPhp +
      " remaining=" + er.remainingPhp + " used=" + er.pctUsed + "%" + (er.isOver ? " OVER" : ""));
  }
  if (!b.budgets.length) Logger.log("FAIL: no budget rows — run Migration.setupBudgets() and check the Budgets sheet.");
}

/** Create a throwaway transaction with real category/account, read it, delete it. */
function test_createReadDelete() {
  const cat = Object.keys(tx_categoriesMap_())[0];
  const acc = Object.keys(tx_accountsMap_())[0];
  if (!cat || !acc) { Logger.log("SKIP createReadDelete: need at least one category and account."); return; }

  const created = api_createTransaction({ Category: cat, Account: acc, Amount: 1, Description: "TEST — auto-delete" });
  const id = created.transaction.ID;
  Logger.log("created id=%s month=%s type=%s amountPhp=%s",
    id, created.transaction.Month, created.transaction.Type, created.transaction["Amount (PHP)"]);

  const found = api_listTransactions({ search: "auto-delete", limit: 5 });
  Logger.log("list found %s row(s) matching test marker", found.total);

  const del = api_deleteTransaction({ ID: id });
  Logger.log("deleted: %s", del.status);

  const after = su_findRowById_(su_sheet_(SHEET_TX), su_headerMap_(su_sheet_(SHEET_TX)), id);
  Logger.log(after ? "FAIL: row still present after delete." : "OK: test row cleaned up.");
}
