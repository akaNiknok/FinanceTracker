/**
 * Router.gs — the single doGet/doPost entry points for the web app.
 *
 * Only two things reach this file from outside:
 *   • a plain browser GET on the deployment URL → the Web App UI (WebApp.gs)
 *   • POST ?action=telegram → the bot (Telegram.gs), via the Cloudflare Worker
 * The SPA does NOT come through here — it calls the api_* functions directly via
 * google.script.run. The read-side `?action=` API and the n8n-era legacy paths
 * (bare-body POST, ?sync, ?sheet= dumps) were removed once n8n was retired;
 * `git show v1.3.2:Router.gs` has them if an external caller ever needs one back.
 *
 * Handlers return a plain object; the router wraps it in a JSON response.
 * Mutations pass through auth_requireWrite_ (ENFORCE_TOKEN=true in production).
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
  telegram:               tg_webhook_
};

function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : null;
    // Never mutate over GET — link previewers/scanners prefetch URLs.
    if (action) return jsonError_("Action '" + action + "' requires POST.");
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
