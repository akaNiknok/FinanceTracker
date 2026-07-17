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
  updateAccount:     function (e, b) { return api_updateAccount(rt_args_(e, b)); },
  bulkUpdateTransactions: function (e, b) { return api_bulkUpdateTransactions(rt_args_(e, b)); },
  bulkDeleteTransactions: function (e, b) { return api_bulkDeleteTransactions(rt_args_(e, b)); }
};

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  try {
    const action = params.action;
    if (action) {
      // Never mutate over GET — link previewers/scanners prefetch URLs.
      if (ROUTES_WRITE_[action]) return jsonError_("Action '" + action + "' requires POST.");
      return rt_dispatch_(action, e, null);
    }

    // ── Legacy: raw data dumps (behind read guard) ──
    if (params.sheets !== undefined) { auth_requireRead_(e, null); return jsonResponse(listSheetNames()); }
    if (params.sheet) {
      auth_requireRead_(e, null);
      const limit = params.limit ? parseInt(params.limit, 10) : 0;
      return jsonResponse(readSheetPayload(params.sheet, limit));
    }

    // ── Legacy /sync reference payload (kept behind an explicit ?sync flag) ──
    // n8n no longer GETs this (its /sync reads come straight from Sheets nodes),
    // but anything that relied on the bare-GET JSON can still reach it via ?sync.
    if (params.sync !== undefined) { auth_requireRead_(e, null); return jsonResponse(rt_legacyBootstrap_()); }

    // ── Default: serve the responsive Web App UI (Phase 2). ──
    return ui_serveApp_();
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
    auth_requireRead_(e, body);
    return jsonResponse(ROUTES_READ_[action](e, body));
  }
  return jsonError_("Unknown action: " + action, { knownActions:
    Object.keys(ROUTES_READ_).concat(Object.keys(ROUTES_WRITE_)) });
}

/** The original doGet payload: Categories {Type, Description} + Accounts {Currency}. */
function rt_legacyBootstrap_() {
  const categories = {};
  su_readObjects_(SHEET_CATEGORIES).forEach(function (r) {
    if (r.Category) categories[r.Category] = { Type: r.Type || null, Description: r.Description || null };
  });
  const accounts = {};
  su_readObjects_(SHEET_ACCOUNTS).forEach(function (r) {
    if (r.Name) accounts[r.Name] = { Currency: r.Currency };
  });
  return { Categories: categories, Accounts: accounts };
}
