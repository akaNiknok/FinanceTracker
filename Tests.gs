/**
 * Tests.gs — manual verification runners for the Phase 1 service layer.
 * Select a function in the Apps Script editor and Run, then read the Logs.
 * Nothing here is web-exposed. test_createReadDelete_ mutates then cleans up
 * after itself; test_balanceReconciliation is the one that validates the balance
 * assumptions documented in Accounts.gs.
 */

function test_all() {
  test_referenceData();
  test_fx();
  test_bootstrap();
  test_listTransactions();
  test_balanceReconciliation();
  test_createReadDelete();
  Logger.log("== test_all complete ==");
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
