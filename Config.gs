/**
 * Config.gs — single source of truth for sheet names, the Transactions column
 * model (which columns the service may WRITE vs. which are formula-derived and
 * must never be touched), and settings read from Script Properties.
 *
 * Phase 1 foundation (see OVERHAUL_PLAN.md §4). Flat namespace: every function
 * name here is unique across all .gs files.
 */

// ── Sheet names ───────────────────────────────────────────────────────────────
const SHEET_TX        = "Transactions";
const SHEET_ACCOUNTS  = "Accounts";
const SHEET_CATEGORIES = "Categories";
const SHEET_BUDGETS   = "Budgets";
const SHEET_CALENDAR  = "Calendar";
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
// Derived columns (formula-owned). Listed for documentation / guard checks only.
const TX_DERIVED_COLS = [
  ".", "Month", "Type", "Segment", "Currency", "Amount (PHP)", "ToCurrency"
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
//   API_TOKEN         — shared secret the API requires for mutations (n8n/UI).
//   ENFORCE_TOKEN     — "true" to require API_TOKEN on writes (default: off, so
//                       the live n8n bot keeps working until Phase 3 cuts over).
//   USD_PHP_FALLBACK  — exchange rate used if the live FX fetch fails.
function cfg_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === "") ? fallback : v;
}
function cfgOwnerEmail_()    { return cfg_("OWNER_EMAIL", "austingimperial@gmail.com"); }
function cfgApiToken_()      { return cfg_("API_TOKEN", ""); }
function cfgEnforceToken_()  { return String(cfg_("ENFORCE_TOKEN", "false")).toLowerCase() === "true"; }
function cfgUsdPhpFallback_(){ return parseFloat(cfg_("USD_PHP_FALLBACK", "0")) || 0; }
