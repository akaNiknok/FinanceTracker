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
const TX_INPUT_COLS = [
  "ID", "Date", "Category", "Description", "Account", "Amount",
  "ExchangeRate", "ToAccount", "ToAmount"
];

// Fields a client is allowed to supply when creating/updating a transaction.
// (ID is assigned server-side; derived fields are ignored if sent.)
const TX_CLIENT_FIELDS = [
  "Date", "Category", "Description", "Account", "Amount",
  "ExchangeRate", "ToAccount", "ToAmount"
];

const BASE_CURRENCY = "PHP";

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
