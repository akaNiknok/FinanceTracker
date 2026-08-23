/**
 * Backup.gs — the nightly off-Cloudflare backup. The second (and last) file left in
 * Apps Script after v2.0.0.
 *
 * Three layers protect the data, and this is layer 1:
 *   1. THIS — a nightly pull of getExportAll into a dedicated Google Spreadsheet, one
 *      tab per table. Plain values, no formulas: it is a dump, not a live sheet. It
 *      lives in a different company's storage from D1, which is the whole point.
 *   2. the Admin screen's per-table CSV download, for when you want one table now.
 *   3. D1 Time Travel — 7 days of point-in-time restore, free. The oh-no button.
 *
 * Apps Script rather than a Worker cron because the destination is Google Drive and
 * this project already has the OAuth for it; a Worker would need service-account keys
 * to write a spreadsheet, which is a credential to store and renew for no gain.
 *
 * Trigger: time-based, daily (any quiet hour). Install it with backup_install().
 * Script Properties: WORKER_URL and INGEST_TOKEN (shared with Gmail.gs), plus
 * BACKUP_SHEET_ID, which this file writes itself on the first run.
 */

const BACKUP_SHEET_ID_ = "BACKUP_SHEET_ID";
const BACKUP_NAME_ = "FinanceTracker Backup";
const BACKUP_META_TAB_ = "_backup";

/** The trigger entry point. */
function backup_run() {
  try {
    const data = backup_fetch_();
    const ss = backup_book_();
    const names = Object.keys(data.tables);
    names.forEach(function (name) { backup_writeTab_(ss, name, data.tables[name]); });
    backup_writeTab_(ss, BACKUP_META_TAB_, [{
      pulled_at: new Date().toISOString(),
      exported_at: data.exportedAt,
      data_version: data.version,
      tables: names.join(" ")
    }]);
    Logger.log("Backup complete: %s tables into %s", names.length, ss.getUrl());
  } catch (err) {
    Logger.log("backup_run failed: " + err);
    backup_notifyFailure_(err);
  }
}

/** GET the whole database as JSON. Bearer auth — the same token the courier uses. */
function backup_fetch_() {
  const res = UrlFetchApp.fetch(worker_url_("/api?action=getExportAll"), {
    headers: { Authorization: "Bearer " + worker_token_() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200)
    throw new Error("getExportAll HTTP " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
  const json = JSON.parse(res.getContentText());
  if (json.status === "error") throw new Error("getExportAll: " + json.message);
  if (!json.tables) throw new Error("getExportAll returned no tables.");
  return json;
}

/** The backup spreadsheet, created (and remembered) on the first run. */
function backup_book_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(BACKUP_SHEET_ID_);
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (err) { Logger.log("Stored BACKUP_SHEET_ID is unusable (%s) — creating a new book.", err); }
  }
  const ss = SpreadsheetApp.create(BACKUP_NAME_);
  props.setProperty(BACKUP_SHEET_ID_, ss.getId());
  Logger.log("Created the backup spreadsheet: %s", ss.getUrl());
  return ss;
}

/**
 * Rewrite one tab from a table's rows. The header is the union of every row's keys, so
 * a column that is NULL in the first row is not silently dropped. Values are written
 * with setValues in one call — no formulas, no formatting, nothing to keep in step.
 */
function backup_writeTab_(ss, name, rows) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  rows = rows || [];
  if (!rows.length) { sheet.getRange(1, 1).setValue("(empty)"); return; }

  const cols = [];
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) { if (cols.indexOf(k) === -1) cols.push(k); });
  });
  const grid = [cols];
  rows.forEach(function (r) {
    grid.push(cols.map(function (c) {
      const v = r[c];
      if (v === null || v === undefined) return "";
      return (typeof v === "object") ? JSON.stringify(v) : v;
    }));
  });
  // Grow first: a fresh sheet is 1000x26 and a big table would not fit.
  if (sheet.getMaxRows() < grid.length) sheet.insertRowsAfter(sheet.getMaxRows(), grid.length - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols.length - sheet.getMaxColumns());
  sheet.getRange(1, 1, grid.length, cols.length).setValues(grid);
  sheet.setFrozenRows(1);
}

/** A silent backup is worse than no backup. */
function backup_notifyFailure_(err) {
  try {
    const to = Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail(to, "[FinanceTracker] Nightly backup failed", String(err && err.stack || err));
  } catch (mailErr) {
    Logger.log("Could not send the backup failure email: " + mailErr);
  }
}

/** Install the daily trigger. Idempotent — run it from the editor once. */
function backup_install() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "backup_run") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("backup_run").timeBased().atHour(3).everyDays(1).create();
  Logger.log("Daily backup_run trigger installed (~03:00 Asia/Manila).");
}
