/**
 * Tests.gs — manual verification runners for the Phase 1 service layer.
 * Select a function in the Apps Script editor and Run, then read the Logs.
 * Nothing here is web-exposed. test_createReadDelete_ mutates then cleans up
 * after itself; test_balanceReconciliation is the one that validates the balance
 * assumptions documented in Accounts.gs.
 */

function test_all() {
  test_a1();
  test_assertShape();
  test_byDateDesc();
  test_isInvestment();
  test_ledgerCoerce();
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
