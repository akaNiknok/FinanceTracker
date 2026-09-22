/**
 * Backup.gs — the nightly off-Cloudflare backup. The second (and last) file left in
 * Apps Script after v2.0.0.
 *
 * Three layers protect the data, and this is layer 1:
 *   1. THIS — a nightly pull of getExportAll into ONE JSON file on Google Drive,
 *      overwritten each night. It lives in a different company's storage from D1,
 *      which is the whole point.
 *   2. the Admin screen's per-table CSV download, for when you want one table to read.
 *   3. D1 Time Travel — 7 days of point-in-time restore, free. The oh-no button.
 *
 * JSON AND NOT A SPREADSHEET (v3.2.0). This used to write one tab per table with
 * setValues, which took about 45 lines to build a header from the union of every row's
 * keys and to grow the sheet past its default 1000x26. Worse, setValues COERCES: a
 * string of digits came back a number and a leading zero was gone, so the dump did not
 * reload into D1 — the one job a backup has. JSON.stringify keeps the exact bytes the
 * API sent. Drive keeps its own revision history for the file, so an overwrite does not
 * destroy last night's copy the way rewriting the sheet did.
 *
 * Apps Script rather than a Worker cron because the destination is Google Drive and
 * this project already has the OAuth for it; a Worker would need service-account keys,
 * which is a credential to store and renew for no gain.
 *
 * Trigger: time-based, daily (any quiet hour). Install it with backup_install().
 * Script Properties: WORKER_URL and INGEST_TOKEN (shared with Gmail.gs), plus
 * BACKUP_FILE_ID, which this file writes itself on the first run. The old
 * BACKUP_SHEET_ID property and its spreadsheet are dead — delete both by hand.
 */

const BACKUP_FILE_ID_ = "BACKUP_FILE_ID";
const BACKUP_NAME_ = "FinanceTracker Backup.json";

/** The trigger entry point. */
function backup_run() {
  try {
    const data = backup_fetch_();
    const names = Object.keys(data.tables);
    data.pulledAt = new Date().toISOString();
    const file = backup_file_(JSON.stringify(data));
    Logger.log("Backup complete: %s tables into %s", names.length, file.getUrl());
  } catch (err) {
    Logger.log("backup_run failed: " + err);
    backup_notifyFailure_(err);
    // Rethrown, so the run is marked Failed and the trigger's own failure notification
    // fires. Swallowed, every run read "Completed" — a dead backup looked healthy, and
    // the email above cannot be relied on when the fault is the script's authorisation.
    throw err;
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

/** The backup file, created (and remembered) on the first run, overwritten after it. */
function backup_file_(content) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(BACKUP_FILE_ID_);
  if (id) {
    try { return DriveApp.getFileById(id).setContent(content); }
    catch (err) { Logger.log("Stored BACKUP_FILE_ID is unusable (%s) — creating a new file.", err); }
  }
  const file = DriveApp.createFile(BACKUP_NAME_, content, MimeType.PLAIN_TEXT);
  props.setProperty(BACKUP_FILE_ID_, file.getId());
  Logger.log("Created the backup file: %s", file.getUrl());
  return file;
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
