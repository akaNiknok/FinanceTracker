/**
 * Interest.gs — the scheduled daily-interest job, refactored onto the service
 * layer. Driven by a daily time-based trigger (configured in the GAS UI).
 *
 * It never uses appendRow (which wrote every column and would clobber the
 * ARRAYFORMULA derivation band); it routes through api_createTransaction, which
 * writes input columns only, so Type / Segment / Month / Amount (PHP) auto-derive.
 *
 * Accuracy model: interest for day D is credited on D's CLOSING balance recomputed
 * from the ledger (`acct_computeDeltas_(D)`), not on the account's live balance at
 * trigger time. Two consequences, both deliberate:
 *   • Only CLOSED days are credited (today is skipped) — a transaction you log in
 *     the evening still lands before its day is priced.
 *   • Every run re-prices the last INTEREST_LOOKBACK_DAYS days and repairs the row
 *     if the figure moved, so a transaction logged a day late (or backdated) fixes
 *     yesterday's interest instead of leaving it permanently wrong.
 */

const WITHHOLDING_TAX_RATE = 0.20;
// Repair window. Wider = more late/backdated entries caught, more ledger passes.
// Manual backfill after a longer outage: run addDailyInterestTransactions(60).
const INTEREST_LOOKBACK_DAYS = 7;

function addDailyInterestTransactions(lookbackDays) {
  try {
    const tz = Session.getScriptTimeZone();
    const days = Math.max(1, parseInt(lookbackDays, 10) || INTEREST_LOOKBACK_DAYS);

    const accounts = su_readObjects_(SHEET_ACCOUNTS).filter(function (a) {
      return String(a["Interest Frequency"]) === "Daily" && acct_num_(a["Interest Rate"]);
    });
    if (!accounts.length) { Logger.log("No daily-interest accounts — nothing to do."); return; }

    // What we've already credited, by deterministic ID → tells create from repair.
    const posted = {};
    su_readObjects_(SHEET_TX).forEach(function (r) {
      if (String(r.ID).indexOf("interest-") === 0) posted[String(r.ID)] = acct_num_(r.Amount);
    });

    // Oldest → newest so a repaired older day compounds into the next day's balance.
    for (let back = days; back >= 1; back--) {
      const d = new Date();
      d.setDate(d.getDate() - back);
      const day = Utilities.formatDate(d, tz, "yyyy-MM-dd");
      // ponytail: one full ledger pass per day in the window. Writes invalidate the
      // read memo anyway (which is what makes compounding come out right), so this
      // is ~2×days sheet reads. Bucket deltas by day if the ledger gets big.
      const deltas = acct_computeDeltas_(day);

      accounts.forEach(function (a) {
        const id = "interest-" + a.Name + "-" + day;
        const prior = posted[id] || 0;
        // Closing balance for that day, net of interest we already credited ON that
        // day — otherwise each repair would compound on its own previous output.
        const balance = acct_num_(acct_pick_(a, ACCT_START_HEADERS)) +
                        (deltas[a.Name] ? deltas[a.Name].net : 0) - prior;
        const net = interest_net_(balance, acct_num_(a["Interest Rate"]));
        if (Math.abs(net - prior) < 0.005) return;   // already correct (incl. both zero)

        // Per-account try/catch: one bad account (renamed category, quota) must not
        // abort the rest of the run.
        try {
          if (!prior) {
            api_createTransaction({ ID: id, Date: day, Category: "Income: Interest",
                                    Account: a.Name, Amount: net });
          } else if (net) {
            api_updateTransaction({ ID: id, Amount: net });
          } else {
            api_deleteTransaction({ ID: id });       // balance went to zero → row is wrong
          }
          posted[id] = net;
          Logger.log("%s %s: %s (was %s, closing balance %s)", day, a.Name, net, prior, balance.toFixed(2));
        } catch (perAcct) {
          Logger.log("Interest failed for %s on %s: %s", a.Name, day, perAcct.toString());
          interest_notifyFailure_("Daily interest failed for " + a.Name + " on " + day, perAcct);
        }
      });
    }
    Logger.log("Daily interest complete (%s-day window).", days);
  } catch (err) {
    Logger.log("Error in addDailyInterestTransactions: " + err.toString());
    interest_notifyFailure_("Daily interest job aborted", err);
  }
}

/** Net interest credited on a day's closing balance: gross ÷365 less withholding, 2dp. */
function interest_net_(balance, rate) {
  return Math.round((balance * rate / 365) * (1 - WITHHOLDING_TAX_RATE) * 100) / 100;
}

/** Best-effort owner alert so a broken interest job doesn't fail silently. */
function interest_notifyFailure_(subject, err) {
  try {
    const to = cfgOwnerEmail_();
    if (to) MailApp.sendEmail(to, "[FinanceTracker] " + subject, String(err && err.stack || err));
  } catch (mailErr) {
    Logger.log("Could not send interest failure email: " + mailErr.toString());
  }
}
