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

  // Net worth uses each account's signed PHP balance (netWorthPhp: assets +,
  // liabilities −). Balances come straight from the sheet's formula columns.
  let netWorth = 0, assets = 0, liabilities = 0, sharesValue = 0;
  const byType = {}, bySubtype = {};
  accounts.forEach(function (a) {
    const php = (a.netWorthPhp === null || a.netWorthPhp === undefined) ? 0 : a.netWorthPhp;
    if (a.isInvestment) sharesValue += (a.balancePhp || 0); // invested contribution (always asset)
    const t = a.type || "Unknown", s = a.subtype || "Unknown";
    byType[t] = (byType[t] || 0) + php;
    bySubtype[s] = (bySubtype[s] || 0) + php;
    netWorth += php;
    if (a.isLiability) liabilities += php; else assets += php; // liabilities are negative
  });

  // This-month expenses by Segment + trailing-6-month cash flow (income vs
  // expense per month, ending at the requested month) in the same pass.
  const month = args.month ? String(args.month) : dash_currentMonth_();
  const tz = Session.getScriptTimeZone();
  const ref = bud_parseMonth_(month);
  const flowByMonth = {}, flowMonths = [];
  for (let i = 5; i >= 0; i--) {
    const k = Utilities.formatDate(new Date(ref.getFullYear(), ref.getMonth() - i, 1), tz, "yyyy-MMM");
    flowMonths.push(k);
    flowByMonth[k] = { income: 0, expense: 0 };
  }
  const tx = su_readObjects_(SHEET_TX);
  const spendBySegment = {};
  tx.forEach(function (r) {
    const m = String(r.Month), type = String(r.Type);
    const f = flowByMonth[m];
    if (f) {
      const php = Math.abs(acct_num_(r["Amount (PHP)"]));
      if (type === "Income") f.income += php;
      else if (type === "Expense") f.expense += php;
    }
    if (m !== month || type !== "Expense") return;
    const seg = r.Segment || "Unsegmented";
    spendBySegment[seg] = (spendBySegment[seg] || 0) + Math.abs(acct_num_(r["Amount (PHP)"]));
  });
  const cashflow = flowMonths.map(function (k) {
    return { month: k,
             income: Math.round(flowByMonth[k].income * 100) / 100,
             expense: Math.round(flowByMonth[k].expense * 100) / 100 };
  });

  const recent = tx.slice().sort(tx_byDateDesc_).slice(0, 10).map(tx_clean_);

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
    cashflow: cashflow,
    budgets: api_getBudgets({ month: month }).budgets, // targets + computed actuals, period-aware
    recentTransactions: recent
  };
}

function api_getInvestments() {
  const accounts = api_getAccounts().accounts;
  const positions = accounts.filter(function (a) {
    return a.isInvestment;
  }).map(function (a) {
    return {
      name: a.name, subtype: a.subtype, currency: a.currency,
      quantity: a.isShares ? a.balanceNative : null, // native = share quantity for Shares accts
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
