/**
 * Export.gs — THE ONE-SHOT SHEETS EXPORTER FOR THE v2.0.0 MIGRATION. Throwaway.
 *
 * HOW TO RUN IT (and why not with clasp):
 *   Paste this file into the LIVE Apps Script project through the editor — File ▸ New ▸
 *   Script — and run exportAllSheets(). Do NOT `clasp push` to get it there: the v2
 *   push deletes Router/Transactions/Accounts/… and takes the running app down with
 *   them, and the export has to happen while v1 is still up (the frozen balances it
 *   captures are the acceptance numbers for the import).
 *
 *   It is deliberately SELF-CONTAINED — it calls nothing but SpreadsheetApp/DriveApp,
 *   so it works whether the other v1 files are present or not.
 *
 * WHAT IT PRODUCES: one JSON file in Drive, `financetracker-export-<timestamp>.json`:
 *   { exportedAt, timeZone, sheets: { <SheetName>: { headers, rows } },
 *     accountFormulas: { <Account name>: { "Current Balance": "=…", … } } }
 *
 *   * every sheet is dumped in full, derived columns included — the derived values are
 *     what migrate/verify.js reconciles the imported database against;
 *   * Date cells are formatted yyyy-MM-dd in the script timezone, never JSON.stringify'd
 *     (that would emit UTC and Manila is UTC+8, so midnight would move to the day before);
 *   * the Accounts sheet's FORMULAS come along too, because each Shares account's ticker
 *     only exists inside its GOOGLEFINANCE() call and has nowhere else to be read from.
 *
 * Then: download the file, and run `node migrate/import.js <that file> > seed.sql`.
 * Delete this file from the Apps Script project once the cutover is verified.
 */

const EXPORT_SHEETS_ = ["Transactions", "Accounts", "AccountType", "Categories",
                        "Budgets", "Recurring", "Ledger"];

function exportAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const out = { exportedAt: new Date().toISOString(), timeZone: tz, sheets: {}, accountFormulas: {} };

  EXPORT_SHEETS_.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) { Logger.log("SKIP: no sheet named %s", name); return; }
    const values = sh.getDataRange().getValues();
    if (!values.length) { out.sheets[name] = { headers: [], rows: [] }; return; }
    const headers = values[0].map(String);
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const raw = values[i];
      if (raw.every(function (c) { return c === "" || c === null; })) continue;
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        if (headers[j] === "") continue;
        obj[headers[j]] = exp_cell_(raw[j], tz);
      }
      rows.push(obj);
    }
    out.sheets[name] = { headers: headers, rows: rows };
    Logger.log("%s: %s rows", name, rows.length);
  });

  // A Shares account's ticker lives only inside its balance formula, e.g.
  // =...GOOGLEFINANCE("NASDAQ:VOO")... — migrate/import.js pulls accounts.symbol out
  // of these strings. Dump the whole formula row so nothing is guessed at here.
  const acc = ss.getSheetByName("Accounts");
  if (acc) {
    const f = acc.getDataRange().getFormulas();
    const headers = acc.getDataRange().getValues()[0].map(String);
    const nameCol = headers.indexOf("Name");
    for (let i = 1; i < f.length; i++) {
      const rowName = acc.getDataRange().getValues()[i][nameCol];
      if (!rowName) continue;
      const cells = {};
      headers.forEach(function (h, j) { if (h && f[i][j]) cells[h] = f[i][j]; });
      if (Object.keys(cells).length) out.accountFormulas[rowName] = cells;
    }
  }

  const file = DriveApp.createFile(
    "financetracker-export-" + Utilities.formatDate(new Date(), tz, "yyyyMMdd-HHmmss") + ".json",
    JSON.stringify(out, null, 1), "application/json");
  Logger.log("EXPORT WRITTEN → %s", file.getUrl());
  Logger.log("Download it, then: node migrate/import.js <file> > seed.sql");
  return file.getUrl();
}

/** Dates become yyyy-MM-dd in the script timezone; everything else passes through. */
function exp_cell_(v, tz) {
  return (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : v;
}

/**
 * The frozen acceptance numbers, printed for the log so they are also in the execution
 * transcript and not only inside the JSON. Run it right before the export.
 */
function exportBalanceSnapshot() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Accounts");
  const values = sh.getDataRange().getValues();
  const h = values[0].map(String);
  const col = function (n) { return h.indexOf(n); };
  Logger.log("Name | Current Balance | Current Balance (PHP)");
  for (let i = 1; i < values.length; i++) {
    if (!values[i][col("Name")]) continue;
    Logger.log("%s | %s | %s", values[i][col("Name")],
      values[i][col("Current Balance")], values[i][col("Current Balance (PHP)")]);
  }
}
