/**
 * Dashboard.gs — aggregations for the Dashboard and Investments screens.
 * Built on api_getAccounts (derived balances) + Transactions. Budget targets and
 * the exact Budgets layout are owner-maintained, so budget-vs-actual returns
 * computed actuals alongside the raw Budgets rows for the UI to combine.
 *
 * ⚠ Reuses the same balance assumptions as Accounts.gs — verify with Tests.gs.
 */

function api_getDashboard(args) {
  args = args || {};
  const accountsRes = api_getAccounts();
  const accounts = accountsRes.accounts;

  // Net worth = Σ each account's trusted PHP balance (balancePhp: computed for
  // PHP cash, sheet-stored for FX/shares). Liability accounts compute negative
  // (debt reduces net worth), so we sum straight through; assets = positive,
  // liabilities = negative.
  let netWorth = 0, assets = 0, liabilities = 0, sharesValue = 0;
  const byType = {}, bySubtype = {};
  accounts.forEach(function (a) {
    const php = (a.balancePhp === null || a.balancePhp === undefined) ? 0 : a.balancePhp;
    if (a.computedBalance === null) sharesValue += php; // shares contribution
    const t = a.type || "Unknown", s = a.subtype || "Unknown";
    byType[t] = (byType[t] || 0) + php;
    bySubtype[s] = (bySubtype[s] || 0) + php;
    netWorth += php;
    if (php >= 0) assets += php; else liabilities += php; // liabilities kept negative
  });

  // This-month expenses by Segment.
  const month = args.month ? String(args.month) : dash_currentMonth_();
  const tx = su_readObjects_(SHEET_TX);
  const spendBySegment = {};
  tx.forEach(function (r) {
    if (String(r.Month) !== month) return;
    if (String(r.Type) !== "Expense") return;
    const seg = r.Segment || "Unsegmented";
    spendBySegment[seg] = (spendBySegment[seg] || 0) + Math.abs(acct_num_(r["Amount (PHP)"]));
  });

  const recent = tx.slice(-10).reverse().map(tx_clean_);

  return {
    status: "success",
    month: month,
    netWorth: Math.round(netWorth * 100) / 100,
    assets: Math.round(assets * 100) / 100,
    liabilities: Math.round(liabilities * 100) / 100,
    sharesValue: Math.round(sharesValue * 100) / 100,
    balancesByType: dash_round_(byType),
    balancesBySubtype: dash_round_(bySubtype),
    spendBySegment: dash_round_(spendBySegment),
    budgets: reads_clean_(su_readObjects_(SHEET_BUDGETS)),
    recentTransactions: recent
  };
}

function api_getInvestments() {
  const accounts = api_getAccounts().accounts;
  const positions = accounts.filter(function (a) {
    return String(a.currency).toUpperCase() === "SHARES" ||
           /share|stock|invest|ef/i.test(String(a.subtype || ""));
  }).map(function (a) {
    return {
      name: a.name, subtype: a.subtype, currency: a.currency,
      quantity: a.computedQuantity,
      valuePhp: a.balancePhp
    };
  });
  let total = 0;
  positions.forEach(function (p) { total += (p.valuePhp || 0); });
  positions.forEach(function (p) { p.weightPct = total ? Math.round((p.valuePhp || 0) / total * 1000) / 10 : 0; });
  return {
    status: "success",
    totalValuePhp: Math.round(total * 100) / 100,
    positions: positions,
    // Strategy targets are documented in the advisor project, surfaced here for the UI.
    coreTargets: { "60": "Core", "25": "Growth", "15": "Speculative" },
    segmentTargets: { Needs: 50, Wants: 30, Savings: 20 }
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function dash_currentMonth_() {
  // Must match the Month ARRAYFORMULA's output. The migration produced "2026-Jun"
  // (format yyyy-mmm), so we mirror that here; otherwise the filter matches nothing.
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MMM");
}
function dash_round_(map) {
  const out = {};
  Object.keys(map).forEach(function (k) { out[k] = Math.round(map[k] * 100) / 100; });
  return out;
}
