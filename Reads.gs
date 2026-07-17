/**
 * Reads.gs — simple sheet reads + the one-shot bootstrap hydrate.
 * Budgets / Calendar / Ledger are returned as cleaned row objects; their exact
 * shapes are owner-maintained, so the API forwards rows rather than imposing a
 * schema. getBootstrap bundles everything the UI needs on load.
 */

// api_getBudgets lives in Budgets.gs (it computes actuals, not a raw row dump).
function api_getCalendar()  { return { status: "success", rows: reads_clean_(su_readObjects_(SHEET_CALENDAR)) }; }

/**
 * Ledger for the editable Tax screen: rows keep their 1-based `__row` (so the UI
 * can target a cell), plus `cols` (sheet column order) and `derived` (formula
 * headers the UI renders read-only). Writes live in Ledger.gs.
 */
function api_getLedger() {
  const sheet = su_sheet_(SHEET_LEDGER);
  const headerMap = su_headerMap_(sheet);
  const cols = Object.keys(headerMap);
  const rows = su_readObjects_(SHEET_LEDGER).map(function (r) {
    const c = { __row: r.__row };
    cols.forEach(function (k) { c[k] = su_dateStr_(r[k]); });
    return c;
  });
  return { status: "success", rows: rows, cols: cols, derived: ledger_derivedHeaders_(sheet, headerMap) };
}

/** Recurring bills / installments (reference notes). Empty if the sheet is absent. */
function api_getRecurring() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RECURRING)) return { status: "success", rows: [] };
  return { status: "success", rows: reads_clean_(su_readObjects_(SHEET_RECURRING)) };
}

/** Full categories map (Type, Segment, Description) for the UI/bot. */
function api_getCategories() {
  const map = {};
  su_readObjects_(SHEET_CATEGORIES).forEach(function (r) {
    if (r.Category) map[r.Category] = { Type: r.Type || null, Segment: r.Segment || null, Description: r.Description || null };
  });
  return map;
}

/** Everything needed to hydrate the UI in one call. */
function api_getBootstrap() {
  return {
    status: "success",
    owner: cfgOwnerEmail_(),
    baseCurrency: BASE_CURRENCY,
    categories: api_getCategories(),
    accounts: api_getAccounts().accounts,
    budgets: api_getBudgets().budgets,
    recurring: api_getRecurring().rows,
    calendar: reads_clean_(su_readObjects_(SHEET_CALENDAR)),
    fxUsdPhp: fx_liveRate_("USD", BASE_CURRENCY) || null,
    minMonth: reads_minTxMonth_(),   // oldest ledger month → month pickers reach all history
    version: cache_getVersion_()
  };
}

/** Oldest `Month` in the ledger (yyyy-MMM), or null if empty. Ledger already memoized by getBudgets. */
function reads_minTxMonth_() {
  let min = null;
  su_readObjects_(SHEET_TX).forEach(function (r) {
    const d = r.Date instanceof Date ? r.Date : (r.Date ? new Date(r.Date) : null);
    if (!d || isNaN(d.getTime())) return;
    if (!min || d.getTime() < min.getTime()) min = d;
  });
  return min ? Utilities.formatDate(min, Session.getScriptTimeZone(), "yyyy-MMM") : null;
}

function reads_clean_(rows) {
  return rows.map(function (r) {
    const c = {}; Object.keys(r).forEach(function (k) { if (k !== "__row") c[k] = su_dateStr_(r[k]); }); return c;
  });
}
