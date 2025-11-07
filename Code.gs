/**
 * Handles HTTP POST requests dynamically.
 * Reads the header row to map incoming data and inserts the "Amount PHP" formula.
 *
 * @param {Object} e The event parameter object. Contains information about the request.
 * @return {GoogleAppsScript.Content.TextOutput} A TextOutput object with a success or failure message.
 */
function doPost(e) {
  if (!e.postData) {
    return ContentService.createTextOutput("Error: No data in POST request.").setMimeType(ContentService.MimeType.TEXT);
  }

  try {
    const requestData = JSON.parse(e.postData.contents);
    processTransaction(requestData);
    
    return ContentService.createTextOutput("Success: Transaction logged and formula inserted.").setMimeType(ContentService.MimeType.TEXT);

  } catch (error) {
    Logger.log("Error processing doPost: " + error.toString());
    return ContentService.createTextOutput("Error processing request: " + error.toString()).setMimeType(ContentService.MimeType.TEXT);
  }
}

// --- Core Logic ---

/**
 * Processes the transaction data, maps it to the sheet's column order,
 * writes the data, and inserts the currency conversion formula.
 * * @param {Object} requestData The parsed JSON payload from the POST request.
 */
function processTransaction(requestData) {
  const SPREADSHEET_NAME = "Transactions";
  
  // Define expected keys from the incoming JSON payload (case-sensitive)
  const REQUIRED_INPUT_FIELDS = ["Date", "Description", "Currency", "Amount", "Type", "Segment", "Account"];
  const OPTIONAL_INPUT_FIELDS = ["To", "Notes"];

  // Define the formula to be inserted into the 'Amount PHP' column
  const AMOUNT_PHP_FORMULA = 
    '=IF(INDIRECT("C"&ROW())="PHP",' +
    'INDIRECT("D"&ROW()),' +
    'INDIRECT("D"&ROW())*LOOKUP(INDIRECT("A"&ROW()),Exchange_Rates[Date],Exchange_Rates[USD to PHP]))';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SPREADSHEET_NAME);

  if (!sheet) {
    throw new Error(`'${SPREADSHEET_NAME}' sheet not found.`);
  }

  const headers = getHeaders(sheet);
  let amountPhpColumnIndex = -1; // To store the 1-based index of the formula column
  let newRowData = []; // To store the values in the sheet's column order

  // Build the new row data array and find the formula column index
  headers.forEach((header, index) => {
    const normalizedHeader = header.trim();
    
    if (normalizedHeader === "Amount PHP") {
      // This is the formula column. Record its index and push an empty placeholder.
      amountPhpColumnIndex = index + 1; 
      newRowData.push(""); 
    } 
    else if (REQUIRED_INPUT_FIELDS.includes(normalizedHeader) || OPTIONAL_INPUT_FIELDS.includes(normalizedHeader)) {
      // This is an expected data column.
      const value = requestData[normalizedHeader];
      
      // Handle optional fields not being present
      if (value === undefined && OPTIONAL_INPUT_FIELDS.includes(normalizedHeader)) {
         newRowData.push("");
      } 
      // Handle required/provided fields
      else if (value !== undefined) {
         newRowData.push(value);
      } 
      // Handle required fields missing (push empty string as a fallback)
      else {
         newRowData.push("");
         Logger.log(`Warning: Required field "${normalizedHeader}" missing in payload.`);
      }
    } 
    else {
      // Column is present in the sheet but not expected in the payload (e.g., extra column).
      newRowData.push("");
    }
  });
  
  // Perform the write operation
  const nextRow = sheet.getLastRow() + 1;

  // 1. Write all the transaction data (values) to the new row
  const dataRange = sheet.getRange(nextRow, 1, 1, newRowData.length);
  dataRange.setValues([newRowData]);
  
  // 2. Insert the formula into the correct cell
  if (amountPhpColumnIndex !== -1) {
    sheet.getRange(nextRow, amountPhpColumnIndex).setFormula(AMOUNT_PHP_FORMULA);
  } else {
    Logger.log("Warning: 'Amount PHP' column not found in headers. Formula not inserted.");
  }
}

// --- Utility Functions ---

/**
 * Retrieves the headers from the first row of the given sheet.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet The target sheet object.
 * @return {string[]} An array of header names.
 */
function getHeaders(sheet) {
  // Get the first row, from column A (1) to the last used column
  const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  // Returns the first element of the 2D array: [ ["Date", "Description", ...] ] -> ["Date", "Description", ...]
  return headerRange.getValues()[0];
}