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
      const balance = acct_num_(acct_pick_(a, ACCT_STORED_HEADERS));
      const rate = acct_num_(a["Interest Rate"]);
      if (!balance || !rate) return;

      const gross = (balance * rate) / 365;
      let net = gross * (1 - WITHHOLDING_TAX_RATE);
      net = Math.round(net * 100) / 100;
      if (!net) return;

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
      Logger.log("Daily interest for %s: PHP %s (gross %s, tax %s)",
        a.Name, net, gross.toFixed(2), (gross - net).toFixed(2));
    });
    Logger.log("Daily interest transactions completed.");
  } catch (err) {
    Logger.log("Error in addDailyInterestTransactions: " + err.toString());
  }
}
