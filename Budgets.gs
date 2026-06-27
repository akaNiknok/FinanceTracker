/**
 * Budgets.gs — segment budget targets vs. computed actuals.
 *
 * The Budgets sheet holds the PLAN only (one row per segment): Segment, Period,
 * Target Type (Percent|Amount), Target, Currency, Notes. Everything else —
 * actual, remaining, % used, roll-ups — is computed HERE from the Transactions
 * ledger, so the sheet never stores a derived/duplicated number and there is no
 * second FX source to drift (the old sheet pinned its own USD→PHP rate).
 *
 * Hybrid targets: Percent rows resolve against MONTHLY_INCOME_PHP (×3 for a
 * Quarterly period); Amount rows convert at the SAME live FX the rest of the app
 * uses (Fx.gs) when Currency=USD, else the number passes through as PHP.
 *
 * Actuals sum Type="Expense" Amount (PHP) by Segment over the period window — the
 * current month, or the calendar quarter when Period="Quarterly". This mirrors
 * Dashboard's spendBySegment so the two screens always agree.
 */

function api_getBudgets(args) {
  args = args || {};
  const incomePhp = cfgMonthlyIncomePhp_();
  // Cache-only (no network) so the Dashboard/Budgets load can't stall on FX;
  // getBootstrap warms the cache live in the background. Falls back if cold.
  const fx = fx_cachedRate_("USD", BASE_CURRENCY) || cfgUsdPhpFallback_() || null;
  const ref = args.month ? bud_parseMonth_(String(args.month)) : new Date();
  const tz = Session.getScriptTimeZone();

  const tx = su_readObjects_(SHEET_TX);
  const budgets = su_readObjects_(SHEET_BUDGETS)
    .filter(function (r) { return r.Segment; })
    .map(function (r) {
      const period = /quarter/i.test(String(r.Period)) ? "Quarterly" : "Monthly";
      const months = bud_periodMonths_(period, ref);
      const targetPhp = bud_resolveTarget_(r, period, incomePhp, fx);
      const actualPhp = bud_actualForSegment_(tx, r.Segment, months);
      return bud_pack_(r, period, targetPhp, actualPhp, months);
    });

  // Convenience roll-up for the two segments actually tracked day to day.
  const essentialsRewards = bud_combine_(budgets, ["Essentials", "Rewards"]);

  return {
    status: "success",
    month: Utilities.formatDate(ref, tz, "yyyy-MMM"),
    incomePhp: incomePhp,
    fxUsdPhp: fx,
    budgets: budgets,
    essentialsRewards: essentialsRewards
  };
}

// ── target resolution ─────────────────────────────────────────────────────────
/** A budget row's target expressed in PHP, or null when it can't be resolved. */
function bud_resolveTarget_(r, period, incomePhp, fx) {
  const type = String(r["Target Type"] || "").toLowerCase();
  const val = acct_num_(r.Target);
  if (type.indexOf("percent") === 0 || type === "%") {
    if (!incomePhp) return null;                       // no planning income set
    const base = (period === "Quarterly") ? incomePhp * 3 : incomePhp;
    return bud_round_(base * val / 100);
  }
  const cur = String(r.Currency || BASE_CURRENCY).toUpperCase();
  if (cur === "USD") return fx ? bud_round_(val * fx) : null; // live FX, single source
  return bud_round_(val);                                      // PHP / base passes through
}

/**
 * Σ |Amount (PHP)| of this segment's OUTFLOW rows within the months set.
 * Counts Type="Expense" (regular spend) AND Type="Transfer" — the latter is how a
 * segment like "Growth" is actually funded (cash → investment account), so an
 * "Investment: Growth" transfer must draw down the Growth budget. Income / other
 * types never count. Segment compared trimmed so a stray trailing space can't drop
 * a row silently.
 */
function bud_actualForSegment_(tx, segment, months) {
  const inWindow = {}; months.forEach(function (m) { inWindow[m] = true; });
  const seg = String(segment).trim();
  let sum = 0;
  tx.forEach(function (r) {
    if (String(r.Segment).trim() !== seg) return;
    const type = String(r.Type);
    if (type !== "Expense" && type !== "Transfer") return;
    if (!inWindow[String(r.Month)]) return;
    sum += Math.abs(acct_num_(r["Amount (PHP)"]));
  });
  return bud_round_(sum);
}

// ── shaping ───────────────────────────────────────────────────────────────────
function bud_pack_(r, period, targetPhp, actualPhp, months) {
  const remaining = (targetPhp === null) ? null : bud_round_(targetPhp - actualPhp);
  const pct = (targetPhp === null || targetPhp === 0) ? null : Math.round(actualPhp / targetPhp * 1000) / 10;
  return {
    segment: r.Segment,
    period: period,
    targetType: r["Target Type"] || null,
    targetValue: acct_num_(r.Target),
    currency: r.Currency || null,
    targetPhp: targetPhp,
    actualPhp: actualPhp,
    remainingPhp: remaining,
    pctUsed: pct,
    isOver: (remaining !== null && remaining < 0),
    window: months,
    notes: r.Notes || null
  };
}

/** Sum a few segments into one figure (e.g. Essentials + Rewards). */
function bud_combine_(budgets, names) {
  const picked = budgets.filter(function (b) { return names.indexOf(b.segment) !== -1; });
  if (!picked.length) return null;
  let target = 0, actual = 0, anyTarget = false;
  picked.forEach(function (b) {
    actual += b.actualPhp || 0;
    if (b.targetPhp !== null) { target += b.targetPhp; anyTarget = true; }
  });
  const targetPhp = anyTarget ? bud_round_(target) : null;
  const actualPhp = bud_round_(actual);
  const remaining = (targetPhp === null) ? null : bud_round_(targetPhp - actualPhp);
  const pct = (targetPhp === null || targetPhp === 0) ? null : Math.round(actualPhp / targetPhp * 1000) / 10;
  return {
    segments: picked.map(function (b) { return b.segment; }),
    targetPhp: targetPhp, actualPhp: actualPhp, remainingPhp: remaining,
    pctUsed: pct, isOver: (remaining !== null && remaining < 0)
  };
}

// ── period / date helpers ──────────────────────────────────────────────────────
/** Month-strings ("yyyy-MMM") covered by the period containing refDate. */
function bud_periodMonths_(period, refDate) {
  const tz = Session.getScriptTimeZone();
  if (period === "Quarterly") {
    const qStart = Math.floor(refDate.getMonth() / 3) * 3; // 0,3,6,9
    const out = [];
    for (let i = 0; i < 3; i++) {
      out.push(Utilities.formatDate(new Date(refDate.getFullYear(), qStart + i, 1), tz, "yyyy-MMM"));
    }
    return out;
  }
  return [Utilities.formatDate(refDate, tz, "yyyy-MMM")];
}

/** Parse "yyyy-MMM" (or "yyyy-MM") to the 1st of that month; falls back to today. */
function bud_parseMonth_(s) {
  const m = /^(\d{4})-(\d{1,2}|[A-Za-z]{3,})$/.exec(String(s).trim());
  if (!m) return new Date();
  const year = parseInt(m[1], 10);
  const idx = isNaN(parseInt(m[2], 10))
    ? ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[2].slice(0, 3).toLowerCase())
    : parseInt(m[2], 10) - 1;
  return (idx >= 0) ? new Date(year, idx, 1) : new Date();
}

function bud_round_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
