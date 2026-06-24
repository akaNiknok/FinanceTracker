/**
 * SheetUtil.gs — low-level sheet helpers shared by the service layer.
 *
 * Key invariant: appendInputRow_ / setInputCells_ write ONLY input columns by
 * header name, leaving the formula-derived columns empty so their ARRAYFORMULAs
 * spill in. This is what replaces the old appendRow (which wrote every column and
 * would now clobber the derivation band). See Config.gs for the column model.
 */

// ── Sheet + header helpers ────────────────────────────────────────────────────
function su_sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("Sheet not found: " + name);
  return sh;
}

/** header text → 1-based column index (first occurrence wins). */
function su_headerMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach(function (name, i) {
    if (name !== "" && map[name] === undefined) map[name] = i + 1;
  });
  return map;
}

/** Whole sheet → array of row objects keyed by header (blank rows skipped). */
function su_readObjects_(name, limit) {
  const sheet = su_sheet_(name);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (raw.every(function (c) { return c === "" || c === null; })) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = raw[j];
    obj.__row = i + 1; // 1-based sheet row, for in-place edits
    out.push(obj);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** Last row that actually holds a transaction, based on a real input column. */
function su_lastDataRow_(sheet, headerMap) {
  const keyCol = headerMap["Date"] || headerMap["ID"] || 1;
  const colVals = sheet.getRange(1, keyCol, sheet.getMaxRows(), 1).getValues();
  for (let r = colVals.length - 1; r >= 1; r--) {
    if (colVals[r][0] !== "" && colVals[r][0] !== null) return r + 1;
  }
  return 1; // header only
}

// ── Input-only writes (protect the formula spill) ─────────────────────────────
/**
 * Write the given {header: value} pairs into `row`, ONLY for headers that are
 * declared input columns. Unknown or derived headers are silently ignored so a
 * stray field can never land in a formula cell.
 */
function su_setInputCells_(sheet, headerMap, row, obj) {
  Object.keys(obj).forEach(function (header) {
    if (TX_INPUT_COLS.indexOf(header) === -1) return;     // not an input column
    const col = headerMap[header];
    if (!col) return;                                     // column absent in sheet
    const val = obj[header];
    if (val === undefined) return;
    sheet.getRange(row, col).setValue(val);
  });
}

/** Append a new transaction row, writing input columns only. Returns the row #. */
function su_appendInputRow_(sheet, headerMap, obj) {
  const row = su_lastDataRow_(sheet, headerMap) + 1;
  su_setInputCells_(sheet, headerMap, row, obj);
  SpreadsheetApp.flush();
  return row;
}

/** Find the 1-based row for a transaction ID, or 0 if not found. */
function su_findRowById_(sheet, headerMap, id) {
  const idCol = headerMap["ID"];
  if (!idCol) throw new Error("Transactions has no 'ID' column — run the migration first.");
  const last = su_lastDataRow_(sheet, headerMap);
  if (last < 2) return 0;
  const ids = sheet.getRange(2, idCol, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

// ── JSON response (canonical; used by Router + Read) ──────────────────────────
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonError_(message, extra) {
  const payload = { status: "error", message: String(message) };
  if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
  return jsonResponse(payload);
}
