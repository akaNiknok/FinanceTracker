/**
 * Reads.gs — simple sheet reads + the one-shot bootstrap hydrate.
 * Budgets / Calendar / Ledger are returned as cleaned row objects; their exact
 * shapes are owner-maintained, so the API forwards rows rather than imposing a
 * schema. getBootstrap bundles everything the UI needs on load.
 */

function api_getBudgets()  { return { status: "success", rows: reads_clean_(su_readObjects_(SHEET_BUDGETS)) }; }
function api_getCalendar()  { return { status: "success", rows: reads_clean_(su_readObjects_(SHEET_CALENDAR)) }; }
function api_getLedger()   { return { status: "success", rows: reads_clean_(su_readObjects_(SHEET_LEDGER)) }; }

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
    budgets: reads_clean_(su_readObjects_(SHEET_BUDGETS)),
    calendar: reads_clean_(su_readObjects_(SHEET_CALENDAR)),
    fxUsdPhp: fx_liveRate_("USD", BASE_CURRENCY) || null
  };
}

function reads_clean_(rows) {
  return rows.map(function (r) {
    const c = {}; Object.keys(r).forEach(function (k) { if (k !== "__row") c[k] = r[k]; }); return c;
  });
}
