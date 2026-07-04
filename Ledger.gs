/**
 * Ledger.gs — edits for the BIR 8%-regime tracker (the Tax screen).
 *
 * Unlike Transactions/Budgets, the Ledger is an owner-maintained sheet with a
 * free-form, evolving column set, so there's no fixed input-column model to
 * declare. Writes are guarded generically instead: a cell holding a formula is
 * derived (e.g. total income, running 8% liability) and is never overwritten —
 * same "never write a derived column" invariant as the rest of the app, but the
 * Sheet itself tells us which columns those are (getFormula), so nothing is
 * hardcoded. api_getLedger lives in Reads.gs.
 */

/** Column indices (1-based) whose data cells hold a formula anywhere = derived. */
function ledger_derivedCols_(sheet) {
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  const derived = {};
  if (lastRow < 2 || lastCol < 1) return derived;
  const formulas = sheet.getRange(2, 1, lastRow - 1, lastCol).getFormulas();
  for (let c = 0; c < lastCol; c++) {
    for (let r = 0; r < formulas.length; r++) {
      if (formulas[r][c] !== "") { derived[c + 1] = true; break; }
    }
  }
  return derived;
}

/** Coerce a plain numeric string to a Number so it feeds SUM/total formulas;
 *  everything else (dates, text, "Filed?") passes through untouched. */
function ledger_coerce_(v) {
  if (typeof v === "string" && v !== "" && /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, ""))) {
    return Number(v.replace(/,/g, ""));
  }
  return v == null ? "" : v;
}

/** Set of derived column HEADERS, for the UI to render them read-only. */
function ledger_derivedHeaders_(sheet, headerMap) {
  const idx = ledger_derivedCols_(sheet);
  return Object.keys(headerMap).filter(function (h) { return idx[headerMap[h]]; });
}

// ── writes ────────────────────────────────────────────────────────────────────
/** Edit one ledger cell by (1-based sheet row, column header). Rejects formulas. */
function api_updateLedgerCell(args) {
  args = args || {};
  const row = parseInt(args.row, 10);
  if (!row || row < 2) throw new Error("updateLedgerCell requires a valid data row.");
  if (!args.header) throw new Error("updateLedgerCell requires a column header.");
  su_lock_();
  const sheet = su_sheet_(SHEET_LEDGER);
  const col = su_headerMap_(sheet)[args.header];
  if (!col) throw new Error("Unknown Ledger column: " + args.header);
  const cell = sheet.getRange(row, col);
  if (cell.getFormula() !== "") throw new Error("'" + args.header + "' is formula-derived and can't be edited.");
  cell.setValue(ledger_coerce_(args.value));
  su_invalidateMemo_(SHEET_LEDGER);
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  return { status: "success", row: row, header: args.header };
}

/** Append a ledger row, writing only supplied, non-derived columns. */
function api_appendLedgerRow(obj) {
  obj = obj || {};
  su_lock_();
  const sheet = su_sheet_(SHEET_LEDGER);
  const h = su_headerMap_(sheet);
  const derived = ledger_derivedCols_(sheet);
  const row = sheet.getLastRow() + 1;
  let wrote = 0;
  Object.keys(obj).forEach(function (header) {
    const col = h[header];
    if (!col || derived[col]) return;                       // unknown or formula-driven → skip
    const val = obj[header];
    if (val === undefined || val === null || val === "") return;
    sheet.getRange(row, col).setValue(ledger_coerce_(val));
    wrote++;
  });
  if (!wrote) throw new Error("Nothing to add — fill at least one editable field.");
  su_invalidateMemo_(SHEET_LEDGER);
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  return { status: "success", row: row };
}

/**
 * Delete a ledger row.
 * ponytail: plain deleteRow — fine for a small hand-kept tracker. If the Ledger
 * ever grows a header-anchored ARRAYFORMULA, deleting its anchor row would break
 * the spill; switch to clearing input cells instead if that day comes.
 */
function api_deleteLedgerRow(args) {
  args = args || {};
  const row = parseInt(args.row, 10);
  if (!row || row < 2) throw new Error("deleteLedgerRow requires a valid data row.");
  su_lock_();
  const sheet = su_sheet_(SHEET_LEDGER);
  sheet.deleteRow(row);
  su_invalidateMemo_(SHEET_LEDGER);
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  return { status: "success", row: row };
}
