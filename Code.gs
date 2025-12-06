function doPost(e) {
  try {
    const SPREADSHEET_NAME = "Transactions";

    // 1. Get the active spreadsheet and sheet
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SPREADSHEET_NAME);

    // 2. Parse the incoming JSON data
    var requestData = JSON.parse(e.postData.contents);

    // 3. Get the current headers from the Sheet (Row 1)
    var lastColumn = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];

    // 4. Create the new row data based on the headers
    // We map through the sheet headers to ensure the order is correct
    var newRow = headers.map(function (headerName) {
      // If the JSON has a matching key, use the value.
      // If not, return an empty string.
      return requestData[headerName] !== undefined
        ? requestData[headerName]
        : "";
    });

    // 5. Append the row to the bottom of the sheet
    sheet.appendRow(newRow);

    // 6. Return a success message
    return ContentService.createTextOutput(
      JSON.stringify({
        status: "success",
        message: "Row added successfully",
      }),
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    // Handle errors
    return ContentService.createTextOutput(
      JSON.stringify({
        status: "error",
        message: error.toString(),
      }),
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
