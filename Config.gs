/**
 * Config.gs — single source of truth for sheet names, the Transactions column
 * model (which columns the service may WRITE vs. which are formula-derived and
 * must never be touched), and settings read from Script Properties.
 *
 * Flat namespace: every function name here is unique across all .gs files.
 */

// ── Sheet names ───────────────────────────────────────────────────────────────
const SHEET_TX        = "Transactions";
const SHEET_ACCOUNTS  = "Accounts";
const SHEET_CATEGORIES = "Categories";
const SHEET_BUDGETS   = "Budgets";
const SHEET_RECURRING = "Recurring";
const SHEET_LEDGER    = "Ledger";

// ── Transactions column model ────────────────────────────────────────────────
// INPUT columns: the only cells the service layer is allowed to write. Anything
// not listed here (Month, Type, Segment, Currency, Amount (PHP), ToCurrency, the
// "." index) is a header-anchored ARRAYFORMULA created by the migration — writing
// into those cells #REF!s the spill, so we NEVER set them.
// "Period" is the reporting-month override: blank (the normal case) means Month
// derives from Date; set it to a "yyyy-MMM" key and Month uses that instead, so a
// salary paid Jul 31 can report under August without lying about the cash date
// (balances + daily interest still key off Date). See Migration.setupTxPeriod.
const TX_INPUT_COLS = [
  "ID", "Date", "Period", "Category", "Description", "Account", "Amount",
  "ExchangeRate", "ToAccount", "ToAmount"
];

// Fields a client is allowed to supply when creating/updating a transaction.
// (ID is assigned server-side; derived fields are ignored if sent.)
const TX_CLIENT_FIELDS = [
  "Date", "Period", "Category", "Description", "Account", "Amount",
  "ExchangeRate", "ToAccount", "ToAmount"
];

const BASE_CURRENCY = "PHP";

// ── Ledger (BIR 8% tracker / Tax screen) ─────────────────────────────────────
// A Ledger row REFERENCES a transaction instead of duplicating it: everything
// derivable (date, gross, currency, PHP amount, 8% liability) is a per-row sheet
// formula keyed off this column, so the only typed cells left are BSP Rate /
// Filed? / Notes. See Migration.setupLedgerSchema.
const LEDGER_TXID_HEADER = "Transaction ID";
const LEDGER_TX_CATEGORY = "Income: Salary"; // the only category the Tax screen offers to link

// ── Settings (Script Properties, with safe fallbacks) ─────────────────────────
// Set these in the Apps Script editor: Project Settings → Script Properties.
//   OWNER_EMAIL       — Google account allowed to use the authenticated UI.
//   API_TOKEN         — shared secret the `?action=` API requires for mutations.
//   ENFORCE_TOKEN     — "true" to require API_TOKEN on writes (LIVE since
//                       2026-07-29; the token rides in the Worker's GAS_URL secret).
//   USD_PHP_FALLBACK  — exchange rate used if the live FX fetch fails.
//   MONTHLY_INCOME_PHP — planning base for percent-of-income budget targets.
//   TELEGRAM_BOT_TOKEN — BotFather token for the private bot (Telegram.gs).
//   TELEGRAM_USER_ID  — the only Telegram user id the bot answers.
//   GEMINI_API_KEY    — Google AI Studio key used to parse bot messages.
//   WEB_APP_URL       — the /exec deployment URL; used only by tg_gasEndpoint.
//   WEBHOOK_URL       — the Cloudflare Worker URL Telegram delivers to (worker/).
//   TELEGRAM_SECRET_TOKEN — optional shared secret the Worker checks on each
//                       delivery; must match the Worker's SECRET_TOKEN.
//   GMAIL_QUERY       — Gmail search selecting transaction notification mail
//                       (Gmail.gs `gmail_ingest`); required by that job only.
//   GMAIL_LAST_TS     — watermark written by gmail_ingest; not hand-set.
function cfg_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === "") ? fallback : v;
}
function cfgOwnerEmail_()    { return cfg_("OWNER_EMAIL", "austingimperial@gmail.com"); }
function cfgApiToken_()      { return cfg_("API_TOKEN", ""); }
function cfgEnforceToken_()  { return String(cfg_("ENFORCE_TOKEN", "false")).toLowerCase() === "true"; }
function cfgUsdPhpFallback_(){ return parseFloat(cfg_("USD_PHP_FALLBACK", "0")) || 0; }
function cfgMonthlyIncomePhp_(){ return parseFloat(cfg_("MONTHLY_INCOME_PHP", "47200")) || 0; }
function cfgTelegramToken_()  { return cfg_("TELEGRAM_BOT_TOKEN", ""); }
function cfgTelegramUserId_() { return cfg_("TELEGRAM_USER_ID", ""); }
function cfgGeminiKey_()      { return cfg_("GEMINI_API_KEY", ""); }
