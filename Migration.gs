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

// ── private helpers (trailing underscore = not web-exposed) ────────────────────
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
