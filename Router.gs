/**
 * Router.gs — the single doGet/doPost entry points for the web app.
 *
 * GAS is API-only since v1.6.0: the SPA moved to the Cloudflare Worker, so there
 * is no HtmlService page here any more and nothing calls google.script.run.
 * Everything arrives as `?action=` through the Worker, which holds the token:
 *   • GET  ?action=<read>     → the SPA's screen payloads (ROUTES_READ_)
 *   • POST ?action=<write>    → mutations (ROUTES_WRITE_)
 *   • POST ?action=telegram   → the bot (Telegram.gs)
 * The n8n-era legacy paths (bare-body POST, ?sync, ?sheet= dumps) stay deleted;
 * `git show v1.3.2:Router.gs` has them if an external caller ever needs one back.
 *
 * Handlers return a plain object; the router wraps it in a JSON response.
 * Every request passes auth_requireWrite_ (ENFORCE_TOKEN=true in production) —
 * one gate for reads and writes alike; the name is historical.
 */

// action → handler, each taking the merged query-param/body args object.
const ROUTES_WRITE_ = {
  createTransaction:      api_createTransaction,
  createTransfer:         api_createTransfer,
  updateTransaction:      api_updateTransaction,
  deleteTransaction:      api_deleteTransaction,
  updateAccount:          api_updateAccount,
  bulkUpdateTransactions: api_bulkUpdateTransactions,
  bulkDeleteTransactions: api_bulkDeleteTransactions,
  updateLedgerCell:       api_updateLedgerCell,
  appendLedgerRow:        api_appendLedgerRow,
  deleteLedgerRow:        api_deleteLedgerRow,
  telegram:               tg_webhook_
};

// GET-only, side-effect-free. Names must stay `get*`/`list*` — the SPA's gs()
// picks GET vs POST off that prefix rather than keeping a second list in sync.
const ROUTES_READ_ = {
  getBootstrap:     api_getBootstrap,
  getDashboard:     api_getDashboard,
  getAccounts:      api_getAccounts,
  getBudgets:       api_getBudgets,
  getInvestments:   api_getInvestments,
  getRecurring:     api_getRecurring,
  getLedger:        api_getLedger,
  getCategories:    api_getCategories,
  getDataVersion:   api_getDataVersion,
  listTransactions: api_listTransactions
};

function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : null;
    if (!action) return jsonResponse({ service: "FinanceTracker API", ui: "served by the Cloudflare Worker" });
    const handler = ROUTES_READ_[action];
    // Never mutate over GET — link previewers/scanners prefetch URLs.
    if (!handler) {
      if (ROUTES_WRITE_[action]) return jsonError_("Action '" + action + "' requires POST.");
      return jsonError_("Unknown read action: " + action, { knownActions: Object.keys(ROUTES_READ_) });
    }
    auth_requireWrite_(e, null);
    return jsonResponse(handler(rt_args_(e, null)));
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
    const handler = ROUTES_WRITE_[action];
    if (!handler) return jsonError_("Unknown action: " + action, { knownActions: Object.keys(ROUTES_WRITE_) });
    auth_requireWrite_(e, body);
    return jsonResponse(handler(rt_args_(e, body)));
  } catch (err) {
    return jsonError_(err && err.message ? err.message : err);
  }
}

/** Merge query params + JSON body into one args object (body wins). */
function rt_args_(e, body) {
  const args = {};
  if (e && e.parameter) Object.keys(e.parameter).forEach(function (k) { args[k] = e.parameter[k]; });
  if (body) Object.keys(body).forEach(function (k) { args[k] = body[k]; });
  return args;
}
