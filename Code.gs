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

function addDailyInterestTransactions() {
  try {
    const ACCOUNTS_SHEET_NAME = "Accounts";
    const TRANSACTIONS_SHEET_NAME = "Transactions";
    const WITHHOLDING_TAX_RATE = 0.20;

    // Get the spreadsheet and both sheets
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var accountsSheet = ss.getSheetByName(ACCOUNTS_SHEET_NAME);
    var transactionsSheet = ss.getSheetByName(TRANSACTIONS_SHEET_NAME);

    if (!accountsSheet || !transactionsSheet) {
      throw new Error("Required sheets not found");
    }

    // Get accounts data
    var accountsData = accountsSheet.getDataRange().getValues();
    var accountsHeaders = accountsData[0];

    // Find column indices in Accounts sheet
    var accountNameCol = accountsHeaders.indexOf("Name");
    var interestFreqCol = accountsHeaders.indexOf("Interest Frequency");
    var balanceCol = accountsHeaders.indexOf("Current Balance (PHP)");
    var interestRateCol = accountsHeaders.indexOf("Interest Rate");

    if (accountNameCol === -1 || interestFreqCol === -1 ||
        balanceCol === -1 || interestRateCol === -1) {
      throw new Error("Required columns not found in Accounts sheet");
    }

    // Get transactions headers
    var transactionsLastCol = transactionsSheet.getLastColumn();
    var transactionsHeaders = transactionsSheet.getRange(1, 1, 1, transactionsLastCol).getValues()[0];

    // Get today's date in the required format (e.g., "28-Jan-2026")
    var today = new Date();
    var dateStr = Utilities.formatDate(today, Session.getScriptTimeZone(), "dd-MMM-yyyy");

    // Loop through accounts (skip header row)
    for (var i = 1; i < accountsData.length; i++) {
      var row = accountsData[i];
      var interestFrequency = row[interestFreqCol];

      // Check if this account has "Daily" interest frequency
      if (interestFrequency === "Daily") {
        var accountName = row[accountNameCol];
        var balance = row[balanceCol];
        var interestRate = row[interestRateCol];

        // Calculate gross daily interest
        var grossDailyInterest = (balance * interestRate) / 365;

        // Apply withholding tax to get net interest
        var netDailyInterest = grossDailyInterest * (1 - WITHHOLDING_TAX_RATE);

        // Round to 2 decimal places
        netDailyInterest = Math.round(netDailyInterest * 100) / 100;

        // Create transaction object
        var transaction = {
          "Date": dateStr,
          "Category": "Income: Interest",
          "Account": accountName,
          "Amount": netDailyInterest
        };

        // Create new row based on transactions headers
        var newRow = transactionsHeaders.map(function(headerName) {
          return transaction[headerName] !== undefined ? transaction[headerName] : "";
        });

        // Append the row
        transactionsSheet.appendRow(newRow);

        Logger.log("Added daily interest for " + accountName + ": PHP " + netDailyInterest + " (gross: " + grossDailyInterest.toFixed(2) + ", tax: " + (grossDailyInterest - netDailyInterest).toFixed(2) + ")");
      }
    }

    Logger.log("Daily interest transactions completed successfully");

  } catch (error) {
    Logger.log("Error in addDailyInterestTransactions: " + error.toString());
    // Optional: Send yourself an email notification on error
    // MailApp.sendEmail(Session.getActiveUser().getEmail(),
    //   "Daily Interest Script Error", error.toString());
  }
}
