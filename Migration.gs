/**
 * Migration.gs — one-shot setup for the system overhaul (Phase 1 foundation).
 *
 * Run ONCE from the Apps Script editor, in this order:
 *   1) setupMigration()          — backs up Transactions, adds the `ID` column,
 *                                   backfills a UUID into every existing row.
 *   2) applyDerivationFormulas() — converts the per-row derived columns
 *                                   (Month, Type, Segment, Currency, Amount (PHP))
 *                                   into single header-anchored ARRAYFORMULAs.
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

// ── private helpers (trailing underscore = not web-exposed) ────────────────────
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
