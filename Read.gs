/**
 * Read.gs — data-pull helpers for testing.
 *
 * The connected Google Sheet is only reachable programmatically through the
 * Web App, so these helpers let a test/client dump raw sheet rows as JSON.
 * Wired into doGet (Get.gs) via query params; default doGet behavior is
 * unchanged. Examples (append to the deployment URL):
 *   ?sheet=Transactions      → { sheet, headers, rows:[{header:value,...}] }
 *   ?sheet=Accounts&limit=5  → first 5 data rows only
 *   ?sheet=all               → { SheetName: [rows...], ... } for every sheet
 *   ?sheets                  → { sheets:[names...] } — list sheet names only
 */

/**
 * Read one sheet into { sheet, headers, rows } where each row is an object
 * keyed by header name. Fully-empty rows are skipped. Returns null if the
 * sheet does not exist.
 */
function getSheetData(sheetName, limit) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;

  var values = sheet.getDataRange().getValues();
  if (values.length === 0) return { sheet: sheetName, headers: [], rows: [] };

  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var raw = values[i];
    // Skip rows where every cell is blank.
    var allBlank = raw.every(function (cell) {
      return cell === "" || cell === null;
    });
    if (allBlank) continue;

    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = raw[j];
    }
    rows.push(obj);

    if (limit && rows.length >= limit) break;
  }
  return { sheet: sheetName, headers: headers, rows: rows };
}

/**
 * Build the response payload for a sheet-read request.
 * `sheetName === "all"` dumps every sheet keyed by name.
 */
function readSheetPayload(sheetName, limit) {
  if (sheetName === "all") {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var all = {};
    ss.getSheets().forEach(function (sh) {
      all[sh.getName()] = getSheetData(sh.getName(), limit).rows;
    });
    return all;
  }

  var data = getSheetData(sheetName, limit);
  if (!data) {
    return { status: "error", message: "Sheet not found: " + sheetName };
  }
  return data;
}

/** List the names of all sheets in the workbook. */
function listSheetNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    sheets: ss.getSheets().map(function (sh) {
      return sh.getName();
    }),
  };
}

/**
 * Convenience runner for the Apps Script editor (no web request needed):
 * select this function, Run, then check Logs to see the data.
 */
function testPullData() {
  Logger.log(JSON.stringify(listSheetNames(), null, 2));
  Logger.log(JSON.stringify(readSheetPayload("Transactions", 10), null, 2));
}
