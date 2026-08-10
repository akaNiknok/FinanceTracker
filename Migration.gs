/**
 * Migration.gs — one-shot schema setup for the workbook.
 *
 * ALL of these have already been applied to the live workbook (confirmed 2026-08-02);
 * they are kept only for rebuilding a workbook from scratch. Old step-by-step runbook:
 * `git show v1.3.4:MIGRATION.md`.
 *
 * Run ONCE from the Apps Script editor, in this order:
 *   1) setupMigration()          — backs up Transactions, adds the `ID` column,
 *                                   backfills a UUID into every existing row.
 *   2) applyDerivationFormulas() — converts the per-row derived columns
 *                                   (Month, Type, Segment, Currency, Amount (PHP),
 *                                   ToCurrency) into single header-anchored ARRAYFORMULAs.
 *
 * Everything is idempotent and column lookups are by HEADER NAME, so it tolerates
 * columns being in a different order. A timestamped backup sheet is made before any
 * change.
 *
 * REVIEW BEFORE RUNNING: MIG_MONTH_FORMAT must match what your Dashboard pivots expect.
 */

// ── Config (review these) ─────────────────────────────────────────────────────
const MIG_TX_SHEET    = "Transactions";
const MIG_ID_HEADER   = "ID";
// MUST stay "yyyy-mmm" (→ 2026-Jun): dash_currentMonth_, the UI month keys and every
// Month filter compare against this exact shape. Changing it silently empties every
// month-keyed report.
const MIG_MONTH_FORMAT = "yyyy-mmm";
const MIG_PERIOD_HEADER = "Period"; // optional reporting-month override (setupTxPeriod)
const MIG_PERIOD_TEXT_FORMAT = "yyyy-MMM"; // Utilities.formatDate equivalent of MIG_MONTH_FORMAT

// AccountType migration (setupAccountType): derive Accounts.Type from Subtype.
const MIG_ACCT_SHEET     = "Accounts";
const MIG_ACCTTYPE_SHEET = "AccountType"; // reference tab (no spaces — used in a formula ref)
// Seed Subtype → Type. Extend/edit in the sheet after running; new Subtypes found
// in Accounts are auto-appended (guessed) and logged for review.
const MIG_ACCTTYPE_SEED = [
  ["Liquid", "Asset"], ["EF", "Asset"], ["Receivable", "Asset"],
  ["For Investment", "Asset"], ["Stocks", "Asset"], ["Credit", "Liability"]
];

// Data-validation dropdowns (setupDataValidation).
const MIG_VALIDATION_STRICT = false; // false = warn on bad entry; true = reject it outright
const MIG_INTEREST_FREQS = ["Daily", "Weekly", "Monthly", "Quarterly", "Annually"];

// Budgets redesign (setupBudgets): targets-only Budgets sheet + a Recurring sheet.
// The Budgets sheet stores only the PLAN; actuals/remaining/% are computed live in
// Budgets.gs. Hybrid targets: Percent rows resolve against MONTHLY_INCOME_PHP,
// the Growth USD cap converts at live FX. Tweak the seed after running.
const MIG_BUDGETS_SHEET   = "Budgets";
const MIG_RECURRING_SHEET = "Recurring";
const MIG_BUDGET_HEADERS  = ["Segment", "Period", "Target Type", "Target", "Currency", "Notes"];
const MIG_BUDGET_SEED = [
  ["Essentials", "Monthly",   "Percent", 50,  "",    ""],
  ["Rewards",    "Monthly",   "Percent", 10,  "",    ""],
  ["Stability",  "Monthly",   "Percent", 15,  "",    "unfunded until a dedicated savings account exists"],
  ["Growth",     "Quarterly", "Amount",  200, "USD", "quarterly investing cap"]
];
const MIG_RECURRING_HEADERS  = ["Description", "Currency", "Amount", "Transaction Fee", "Months Left", "Group"];
const MIG_DEFAULT_INCOME_PHP = 47200; // sets MONTHLY_INCOME_PHP if it isn't set yet

// Derived columns that become ARRAYFORMULAs (input columns are left untouched).
// ExchangeRate is intentionally NOT here — it stays a static, stamped input so FX
// history never drifts. Amount (PHP) = Amount × ExchangeRate (frozen per row).

// ── 1. ID column + backfill (the part that needs code) ────────────────────────
function setupMigration() {
  const sheet = mig_getTxSheet_();
  Logger.log("== setupMigration: %s ==", MIG_TX_SHEET);

  // 1a. Safety backup (values + formulas) before touching anything.
  const backup = mig_backupSheet_(sheet);
  Logger.log("Backup created: %s", backup.getName());

  // 1b. Ensure the ID column exists (appended at the end if missing).
  let headers = mig_headerMap_(sheet);
  let idCol = headers[MIG_ID_HEADER];
  if (!idCol) {
    const lastCol = sheet.getLastColumn();
    if (sheet.getMaxColumns() === lastCol) sheet.insertColumnAfter(lastCol);
    idCol = lastCol + 1;
    sheet.getRange(1, idCol).setValue(MIG_ID_HEADER);
    Logger.log("Added '%s' column at position %s.", MIG_ID_HEADER, idCol);
  } else {
    Logger.log("'%s' column already present at position %s.", MIG_ID_HEADER, idCol);
  }

  // 1c. Backfill UUIDs into any blank ID cell (batched).
  const added = mig_fillIds_(sheet, idCol);
  Logger.log("Backfilled %s new ID(s).", added);
  Logger.log("== setupMigration done. Next: review MIG_MONTH_FORMAT, then run applyDerivationFormulas(). ==");
}

/** Re-runnable: stamp IDs onto rows you later add by hand (no backup, no other changes). */
function stampMissingIds() {
  const sheet = mig_getTxSheet_();
  const idCol = mig_headerMap_(sheet)[MIG_ID_HEADER];
  if (!idCol) throw new Error("No '" + MIG_ID_HEADER + "' column — run setupMigration() first.");
  Logger.log("stampMissingIds: filled %s row(s).", mig_fillIds_(sheet, idCol));
}

// ── 2. ARRAYFORMULA conversion (review formulas, then run) ─────────────────────
function applyDerivationFormulas() {
  const sheet = mig_getTxSheet_();
  const h = mig_headerMap_(sheet);
  const need = ["Date", "Month", "Category", "Type", "Segment", "Account", "Currency", "Amount", "Amount (PHP)", "ExchangeRate"];
  const missing = need.filter(function (n) { return !h[n]; });
  if (missing.length) throw new Error("Missing expected column(s): " + missing.join(", "));

  const L = function (name) { return mig_colLetter_(h[name]); }; // header → A1 column letter
  const d = L("Date"), cat = L("Category"), acc = L("Account"), amt = L("Amount"), fx = L("ExchangeRate");

  // Categories: A=Category, B=Type, C=Segment.  Accounts: A=Name, B=Currency.
  const formulas = {
    "Month":        mig_monthFormula_(h),
    "Type":         '=ARRAYFORMULA(IF(LEN(' + cat + '2:' + cat + '), IFERROR(VLOOKUP(' + cat + '2:' + cat + ', Categories!$A:$C, 2, FALSE), ""), ""))',
    "Segment":      '=ARRAYFORMULA(IF(LEN(' + cat + '2:' + cat + '), IFERROR(VLOOKUP(' + cat + '2:' + cat + ', Categories!$A:$C, 3, FALSE), ""), ""))',
    "Currency":     '=ARRAYFORMULA(IF(LEN(' + acc + '2:' + acc + '), IFERROR(VLOOKUP(' + acc + '2:' + acc + ', Accounts!$A:$B, 2, FALSE), ""), ""))',
    "Amount (PHP)": '=ARRAYFORMULA(IF(LEN(' + amt + '2:' + amt + '), ' + amt + '2:' + amt + ' * IF(LEN(' + fx + '2:' + fx + '), ' + fx + '2:' + fx + ', 1), ""))'
  };

  // ToCurrency mirrors Currency but looks up the transfer destination (ToAccount).
  // Only present on workbooks that carry the transfer columns, so add it conditionally.
  if (h["ToAccount"] && h["ToCurrency"]) {
    const toAcc = L("ToAccount");
    formulas["ToCurrency"] = '=ARRAYFORMULA(IF(LEN(' + toAcc + '2:' + toAcc + '), IFERROR(VLOOKUP(' + toAcc + '2:' + toAcc + ', Accounts!$A:$B, 2, FALSE), ""), ""))';
  }

  const lastRow = sheet.getLastRow();
  Object.keys(formulas).forEach(function (colName) {
    const col = h[colName];
    const formula = formulas[colName];
    try {
      // Clear old per-row content BELOW row 2 first, so the array can spill in.
      if (lastRow >= 3) sheet.getRange(3, col, lastRow - 2, 1).clearContent();
      sheet.getRange(2, col).setFormula(formula);
      Logger.log("OK  %-13s ← %s", colName, formula);
    } catch (err) {
      Logger.log("FAIL %-12s (%s). Paste it into the column's row-2 cell manually.\n     %s", colName, err.message, formula);
    }
  });
  Logger.log("== applyDerivationFormulas done. Spot-check a few rows, then redeploy the SAME deploymentId. ==");
}

// ── 3. Derive Accounts.Type from Subtype (optional, run once) ──────────────────
// Removes the hand-maintained Asset/Liability column: Type becomes a VLOOKUP of
// Subtype against the AccountType reference. Robust to the Accounts tab being a
// Google Sheets Table — uses per-row formulas (which Tables auto-fill on new rows)
// instead of a whole-column ARRAYFORMULA (which Tables reject). Idempotent + backs
// up Accounts first. The service layer reads Type either way — no code change.
function setupAccountType() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("== setupAccountType ==");

  // 3a. Ensure the AccountType reference tab exists + is seeded.
  let ref = ss.getSheetByName(MIG_ACCTTYPE_SHEET);
  if (!ref) {
    ref = ss.insertSheet(MIG_ACCTTYPE_SHEET);
    ref.getRange(1, 1, 1, 2).setValues([["Subtype", "Type"]]);
    ref.getRange(2, 1, MIG_ACCTTYPE_SEED.length, 2).setValues(MIG_ACCTTYPE_SEED);
    Logger.log("Created '%s' with %s seed mapping(s).", MIG_ACCTTYPE_SHEET, MIG_ACCTTYPE_SEED.length);
  } else {
    Logger.log("'%s' already exists — leaving its mappings as-is.", MIG_ACCTTYPE_SHEET);
  }

  const acctSheet = ss.getSheetByName(MIG_ACCT_SHEET);
  if (!acctSheet) throw new Error("Sheet not found: " + MIG_ACCT_SHEET);
  const h = mig_headerMap_(acctSheet);
  const subCol = h["Subtype"], typeCol = h["Type"], nameCol = h["Name"] || 1;
  if (!subCol)  throw new Error("Accounts has no 'Subtype' column.");
  if (!typeCol) throw new Error("Accounts has no 'Type' column.");

  // 3b. Backfill any Subtypes used in Accounts but missing from the reference.
  const map = mig_acctTypeMap_(ref);
  const lastRow = acctSheet.getLastRow();
  const subs  = lastRow >= 2 ? acctSheet.getRange(2, subCol, lastRow - 1, 1).getValues() : [];
  const names = lastRow >= 2 ? acctSheet.getRange(2, nameCol, lastRow - 1, 1).getValues() : [];
  const added = [], blanks = [];
  subs.forEach(function (rowv, i) {
    const sub = String(rowv[0]).trim();
    if (sub === "") { blanks.push(names[i][0]); return; }
    if (map[sub.toLowerCase()] === undefined) {
      const guess = /credit|loan|liab|payable|debt|mortgage/i.test(sub) ? "Liability" : "Asset";
      ref.appendRow([sub, guess]);
      map[sub.toLowerCase()] = guess;
      added.push(sub + "→" + guess);
    }
  });
  if (added.length)  Logger.log("Added unseen Subtype(s) — REVIEW in %s: %s", MIG_ACCTTYPE_SHEET, added.join(", "));
  if (blanks.length) Logger.log("Accounts with BLANK Subtype (will default to Asset; set a Subtype for correct reports): %s", blanks.join(", "));

  // 3c. Backup Accounts, then write the per-row Type formula.
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  acctSheet.copyTo(ss).setName(MIG_ACCT_SHEET + "_backup_" + stamp);
  Logger.log("Backup created: %s_backup_%s", MIG_ACCT_SHEET, stamp);

  const subL = mig_colLetter_(subCol);
  let n = 0;
  for (let r = 2; r <= lastRow; r++) {
    // matched Subtype → its Type · blank Subtype → "Asset" · present-but-unmatched → "" (visible).
    const f = '=IFERROR(VLOOKUP($' + subL + r + ', ' + MIG_ACCTTYPE_SHEET + '!$A:$B, 2, FALSE), IF($' + subL + r + '="","Asset",""))';
    acctSheet.getRange(r, typeCol).setFormula(f);
    n++;
  }
  Logger.log("Type now derives from Subtype on %s account row(s).", n);
  Logger.log("== setupAccountType done. (If Accounts is a Table, new rows auto-fill the formula.) ==");
}

// ── 4. Data-validation dropdowns (optional, re-runnable) ───────────────────────
// Controlled vocabularies so a manual typo can't silently break a VLOOKUP / SUMIF:
//   • Accounts.Subtype          ← the AccountType reference list
//   • Accounts.Interest Frequency ← a fixed list
//   • Transactions.Category     ← the Categories list
// Lenient by default (MIG_VALIDATION_STRICT=false): invalid entries are flagged
// (not blocked), so legacy values and service-layer writes aren't rejected. The
// dropdown still nudges correct manual entry; the service layer remains the hard
// validator. Range-backed dropdowns auto-extend as you add subtypes/categories.
function setupDataValidation() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const allowInvalid = !MIG_VALIDATION_STRICT;
  Logger.log("== setupDataValidation (strict=%s) ==", MIG_VALIDATION_STRICT);

  // 1. Accounts.Subtype ← AccountType!A2:A
  const acct = ss.getSheetByName(MIG_ACCT_SHEET);
  if (!acct) throw new Error("Sheet not found: " + MIG_ACCT_SHEET);
  const ah = mig_headerMap_(acct);
  const ref = ss.getSheetByName(MIG_ACCTTYPE_SHEET);
  if (ref && ah["Subtype"]) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(ref.getRange("A2:A100"), true)
      .setAllowInvalid(allowInvalid)
      .setHelpText("Pick a Subtype from the AccountType tab.").build();
    mig_applyValidationToColumn_(acct, ah["Subtype"], rule);
    Logger.log("Accounts.Subtype dropdown ← AccountType!A2:A100");
  } else {
    Logger.log("Skipped Subtype dropdown (need AccountType tab + Subtype column — run setupAccountType first).");
  }

  // 2. Accounts.'Interest Frequency' ← fixed list
  if (ah["Interest Frequency"]) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(MIG_INTEREST_FREQS, true)
      .setAllowInvalid(allowInvalid)
      .setHelpText("Daily / Weekly / Monthly / Quarterly / Annually (blank = none).").build();
    mig_applyValidationToColumn_(acct, ah["Interest Frequency"], rule);
    Logger.log("Accounts.'Interest Frequency' dropdown ← %s", MIG_INTEREST_FREQS.join("/"));
  } else {
    Logger.log("Skipped Interest Frequency dropdown (column not found).");
  }

  // 3. Transactions.Category ← Categories!A2:A
  const tx   = ss.getSheetByName(MIG_TX_SHEET);
  const cats = ss.getSheetByName("Categories");
  const th = tx ? mig_headerMap_(tx) : {};
  if (tx && cats && th["Category"]) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(cats.getRange("A2:A300"), true)
      .setAllowInvalid(allowInvalid)
      .setHelpText("Pick a Category from the Categories tab.").build();
    mig_applyValidationToColumn_(tx, th["Category"], rule);
    Logger.log("Transactions.Category dropdown ← Categories!A2:A300");
  } else {
    Logger.log("Skipped Category dropdown (need Transactions + Categories tabs and a Category column).");
  }

  Logger.log("== setupDataValidation done. Cells with a red corner = existing value not in the list (a typo to fix). ==");
}

// ── 5. Budgets redesign (optional, run once) ───────────────────────────────────
// Collapses the old Budgets sheet (3 duplicate target columns + a pinned, stale
// USD→PHP rate + sheet-computed actuals + an "Essentials & Rewards" roll-up row)
// into a targets-ONLY plan: Segment, Period, Target Type, Target, Currency, Notes.
// Actuals/remaining/% are computed live in Budgets.gs. The embedded "Monthly
// Expenses" table is split out into its own Recurring sheet. Backs up the old
// Budgets sheet wholesale; idempotent (re-running won't clobber an edited layout).
function setupBudgets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("== setupBudgets ==");

  const old = ss.getSheetByName(MIG_BUDGETS_SHEET);
  if (!old) throw new Error("Sheet not found: " + MIG_BUDGETS_SHEET);

  const hdr = old.getRange(1, 1, 1, Math.max(1, old.getLastColumn())).getValues()[0].map(String);
  if (hdr.indexOf("Target Type") !== -1) {
    Logger.log("Budgets already migrated (has 'Target Type') — not rebuilding it.");
  } else {
    // Read the whole old sheet up front; we mine the Monthly Expenses block from it.
    const grid = old.getDataRange().getValues();
    mig_buildRecurring_(ss, grid);

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
    old.setName(MIG_BUDGETS_SHEET + "_backup_" + stamp);
    Logger.log("Backup created: %s", old.getName());

    const fresh = ss.insertSheet(MIG_BUDGETS_SHEET);
    fresh.getRange(1, 1, 1, MIG_BUDGET_HEADERS.length).setValues([MIG_BUDGET_HEADERS]);
    fresh.getRange(2, 1, MIG_BUDGET_SEED.length, MIG_BUDGET_HEADERS.length).setValues(MIG_BUDGET_SEED);
    fresh.setFrozenRows(1);
    fresh.autoResizeColumns(1, MIG_BUDGET_HEADERS.length);
    Logger.log("Rebuilt '%s' with %s segment target row(s) — adjust the percents/cap to taste.", MIG_BUDGETS_SHEET, MIG_BUDGET_SEED.length);
  }

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty("MONTHLY_INCOME_PHP")) {
    props.setProperty("MONTHLY_INCOME_PHP", String(MIG_DEFAULT_INCOME_PHP));
    Logger.log("Set MONTHLY_INCOME_PHP = %s (Script Property) — update it when your income changes.", MIG_DEFAULT_INCOME_PHP);
  } else {
    Logger.log("MONTHLY_INCOME_PHP already set to %s.", props.getProperty("MONTHLY_INCOME_PHP"));
  }
  Logger.log("== setupBudgets done. No redeploy needed for the sheet change. ==");
}

/** Locate the 'Monthly Expenses' table inside the old Budgets grid (by its
 *  'Description' header) and copy it to a new Recurring sheet. Generic: reads down
 *  until a blank Description. Skips if a Recurring sheet already exists. */
function mig_buildRecurring_(ss, grid) {
  if (ss.getSheetByName(MIG_RECURRING_SHEET)) {
    Logger.log("'%s' already exists — leaving it as-is (not re-extracting).", MIG_RECURRING_SHEET);
    return;
  }
  let hRow = -1; const col = {};
  for (let r = 0; r < grid.length && hRow === -1; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (String(grid[r][c]).trim().toLowerCase() === "description") { hRow = r; break; }
    }
  }
  if (hRow === -1) {
    Logger.log("No 'Monthly Expenses' (Description) block found — created an empty Recurring sheet.");
    mig_writeRecurring_(ss, []);
    return;
  }
  grid[hRow].forEach(function (cell, c) {
    const k = String(cell).trim().toLowerCase();
    if (k === "description") col.desc = c;
    else if (k === "currency") col.cur = c;
    else if (k === "amount") col.amt = c;
    else if (k.indexOf("fee") !== -1) col.fee = c;
    else if (k.indexOf("month") !== -1) col.months = c;
  });
  const pick = function (row, c) { return (c === undefined) ? "" : row[c]; };
  const out = [];
  for (let r = hRow + 1; r < grid.length; r++) {
    const desc = String(grid[r][col.desc]).trim();
    if (desc === "") break; // table ends at the first blank Description
    const group = /sss|bir|philhealth|pag-?ibig/i.test(desc) ? "Govt" : "";
    out.push([desc, pick(grid[r], col.cur), pick(grid[r], col.amt), pick(grid[r], col.fee), pick(grid[r], col.months), group]);
  }
  mig_writeRecurring_(ss, out);
  Logger.log("Extracted %s recurring row(s) → '%s'.", out.length, MIG_RECURRING_SHEET);
}

function mig_writeRecurring_(ss, rows) {
  const sheet = ss.insertSheet(MIG_RECURRING_SHEET);
  sheet.getRange(1, 1, 1, MIG_RECURRING_HEADERS.length).setValues([MIG_RECURRING_HEADERS]);
  if (rows.length) sheet.getRange(2, 1, rows.length, MIG_RECURRING_HEADERS.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, MIG_RECURRING_HEADERS.length);
}

// ── 6. Account color column (optional, run once) ───────────────────────────────
// Adds a 'Color' input column to Accounts so the Web App can color-code accounts.
// Stores a hex string per account (e.g. "#5b8cff"); blank = no color. Idempotent —
// does nothing if the column already exists. Edit colors via the Web App account
// modal or by typing a hex into the cell. (api_getAccounts reads it as `color`.)
const MIG_ACCT_COLOR_HEADER = "Color";
function setupAccountColor() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(MIG_ACCT_SHEET);
  if (!sheet) throw new Error("Sheet not found: " + MIG_ACCT_SHEET);
  const h = mig_headerMap_(sheet);
  if (h[MIG_ACCT_COLOR_HEADER]) { Logger.log("'%s' column already present at %s — nothing to do.", MIG_ACCT_COLOR_HEADER, h[MIG_ACCT_COLOR_HEADER]); return; }
  const lastCol = sheet.getLastColumn();
  if (sheet.getMaxColumns() === lastCol) sheet.insertColumnAfter(lastCol);
  sheet.getRange(1, lastCol + 1).setValue(MIG_ACCT_COLOR_HEADER);
  Logger.log("Added '%s' column at position %s. Set a hex color per account (or use the Web App).", MIG_ACCT_COLOR_HEADER, lastCol + 1);
}

// ── 7. Period override column (run once) ──────────────────────────────────────
// Adds the optional "Period" input column and makes Month prefer it. Point: income
// that arrives in the wrong calendar month (salary paid early, on the 31st) can be
// reported under the month it belongs to while Date keeps the real cash movement —
// so balances, reconciliation and daily interest stay honest. Everything month-keyed
// (cash flow, budget actuals, spendBySegment, the Transactions filter) reads Month,
// so no service-layer change is needed. Idempotent.
function setupTxPeriod() {
  const sheet = mig_getTxSheet_();
  let h = mig_headerMap_(sheet);
  if (!h["Date"] || !h["Month"])
    throw new Error("Transactions needs 'Date' and 'Month' — run setupMigration()/applyDerivationFormulas() first.");

  if (!h[MIG_PERIOD_HEADER]) {
    const lastCol = sheet.getLastColumn();
    if (sheet.getMaxColumns() === lastCol) sheet.insertColumnAfter(lastCol);
    sheet.getRange(1, lastCol + 1).setValue(MIG_PERIOD_HEADER);
    h = mig_headerMap_(sheet);
    Logger.log("Added '%s' column at position %s.", MIG_PERIOD_HEADER, h[MIG_PERIOD_HEADER]);
  } else {
    Logger.log("'%s' already present at position %s.", MIG_PERIOD_HEADER, h[MIG_PERIOD_HEADER]);
  }

  // Force the column to PLAIN TEXT. Without it Sheets coerces "2026-Aug" — written by
  // the API or typed by hand — into a date, and Month spills the raw serial (46235)
  // because LEN() still sees 5 characters. Formatting the column is the fix at source;
  // both write paths inherit it.
  const pCol = h[MIG_PERIOD_HEADER];
  sheet.getRange(2, pCol, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat("@");
  Logger.log("Set '%s' column format to plain text.", MIG_PERIOD_HEADER);

  const lastRow = sheet.getLastRow();
  // Repair rows written before the format was applied: a coerced Date becomes its
  // canonical yyyy-MMM text again. Anything already text is left alone.
  if (lastRow >= 2) {
    const range = sheet.getRange(2, pCol, lastRow - 1, 1);
    const vals = range.getValues();
    let fixed = 0;
    vals.forEach(function (r) {
      if (r[0] instanceof Date) {
        r[0] = Utilities.formatDate(r[0], Session.getScriptTimeZone(), MIG_PERIOD_TEXT_FORMAT);
        fixed++;
      }
    });
    if (fixed) { range.setValues(vals); Logger.log("Repaired %s date-coerced Period cell(s).", fixed); }
  }

  const formula = mig_monthFormula_(h);
  if (lastRow >= 3) sheet.getRange(3, h["Month"], lastRow - 2, 1).clearContent(); // let the array spill
  sheet.getRange(2, h["Month"]).setFormula(formula);
  Logger.log("Month ← %s", formula);
  Logger.log("== setupTxPeriod done. Spot-check Month, then redeploy the SAME deploymentId. ==");
}

// ── 8. Ledger ← Transactions link (run once) ──────────────────────────────────
// The BIR 8% ledger was hand-copied from the salary transactions. Now a row just
// points at a Transactions `ID` and everything derivable is a formula, so the only
// typed cells left are the BSP reference rate and Filed?. PHP conversion uses that
// **BSP rate**, NOT the app's ExchangeRate — BIR wants the central bank's rate on the
// date of receipt, which the app has no feed for, so it stays hand-typed per payslip.
//
// Header names below are the owner's EXISTING Ledger columns; only `Transaction ID`
// and `8% Tax` are new. Nothing here is guessed at runtime — rename a column in the
// sheet and you must rename it here too, or the migration adds a duplicate.
//
// Per-row formulas, not an ARRAYFORMULA: Ledger rows are appended and deleted one at
// a time (api_deleteLedgerRow does a real deleteRow), which would break a spill anchor.
// Ledger.gs already treats any formula cell as read-only via getFormula, so no write
// guard changes are needed. Idempotent; backs the sheet up first.
const MIG_LEDGER_SHEET = "Ledger";
const MIG_LEDGER_DATE  = "Date Received";
const MIG_LEDGER_GROSS = "Wise Amount";         // gross in the payout currency (USD)
const MIG_LEDGER_BSP   = "BSP Reference Rate";  // typed per row; blank ⇒ 1 (a PHP payslip)
const MIG_LEDGER_PHP   = "Total Income";        // = Wise Amount × BSP Reference Rate
const MIG_LEDGER_TAX   = "8% Tax";              // new column
const MIG_LEDGER_RATE  = 0.08;
const MIG_LEDGER_GONE  = "⚠ transaction deleted"; // shown in Date Received if the linked tx is gone
const MIG_LEDGER_INPUTS  = [LEDGER_TXID_HEADER, MIG_LEDGER_BSP, "Filed?"];
const MIG_LEDGER_DERIVED = [MIG_LEDGER_DATE, MIG_LEDGER_GROSS, MIG_LEDGER_PHP, MIG_LEDGER_TAX];

function setupLedgerSchema() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MIG_LEDGER_SHEET);
  if (!sheet) throw new Error("Sheet not found: " + MIG_LEDGER_SHEET);
  Logger.log("== setupLedgerSchema ==");
  Logger.log("Ledger headers before: %s", JSON.stringify(Object.keys(mig_headerMap_(sheet))));
  mig_backupSheet_(sheet, MIG_LEDGER_SHEET);

  const lastRow = sheet.getLastRow();
  const n = Math.max(lastRow - 1, 0);
  // Snapshot the sheet BEFORE adding columns: the backfill matches on the typed
  // Date/Gross values that step 3 is about to replace with formulas. Appending
  // columns never shifts existing ones, so the post-migration header map still
  // indexes this grid correctly (newly added columns read back undefined).
  const old = n ? sheet.getRange(2, 1, n, sheet.getLastColumn()).getValues() : [];

  // 1. Ensure every managed column exists (owner columns are left alone).
  let h = mig_headerMap_(sheet);
  MIG_LEDGER_INPUTS.concat(MIG_LEDGER_DERIVED).forEach(function (name) {
    if (h[name]) return;
    const lastCol = sheet.getLastColumn();
    if (sheet.getMaxColumns() === lastCol) sheet.insertColumnAfter(lastCol);
    sheet.getRange(1, lastCol + 1).setValue(name);
    h = mig_headerMap_(sheet);
    Logger.log("Added Ledger column '%s' at position %s.", name, h[name]);
  });

  // 2. Backfill the link on existing rows by matching date + gross to a salary tx.
  const tidCol = h[LEDGER_TXID_HEADER];
  const tids = n ? sheet.getRange(2, tidCol, n, 1).getValues() : [];
  const dIdx = h[MIG_LEDGER_DATE] - 1, gIdx = h[MIG_LEDGER_GROSS] - 1;
  const txRows = su_readObjects_(MIG_TX_SHEET);
  let linked = 0, unmatched = 0;
  for (let i = 0; i < n; i++) {
    if (String(tids[i][0]).trim() !== "") continue;
    const row = old[i] || [];
    const id = mig_matchSalaryTx_(txRows, su_dateStr_(row[dIdx]), row[gIdx]);
    if (id) { tids[i][0] = id; linked++; }
    else if (String(row[dIdx] == null ? "" : row[dIdx]) !== "") unmatched++;
  }
  if (n) sheet.getRange(2, tidCol, n, 1).setValues(tids);
  Logger.log("Backfilled %s link(s); %s row(s) left unlinked (ambiguous or not a salary tx — link or leave them by hand).", linked, unmatched);

  // 3. Stamp the derived formulas, but ONLY on linked rows — an unmatched legacy row
  //    keeps its typed figures rather than being blanked out.
  const txH = mig_headerMap_(mig_getTxSheet_());
  ["ID", "Date", "Amount"].forEach(function (c) {
    if (!txH[c]) throw new Error("Transactions is missing the '" + c + "' column — run setupMigration() first.");
  });
  const T = mig_colLetter_(tidCol);
  const gL = mig_colLetter_(h[MIG_LEDGER_GROSS]);
  const bL = mig_colLetter_(h[MIG_LEDGER_BSP]);
  const pL = mig_colLetter_(h[MIG_LEDGER_PHP]);
  const guard = function (body) { return '=IF(LEN($' + T + '{r}), ' + body + ', "")'; };
  const tmpl = {};
  // The deleted-tx warning rides on Date Received: it's the leftmost derived column,
  // so a broken link is visible in the Sheet itself without a Description column that
  // this ledger has never had.
  tmpl[MIG_LEDGER_DATE]  = mig_ledgerLookup_(txH, "Date", T, '"' + MIG_LEDGER_GONE + '"');
  tmpl[MIG_LEDGER_GROSS] = mig_ledgerLookup_(txH, "Amount", T, '""');
  // Blank BSP rate passes through as 1, which is what a PHP payslip wants.
  tmpl[MIG_LEDGER_PHP]   = guard(gL + '{r}*IF(LEN(' + bL + '{r}), ' + bL + '{r}, 1)');
  tmpl[MIG_LEDGER_TAX]   = guard(pL + '{r}*' + MIG_LEDGER_RATE);

  // ponytail: per-cell setFormula, 4 calls per linked row. One-shot on a sheet with
  // one row per payslip — batch per column if the Ledger ever gets long.
  let stamped = 0;
  for (let i = 0; i < n; i++) {
    if (String(tids[i][0]).trim() === "") continue;
    const r = i + 2;
    MIG_LEDGER_DERIVED.forEach(function (name) {
      sheet.getRange(r, h[name]).setFormula(tmpl[name].replace(/\{r\}/g, String(r)));
    });
    stamped++;
  }
  if (n) sheet.getRange(2, h[MIG_LEDGER_DATE], n, 1).setNumberFormat("yyyy-mm-dd");
  Logger.log("Stamped derivation formulas on %s linked row(s).", stamped);
  Logger.log("Ledger headers after: %s", JSON.stringify(Object.keys(mig_headerMap_(sheet))));
  Logger.log("== setupLedgerSchema done. New rows come from the Tax screen's 'Unlinked salary' list. ==");
}

/** `{r}`-templated per-row lookup of one Transactions column by the Ledger's link ID. */
function mig_ledgerLookup_(txH, header, tidLetter, fallback) {
  const ref = "'" + MIG_TX_SHEET + "'!";
  const idL = mig_colLetter_(txH["ID"]), tgt = mig_colLetter_(txH[header]);
  return '=IF(LEN($' + tidLetter + '{r}), IFNA(INDEX(' + ref + '$' + tgt + ':$' + tgt +
         ', MATCH($' + tidLetter + '{r}, ' + ref + '$' + idL + ':$' + idL + ', 0)), ' + fallback + '), "")';
}

/**
 * The one salary transaction matching a legacy Ledger row's date + gross, or null.
 * Ambiguity (two payslips, same day, same amount) returns null on purpose: a wrong
 * link would silently re-file the wrong figure, and the owner can pick by hand.
 */
function mig_matchSalaryTx_(txRows, dateStr, amount) {
  const amt = Math.abs(Number(amount));
  if (!dateStr || !isFinite(amt) || amt === 0) return null;
  const hits = txRows.filter(function (t) {
    return String(t.Category) === LEDGER_TX_CATEGORY
        && String(su_dateStr_(t.Date)) === String(dateStr)
        && Math.abs(Math.abs(Number(t.Amount)) - amt) < 0.005;
  });
  return hits.length === 1 ? String(hits[0].ID) : null;
}

// ── private helpers (trailing underscore = not web-exposed) ────────────────────
/**
 * Month = the Period override when a row sets one, else the row's own Date month.
 * Shared by applyDerivationFormulas + setupTxPeriod so the two can't drift; degrades
 * to the plain Date derivation on a workbook without the Period column.
 */
function mig_monthFormula_(h) {
  const d = mig_colLetter_(h["Date"]);
  const own = 'TEXT(' + d + '2:' + d + ',"' + MIG_MONTH_FORMAT + '")';
  const pCol = h[MIG_PERIOD_HEADER] ? mig_colLetter_(h[MIG_PERIOD_HEADER]) : null;
  const val = pCol
    ? 'IF(LEN(' + pCol + '2:' + pCol + '), ' + pCol + '2:' + pCol + ', ' + own + ')'
    : own;
  return '=ARRAYFORMULA(IF(LEN(' + d + '2:' + d + '), ' + val + ', ""))';
}

/** Apply a validation rule to a whole column (row 2 → last allocated row). */
function mig_applyValidationToColumn_(sheet, col, rule) {
  const last = sheet.getMaxRows();
  if (last < 2) return;
  sheet.getRange(2, col, last - 1, 1).setDataValidation(rule);
}

function mig_acctTypeMap_(ref) {
  const vals = ref.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < vals.length; i++) {
    const sub = String(vals[i][0]).trim();
    if (sub !== "") map[sub.toLowerCase()] = vals[i][1];
  }
  return map; // lowercased Subtype → Type
}

function mig_getTxSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MIG_TX_SHEET);
  if (!sheet) throw new Error("Sheet not found: " + MIG_TX_SHEET);
  return sheet;
}

function mig_headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach(function (name, i) { if (name !== "" && map[name] === undefined) map[name] = i + 1; });
  return map; // header text → 1-based column index
}

function mig_fillIds_(sheet, idCol) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const range = sheet.getRange(2, idCol, lastRow - 1, 1);
  const vals = range.getValues();
  let added = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === "" || vals[i][0] === null) { vals[i][0] = Utilities.getUuid(); added++; }
  }
  if (added) range.setValues(vals);
  return added;
}

function mig_backupSheet_(sheet, name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  return sheet.copyTo(ss).setName((name || MIG_TX_SHEET) + "_backup_" + stamp);
}

function mig_colLetter_(col) {
  let s = "";
  while (col > 0) { const m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

// ── One-shot: remove script-synthesized interest rows ─────────────────────────
/**
 * 2026-07-26. The daily-interest job was double-posting against interest the owner
 * already logs by hand from the bank app (23 duplicated MariBank days, Jun 11 -
 * Jul 3), and synthesizing estimates for Jul 4-26 that drifted from what the bank
 * actually paid. Decision: the bank statement is the source of truth for interest;
 * drop every row the job created. Script rows are identifiable by their
 * deterministic ID prefix, so this is exact. Run once from the editor, then set the
 * account's Interest Frequency to something other than Daily.
 */
function cleanupSyntheticInterest() {
  const ids = su_readObjects_(SHEET_TX)
    .map(function (r) { return String(r.ID); })
    .filter(function (id) { return id.indexOf("interest-") === 0; });
  if (!ids.length) { Logger.log("No script-generated interest rows found."); return; }
  Logger.log("Deleting %s row(s): %s ... %s", ids.length, ids[0], ids[ids.length - 1]);
  Logger.log(JSON.stringify(api_bulkDeleteTransactions({ ids: ids })));
}

// ── One-shot: merge two accounts into one ─────────────────────────────────────
/**
 * 2026-08-03. "Maya" and "Maya Savings" are one wallet in practice; owner wants the
 * history combined retroactively. `Name` is the immutable FK the ledger points at,
 * so a merge is: rewrite every Account/ToAccount reference, fold the Starting
 * Balance into the survivor, drop the absorbed Accounts row. Everything else is
 * derived — `Current Balance`, `Amount (PHP)`, budget actuals and the Dashboard all
 * refollow on their own.
 *
 * Transfers BETWEEN the two accounts are DELETED, not rewritten: after the merge
 * they'd be self-transfers (net zero) that still draw down their segment's budget.
 * That does change budget actuals for the months they sat in — which is the point.
 *
 * Transactions is backed up first and the deleted account row is logged verbatim.
 * Run once from the editor; a rerun is a no-op (the source account is gone).
 */
const MIG_MERGE_FROM = "Maya Savings"; // absorbed, then deleted
const MIG_MERGE_INTO = "Maya";         // survives, keeps its own rate/notes/color
function mergeAccounts() {
  const accts = su_readObjects_(SHEET_ACCOUNTS);
  const from = accts.filter(function (a) { return a.Name === MIG_MERGE_FROM; })[0];
  const into = accts.filter(function (a) { return a.Name === MIG_MERGE_INTO; })[0];
  if (!from) { Logger.log("No account named '%s' — already merged?", MIG_MERGE_FROM); return; }
  if (!into) throw new Error("No account named: " + MIG_MERGE_INTO);
  // Starting Balances are summed as-is, so a currency mismatch (or the liability
  // positive-owed convention meeting an asset) would silently corrupt the total.
  if (String(from.Currency) !== String(into.Currency))
    throw new Error("Currency mismatch: " + from.Currency + " vs " + into.Currency);
  if (String(from.Type) !== String(into.Type))
    throw new Error("Type mismatch: " + from.Type + " vs " + into.Type);

  Logger.log("Backup: %s", mig_backupSheet_(mig_getTxSheet_()).getName());
  const part = mig_mergePartition_(su_readObjects_(SHEET_TX), MIG_MERGE_FROM, MIG_MERGE_INTO);

  if (part.self.length)
    Logger.log("Deleted %s transfer(s) between the two: %s", part.self.length,
               JSON.stringify(api_bulkDeleteTransactions({ ids: part.self })));
  // Reassigning Account re-stamps ExchangeRate from the target's currency (blank for
  // PHP) — correct here, and the only reason both must share a currency.
  if (part.src.length)
    Logger.log("Account → %s: %s", MIG_MERGE_INTO,
               JSON.stringify(api_bulkUpdateTransactions({ ids: part.src, patch: { Account: MIG_MERGE_INTO } })));
  if (part.dst.length)
    Logger.log("ToAccount → %s: %s", MIG_MERGE_INTO,
               JSON.stringify(api_bulkUpdateTransactions({ ids: part.dst, patch: { ToAccount: MIG_MERGE_INTO } })));

  const start = acct_num_(into["Starting Balance"]) + acct_num_(from["Starting Balance"]);
  api_updateAccount({ Name: MIG_MERGE_INTO, "Starting Balance": start });

  Logger.log("Deleting Accounts row %s (keep this to restore): %s", from.__row, JSON.stringify(tx_clean_(from)));
  su_sheet_(SHEET_ACCOUNTS).deleteRow(from.__row);
  su_invalidateMemo_(SHEET_ACCOUNTS);
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  Logger.log("== merge done: %s absorbed into %s. Starting Balance now %s. Run test_balanceReconciliation. ==",
             MIG_MERGE_FROM, MIG_MERGE_INTO, start);
}

/**
 * Split the ledger for a merge: transfers between the pair (dead after the merge),
 * rows sourced from the absorbed account, rows destined for it. A row with BOTH
 * sides on the pair lands in `self` only, so it is never both deleted and patched.
 */
function mig_mergePartition_(rows, fromName, intoName) {
  const pair = {}; pair[fromName] = true; pair[intoName] = true;
  const out = { self: [], src: [], dst: [] };
  rows.forEach(function (r) {
    const id = String(r.ID);
    const to = (r.ToAccount === null || r.ToAccount === undefined) ? "" : String(r.ToAccount);
    if (to !== "" && pair[String(r.Account)] && pair[to]) { out.self.push(id); return; }
    if (String(r.Account) === fromName) out.src.push(id);
    if (to === fromName) out.dst.push(id);
  });
  return out;
}
