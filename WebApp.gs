/**
 * WebApp.gs — serves the responsive Web App UI (Phase 2).
 *
 * Router.doGet calls ui_serveApp_() when the request carries no ?action / ?sheet /
 * ?sync — i.e. a plain browser hit on the deployment URL. The page is a single
 * vanilla-JS SPA (no framework — GAS has no bundler) that talks to the Phase 1
 * service layer DIRECTLY via google.script.run, so it needs no token or fetch URL
 * (calls execute as the deploying owner). Reads: api_getBootstrap/getDashboard/
 * listTransactions/getAccounts/getBudgets/getInvestments/getLedger. Writes:
 * api_createTransaction/createTransfer/updateTransaction/deleteTransaction/
 * updateAccount. The HTML/CSS/JS live in Index.html, Stylesheet.html, App.html and
 * are stitched together with the include() templating helper below.
 */

function ui_serveApp_() {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("FinanceTracker")
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Inline another .html file's contents (used for <?!= include('Stylesheet') ?>). */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
