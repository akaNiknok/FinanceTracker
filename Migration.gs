/**
 * Migration.gs — one-shot setup for the system overhaul (Phase 1 foundation).
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
 * change. See MIGRATION.md for the full step-by-step + manual copy-paste fallback.
 *
 * REVIEW BEFORE RUNNING: MIG_MONTH_FORMAT must match what your Dashboard pivots expect.
 */

// ── Config (review these) ─────────────────────────────────────────────────────
const MIG_TX_SHEET    = "Transactions";
const MIG_ID_HEADER   = "ID";
const MIG_MONTH_FORMAT = "yyyy-mm"; // e.g. "yyyy-mm" → 2026-06 · "mmm-yyyy" → Jun-2026 · "mmmm" → June

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
    "Month":        '=ARRAYFORMULA(IF(LEN(' + d + '2:' + d + '), TEXT(' + d + '2:' + d + ',"' + MIG_MONTH_FORMAT + '"), ""))',
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
      Logger.log("FAIL %-12s (%s). Paste it manually — see MIGRATION.md.\n     %s", colName, err.message, formula);
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

// ── private helpers (trailing underscore = not web-exposed) ────────────────────
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

function mig_backupSheet_(sheet) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  return sheet.copyTo(ss).setName(MIG_TX_SHEET + "_backup_" + stamp);
}

function mig_colLetter_(col) {
  let s = "";
  while (col > 0) { const m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}
