/**
 * Interest.gs — the scheduled daily-interest job, refactored onto the service
 * layer. Driven by a daily time-based trigger (configured in the GAS UI).
 *
 * Key change vs. the old Code.gs version: it no longer uses appendRow (which
 * wrote every column and would now clobber the ARRAYFORMULA derivation band).
 * It routes through api_createTransaction, which writes input columns only, so
 * Type / Segment / Month / Amount (PHP) auto-derive and each row gets a stable ID.
 */

const WITHHOLDING_TAX_RATE = 0.20;

function addDailyInterestTransactions() {
  try {
    const accounts = su_readObjects_(SHEET_ACCOUNTS);
    const today = new Date();

    accounts.forEach(function (a) {
      if (String(a["Interest Frequency"]) !== "Daily") return;
      // Interest accrues in the account's own currency; the sheet's FX renders
      // the PHP view. Reading the PHP balance would post a PHP-magnitude Amount
      // interpreted as native currency (~61× overstated for a USD account).
      const balance = acct_num_(acct_pick_(a, ACCT_NATIVE_HEADERS));
      const rate = acct_num_(a["Interest Rate"]);
      if (!balance || !rate) return;

      const gross = (balance * rate) / 365;
      let net = gross * (1 - WITHHOLDING_TAX_RATE);
      net = Math.round(net * 100) / 100;
      if (!net) return;

      // Per-account try/catch: one bad account (renamed category, quota) must not
      // abort the rest of the run.
      try {
        api_createTransaction({
          // Deterministic ID → api_createTransaction's idempotency check makes a
          // re-fired trigger a no-op: at most one interest row per account per day.
          ID: "interest-" + a.Name + "-" +
              Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd"),
          Date: today,
          Category: "Income: Interest",
          Account: a.Name,
          Amount: net
        });
        Logger.log("Daily interest for %s: %s (gross %s, tax %s)",
          a.Name, net, gross.toFixed(2), (gross - net).toFixed(2));
      } catch (perAcct) {
        Logger.log("Interest failed for %s: %s", a.Name, perAcct.toString());
        interest_notifyFailure_("Daily interest failed for account " + a.Name, perAcct);
      }
    });
    Logger.log("Daily interest transactions completed.");
  } catch (err) {
    Logger.log("Error in addDailyInterestTransactions: " + err.toString());
    interest_notifyFailure_("Daily interest job aborted", err);
  }
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
