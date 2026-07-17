/**
 * Accounts.gs — account listing, balances, and edits.
 *
 * Balances are NOT recomputed in code. The Accounts sheet already derives them by
 * formula: `Current Balance` (native currency) and `Current Balance (PHP)` =
 * Starting Balance + Σ transactions, with live FX for non-PHP accounts and Google
 * Finance pricing for Shares. The service layer just READS those — same principle
 * as the Transactions ARRAYFORMULAs (derivation lives in the Sheet). Because the
 * sheet's totals are SUMIFs over Transactions, they stay live the instant the API
 * appends a row.
 *
 * `balancePhp` is the sheet value as shown (liabilities are positive amounts owed);
 * `netWorthPhp` is signed for net-worth math (liabilities negative). For Shares
 * accounts `balanceNative` is the share quantity. The JS ledger recompute survives
 * only in Tests.gs (test_balanceReconciliation) as an independent integrity check.
 */

// Editable Account columns (never write a formula/derived column like Current Balance).
const ACCOUNT_EDITABLE = ["Starting Balance", "Interest Frequency", "Interest Rate", "Credit Limit", "Notes", "Color"];
// Header candidates we tolerate for the same concept.
const ACCT_START_HEADERS  = ["Starting Balance", "Starting Balance (PHP)", "Start Balance"];
const ACCT_NATIVE_HEADERS = ["Current Balance"];                                  // native currency
const ACCT_STORED_HEADERS = ["Current Balance (PHP)", "Current Balance", "Balance (PHP)"]; // PHP (formula)
const ACCT_CREDIT_HEADERS = ["Available Credit"];

function api_getAccounts() {
  const accounts = su_readObjects_(SHEET_ACCOUNTS);
  const out = accounts.map(function (a) {
    const type = a.Type || null;
    const isLiability = /liab/i.test(String(type));
    const isShares = String(a.Currency).toUpperCase() === "SHARES" ||
                     /share|stock/i.test(String(a.Subtype || ""));
    const isInvestment = acct_isInvestment_(a.Currency, a.Subtype);
    const balancePhp = acct_pickNum_(a, ACCT_STORED_HEADERS);
    const signed = (balancePhp === null) ? null : (isLiability ? -balancePhp : balancePhp);
    return {
      name: a.Name,
      currency: a.Currency || null,
      type: type,
      subtype: a.Subtype || null,
      startingBalance: acct_pickNum_(a, ACCT_START_HEADERS),
      balancePhp: balancePhp,                        // sheet value as shown (liabilities positive)
      balanceNative: acct_pickNum_(a, ACCT_NATIVE_HEADERS), // native; for Shares this is the quantity
      netWorthPhp: signed,                           // signed for net-worth (liabilities negative)
      availableCredit: acct_pickNum_(a, ACCT_CREDIT_HEADERS),
      isLiability: isLiability,
      isShares: isShares,           // Shares accounts only — used for quantity-vs-value
      isInvestment: isInvestment,   // "counts as an investment" (Dashboard tile + Investments screen)
      interestFrequency: a["Interest Frequency"] || null,
      interestRate: a["Interest Rate"] || null,
      creditLimit: acct_pickNum_(a, ["Credit Limit"]),
      notes: a.Notes || null,
      color: a.Color || null   // optional hex for color-coding (blank before setupAccountColor)
    };
  });
  return { status: "success", accounts: out };
}

/**
 * Independent ledger recompute in NATIVE currency, per account, for Tests.gs:
 *   net = Σ (Income +, Expense −, Transfer: source −Amount, dest +ToAmount).
 * Liability accounts (credit cards) track an amount-OWED that moves opposite to
 * asset cash — a charge increases the balance — so their deltas are inverted to
 * match the sheet's positive-owed convention. Each account's transactions are in
 * its own currency, so this is comparable to the sheet's native `Current Balance`.
 * Returns { name: { net, count } }.
 */
function acct_computeDeltas_() {
  const liab = {};
  su_readObjects_(SHEET_ACCOUNTS).forEach(function (a) {
    if (/liab/i.test(String(a.Type || ""))) liab[a.Name] = true;
  });
  const rows = su_readObjects_(SHEET_TX);
  const acc = {};
  function bump(name, v) {
    if (!name) return;
    if (liab[name]) v = -v; // liability: owed balance moves opposite to asset cash
    if (!acc[name]) acc[name] = { net: 0, count: 0 };
    acc[name].net += v; acc[name].count += 1;
  }
  rows.forEach(function (r) {
    const type = String(r.Type || "");
    const amt = acct_num_(r.Amount);
    const toAmt = acct_num_(r.ToAmount);
    if (type === "Transfer")      { bump(r.Account, -amt); bump(r.ToAccount, toAmt); }
    else if (type === "Expense")  { bump(r.Account, -amt); }
    else                          { bump(r.Account, amt); } // Income / untyped → inflow
  });
  return acc;
}

// ── update an account (editable input columns only) ───────────────────────────
function api_updateAccount(args) {
  args = args || {};
  if (!args.Name) throw new Error("updateAccount requires Name.");
  su_lock_();
  const sheet = su_sheet_(SHEET_ACCOUNTS);
  const h = su_headerMap_(sheet);
  const all = su_readObjects_(SHEET_ACCOUNTS);
  const target = all.filter(function (a) { return a.Name === args.Name; })[0];
  if (!target) throw new Error("Unknown Account: " + args.Name);

  let wrote = 0;
  ACCOUNT_EDITABLE.forEach(function (field) {
    if (args[field] === undefined) return;
    const col = h[field];
    if (!col) return;
    sheet.getRange(target.__row, col).setValue(args[field]);
    wrote++;
  });
  if (!wrote) throw new Error("No editable fields supplied. Editable: " + ACCOUNT_EDITABLE.join(", "));
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  return { status: "success", message: "Account updated.", name: args.Name, fieldsWritten: wrote };
}

// ── helpers ───────────────────────────────────────────────────────────────────
/** Shared "counts as an investment" test — Dashboard Invested tile + Investments screen must agree. */
function acct_isInvestment_(currency, subtype) {
  return String(currency).toUpperCase() === "SHARES" || /share|stock|invest|etf/i.test(String(subtype || ""));
}
function acct_pick_(obj, headers) {
  for (let i = 0; i < headers.length; i++) if (obj[headers[i]] !== undefined && obj[headers[i]] !== "") return obj[headers[i]];
  return "";
}
/** Like acct_pick_ but coerced to a number, or null when the cell is blank. */
function acct_pickNum_(obj, headers) {
  const v = acct_pick_(obj, headers);
  return (v === "" || v === null || v === undefined) ? null : acct_num_(v);
}
function acct_num_(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[, ()]/g, function (m) { return m === "(" ? "-" : ""; }));
  return isNaN(n) ? 0 : n;
}
