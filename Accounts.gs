/**
 * Accounts.gs — account listing, derived balances, and edits.
 *
 * Balance model (OVERHAUL_PLAN §4.4): balance = Starting Balance + Σ transaction
 * deltas, signed by category Type (Income +, Expense −, Transfer moves between
 * the source Account and ToAccount). Amounts are taken in PHP from the
 * `Amount (PHP)` formula column.
 *
 * ⚠ LIVE-DATA ASSUMPTIONS to verify with Tests.gs (acct schema isn't visible from
 * here): (a) the Starting-Balance header name; (b) whether `Amount` is stored
 * unsigned (Type drives sign — what we assume) or already signed; (c) Shares
 * accounts — quantity is derived, but PHP valuation stays with the sheet's
 * Google-Finance `Current Balance (PHP)`. `computedBalance` is shown next to the
 * sheet's `storedBalance` so any drift is obvious before the UI trusts it.
 */

// Editable Account columns (never write a formula/derived column like Current Balance).
const ACCOUNT_EDITABLE = ["Starting Balance", "Interest Frequency", "Interest Rate", "Credit Limit", "Notes"];
// Header candidates we tolerate for the same concept.
const ACCT_START_HEADERS  = ["Starting Balance", "Starting Balance (PHP)", "Start Balance"];
const ACCT_STORED_HEADERS = ["Current Balance (PHP)", "Current Balance", "Balance (PHP)"];

function api_getAccounts() {
  const accounts = su_readObjects_(SHEET_ACCOUNTS);
  const deltas = acct_computeDeltas_();
  const out = accounts.map(function (a) {
    const name = a.Name;
    const start = acct_num_(acct_pick_(a, ACCT_START_HEADERS));
    const stored = acct_pick_(a, ACCT_STORED_HEADERS);
    const d = deltas[name] || { net: 0, qty: 0, count: 0 };
    const isShares = String(a.Currency).toUpperCase() === "SHARES" ||
                     /share|stock/i.test(String(a.Subtype || ""));
    const isPhp = String(a.Currency || BASE_CURRENCY).toUpperCase() === BASE_CURRENCY;
    const computed = isShares ? null : Math.round((start + d.net) * 100) / 100;
    const storedNum = (stored === "" || stored === undefined) ? null : acct_num_(stored);

    // Which PHP figure to trust: PHP cash accounts derive cleanly (validated), so
    // use computed. Non-PHP (FX) and Shares accounts can't be valued by summing
    // historical Amount (PHP) — the sheet already prices them via live FX / Google
    // Finance, so we trust the sheet's stored balance there.
    let balancePhp, balanceSource;
    if (isShares)        { balancePhp = storedNum; balanceSource = "stored:shares"; }
    else if (!isPhp)     { balancePhp = (storedNum !== null ? storedNum : computed); balanceSource = "stored:fx"; }
    else                 { balancePhp = computed; balanceSource = "computed"; }

    return {
      name: name,
      currency: a.Currency || null,
      type: a.Type || null,
      subtype: a.Subtype || null,
      startingBalance: start,
      balancePhp: balancePhp,            // the figure the UI/dashboard should use
      balanceSource: balanceSource,
      computedBalance: computed,         // derived (PHP-cash authoritative; else reference)
      computedQuantity: isShares ? (start + d.qty) : null,
      storedBalance: storedNum,
      txCount: d.count,
      interestFrequency: a["Interest Frequency"] || null,
      interestRate: a["Interest Rate"] || null,
      creditLimit: a["Credit Limit"] || null,
      notes: a.Notes || null
    };
  });
  return { status: "success", accounts: out };
}

/** One pass over Transactions → per-account { net (PHP), qty (shares), count }. */
function acct_computeDeltas_() {
  const rows = su_readObjects_(SHEET_TX);
  const acc = {};
  function bump(name, field, v) {
    if (!name) return;
    if (!acc[name]) acc[name] = { net: 0, qty: 0, count: 0 };
    acc[name][field] += v;
    if (field === "net" || field === "qty") acc[name].count += 1;
  }
  rows.forEach(function (r) {
    const type = String(r.Type || "");
    const amtPhp = acct_num_(r["Amount (PHP)"]);
    const rawAmt = acct_num_(r.Amount);
    const isSharesRow = String(r.Currency).toUpperCase() === "SHARES";

    if (type === "Transfer") {
      // Source loses; destination gains (ToAmount in dest currency → PHP best-effort).
      if (isSharesRow) bump(r.Account, "qty", -rawAmt);
      else             bump(r.Account, "net", -amtPhp);
      const toPhp = acct_toAmountPhp_(r);
      if (String(r.ToCurrency).toUpperCase() === "SHARES") bump(r.ToAccount, "qty", acct_num_(r.ToAmount));
      else                                                  bump(r.ToAccount, "net", toPhp);
    } else if (type === "Expense") {
      if (isSharesRow) bump(r.Account, "qty", -rawAmt); else bump(r.Account, "net", -amtPhp);
    } else { // Income or untyped → treat as inflow
      if (isSharesRow) bump(r.Account, "qty", rawAmt); else bump(r.Account, "net", amtPhp);
    }
  });
  return acc;
}

// ── update an account (editable input columns only) ───────────────────────────
function api_updateAccount(args) {
  args = args || {};
  if (!args.Name) throw new Error("updateAccount requires Name.");
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
  return { status: "success", message: "Account updated.", name: args.Name, fieldsWritten: wrote };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function acct_pick_(obj, headers) {
  for (let i = 0; i < headers.length; i++) if (obj[headers[i]] !== undefined && obj[headers[i]] !== "") return obj[headers[i]];
  return "";
}
function acct_num_(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
}
/** Destination PHP value of a transfer's ToAmount (best-effort for cross-currency). */
function acct_toAmountPhp_(r) {
  const toAmt = acct_num_(r.ToAmount);
  if (!toAmt) return 0;
  const cur = String(r.ToCurrency || BASE_CURRENCY).toUpperCase();
  if (cur === BASE_CURRENCY) return toAmt;
  const rate = fx_liveRate_(cur, BASE_CURRENCY);
  return rate ? toAmt * rate : toAmt; // fall back to face value if no rate
}
