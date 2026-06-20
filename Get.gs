function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── CATEGORIES ──────────────────────────────────────────────
  const catSheet = ss.getSheetByName("Categories");
  const catData  = catSheet.getDataRange().getValues();
  const catHeaders = catData[0]; // ["Category", "Type", "Segment", "Description"]

  const categories = {};
  for (let i = 1; i < catData.length; i++) {
    const row      = catData[i];
    const category = row[0];
    if (!category) continue;

    categories[category] = {
      Type:        row[1] || null,
      Description: row[3] || null,
    };
  }

  // ── ACCOUNTS ────────────────────────────────────────────────
  const accSheet = ss.getSheetByName("Accounts");
  const accData  = accSheet.getDataRange().getValues();
  const accHeaders = accData[0];

  const accounts = {};
  for (let i = 1; i < accData.length; i++) {
    const row   = accData[i]
    const name  = row[0];
    if (!name) continue;

    accounts[name] = {
      Currency: row[1]
    };
  }

  // ── RESPONSE ────────────────────────────────────────────────
  const payload = {
    Categories: categories,
    Accounts:   accounts,
  };

  return ContentService
    .createTextOutput(JSON.stringify(payload, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}
