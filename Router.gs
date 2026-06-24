/**
 * Router.gs — the single doGet/doPost entry points for the web app.
 *
 * Dispatch by `?action=` (GET) or body `action` (POST). When no action is given
 * the legacy behavior is preserved so the existing n8n workflow keeps working:
 *   • GET  with no action  → { Categories, Accounts }  (the /sync payload)
 *   • GET  ?sheets / ?sheet=…  → raw data dumps (Read.gs, behind the read guard)
 *   • POST with no action  → create one transaction from the body (n8n logger)
 *
 * Every handler returns a plain object; the router wraps it in a JSON response.
 * Mutations pass through auth_requireWrite_ (a no-op by default in Phase 1).
 */

// action → handler. READ handlers take (e, body); WRITE handlers take (e, body)
// and are gated by auth_requireWrite_ before they run.
const ROUTES_READ_ = {
  getBootstrap:     function (e, b) { return api_getBootstrap(); },
  listTransactions: function (e, b) { return api_listTransactions(rt_args_(e, b)); },
  getAccounts:      function (e, b) { return api_getAccounts(); },
  getDashboard:     function (e, b) { return api_getDashboard(rt_args_(e, b)); },
  getInvestments:   function (e, b) { return api_getInvestments(); },
  getBudgets:       function (e, b) { return api_getBudgets(rt_args_(e, b)); },
  getRecurring:     function (e, b) { return api_getRecurring(); },
  getCalendar:      function (e, b) { return api_getCalendar(); },
  getLedger:        function (e, b) { return api_getLedger(); }
};
const ROUTES_WRITE_ = {
  createTransaction: function (e, b) { return api_createTransaction(rt_args_(e, b)); },
  createTransfer:    function (e, b) { return api_createTransfer(rt_args_(e, b)); },
  updateTransaction: function (e, b) { return api_updateTransaction(rt_args_(e, b)); },
  deleteTransaction: function (e, b) { return api_deleteTransaction(rt_args_(e, b)); },
  updateAccount:     function (e, b) { return api_updateAccount(rt_args_(e, b)); }
};

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  try {
    const action = params.action;
    if (action) return rt_dispatch_(action, e, null);

    // ── Legacy: raw data dumps (behind read guard) ──
    if (params.sheets !== undefined) { auth_requireRead_(e, null); return jsonResponse(listSheetNames()); }
    if (params.sheet) {
      auth_requireRead_(e, null);
      const limit = params.limit ? parseInt(params.limit, 10) : 0;
      return jsonResponse(readSheetPayload(params.sheet, limit));
    }

    // ── Legacy default: the /sync reference payload ──
    return jsonResponse(rt_legacyBootstrap_());
  } catch (err) {
    return jsonError_(err && err.message ? err.message : err);
  }
}

function doPost(e) {
  let body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonError_("Invalid JSON body: " + err.message);
  }
  try {
    const action = body.action || (e && e.parameter && e.parameter.action);
    if (action) return rt_dispatch_(action, e, body);

    // ── Legacy: a bare transaction body from n8n → create it ──
    auth_requireWrite_(e, body);
    return jsonResponse(api_createTransaction(body));
  } catch (err) {
    return jsonError_(err && err.message ? err.message : err);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
/** Merge query params + JSON body into one args object (body wins). */
function rt_args_(e, body) {
  const args = {};
  if (e && e.parameter) Object.keys(e.parameter).forEach(function (k) { args[k] = e.parameter[k]; });
  if (body) Object.keys(body).forEach(function (k) { args[k] = body[k]; });
  return args;
}

function rt_dispatch_(action, e, body) {
  if (ROUTES_WRITE_[action]) {
    auth_requireWrite_(e, body);
    return jsonResponse(ROUTES_WRITE_[action](e, body));
  }
  if (ROUTES_READ_[action]) {
    return jsonResponse(ROUTES_READ_[action](e, body));
  }
  return jsonError_("Unknown action: " + action, { knownActions:
    Object.keys(ROUTES_READ_).concat(Object.keys(ROUTES_WRITE_)) });
}

/** The original doGet payload: Categories {Type, Description} + Accounts {Currency}. */
function rt_legacyBootstrap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const catData = ss.getSheetByName(SHEET_CATEGORIES).getDataRange().getValues();
  const categories = {};
  for (let i = 1; i < catData.length; i++) {
    const row = catData[i];
    if (!row[0]) continue;
    categories[row[0]] = { Type: row[1] || null, Description: row[3] || null };
  }
  const accData = ss.getSheetByName(SHEET_ACCOUNTS).getDataRange().getValues();
  const accounts = {};
  for (let i = 1; i < accData.length; i++) {
    const row = accData[i];
    if (!row[0]) continue;
    accounts[row[0]] = { Currency: row[1] };
  }
  return { Categories: categories, Accounts: accounts };
}
