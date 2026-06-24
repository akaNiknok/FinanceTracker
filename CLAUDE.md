# CLAUDE.md
Guidance for Claude Code (and humans) working in this repo. **Keep this file and MEMORY.md token-efficient: dense, minimal blank lines, no filler; lines may exceed 80 chars. Apply the same when editing them.**

## Project overview
**FinanceTracker** is a **personal finance tracker**. Backend = **Google Apps Script (GAS)** over one Google Sheets workbook, published as a Web App exposing a small JSON API (record transactions, read accounts/categories) plus a scheduled daily-interest job.
- **Use:** personal finance tracking — log transactions, accounts, interest into a private Google Sheet.
- **Current client:** a single **n8n workflow** (workflow JSON to be added later).
- **Direction:** also build a **GAS Web App frontend** (HTML via `doGet`/`HtmlService`), not just an API. Must be **responsive** — desktop, tablet, and mobile friendly.
- **Locale:** amounts in **PHP**; timezone `Asia/Manila`.

## Repository layout
| File | Purpose |
| --- | --- |
| `Router.gs` | The **only** `doGet`/`doPost`. Dispatches by `?action=`; keeps legacy n8n paths (bare-body POST = create tx; no-action GET = `/sync` payload). |
| `Config.gs` | Sheet names, the Transactions **input vs derived** column model, settings via Script Properties (`OWNER_EMAIL`, `API_TOKEN`, `ENFORCE_TOKEN`, `USD_PHP_FALLBACK`). |
| `Auth.gs` | Write/read guards: owner-identity (restricted deploy) or shared `API_TOKEN` (opt-in via `ENFORCE_TOKEN`, off by default so n8n keeps working). |
| `SheetUtil.gs` | Header maps, find-by-ID, **input-columns-only** writes (never touch the ARRAYFORMULA cells), `jsonResponse`. |
| `Transactions.gs` | `api_createTransaction/listTransactions/updateTransaction/deleteTransaction/createTransfer`; validation; idempotent by `ID`. |
| `Accounts.gs` | `api_getAccounts` (derived balances vs stored) + `api_updateAccount`. |
| `Reads.gs` / `Dashboard.gs` | `api_getBootstrap/getBudgets/getCalendar/getLedger/getCategories`; `api_getDashboard/getInvestments` aggregations. |
| `Fx.gs` | Live USD→PHP fetch (cached 6h) to stamp the static `ExchangeRate` input; per-tx override wins. |
| `Interest.gs` | `addDailyInterestTransactions` job, now routed through the service layer (input-only writes). |
| `Read.gs` | Raw sheet-dump debug helpers (behind the read guard in Router). |
| `Tests.gs` | Editor-runnable verification + balance reconciliation. |
| `Migration.gs` | One-shot Phase 1 schema migration (`ID` column + ARRAYFORMULA derivation). See `MIGRATION.md`. |
| `appsscript.json` | Apps Script manifest (runtime, timezone, web app access). |
| `.clasp.json` | Links repo to the Apps Script project (`scriptId`). |
| `.claspignore` | Restricts clasp pushes (only `.gs`/`.js`/`.html` + manifest). |
| `package.json` | npm scripts wrapping clasp. |
| `MEMORY.md` | Durable notes, decisions, secrets-locations, TODOs (read it too). |

> Apps Script has a **flat file namespace** (no folders/modules): all `.gs` files share one global scope, so function names must be unique across files.

## How the backend works (service layer — Phase 1)
**Architecture:** one **service layer** owns every write + all rules; the UI and n8n both call it through the `?action=` JSON API. `Router.gs` is the sole `doGet`/`doPost` and dispatches to `api_*` handlers. **Schema invariant (post-migration):** derived columns (Month, Type, Segment, Currency, Amount (PHP), ToCurrency, the `.` index) are header-anchored **ARRAYFORMULA**s; the service writes **input columns only** (`SheetUtil.su_*InputRow_`) so a stray write never `#REF!`s a spill. `appendRow` is banned — it would clobber the derivation band.
**JSON API (`?action=`):** reads — `getBootstrap`, `listTransactions` (filters month/account/category/segment/search + `limit`/`offset`), `getAccounts`, `getDashboard`, `getInvestments`, `getBudgets`/`getCalendar`/`getLedger`/`getCategories`. writes (POST) — `createTransaction`, `createTransfer`, `updateTransaction`, `deleteTransaction`, `updateAccount`. Every tx has a stable server-assigned **`ID`**; `createTransaction` is idempotent if the caller passes an existing `ID`.
**Backward compat (n8n unbroken):** POST with no `action` and a bare transaction body → `createTransaction`; GET with no `action` → the old `{Categories, Accounts}` `/sync` payload; `?sheets`/`?sheet=` raw dumps still work (now behind the read guard). So **the live deployment behaves the same for n8n** until we redeploy + cut over auth in Phase 3.
**Auth (`Auth.gs`):** writes pass `auth_requireWrite_` — allowed if the active user is `OWNER_EMAIL` (restricted deploy) **or** token enforcement is off (`ENFORCE_TOKEN` default false) **or** a valid `API_TOKEN` is supplied. The manifest is **intentionally still `ANYONE_ANONYMOUS`** in Phase 1; flipping to `MYSELF` happens with the n8n OAuth cutover (Phase 3) to avoid breaking the bot.
**FX (`Fx.gs`):** `ExchangeRate` is a **static stamped input** — per-tx override wins, else PHP→blank (formula treats blank as 1), else a cached live USD→PHP fetch, else `USD_PHP_FALLBACK`. History never reprices.
**Balances (`Accounts.gs`):** each account exposes `balancePhp` (the figure UI/dashboard use) + `balanceSource`. **PHP cash** accounts are derived = Starting Balance + Σ tx deltas (Income +, Expense −, Transfer source→ToAccount) — **verified** to reconcile against the sheet (2026-06-24). **Non-PHP (FX) and Shares** accounts can't be valued by summing historical `Amount (PHP)` (FX drift / money invested), so `balancePhp` trusts the sheet's **stored** balance (already priced via live FX / Google Finance). `computedBalance`/`storedBalance` are both returned for reconciliation; re-check anytime with `Tests.gs test_balanceReconciliation`. Liabilities compute negative (debt), so net worth sums straight through.
**`addDailyInterestTransactions()` (`Interest.gs`):** unchanged math (`gross = balance*rate/365` − 20% withholding), but now routes through `api_createTransaction` (input-only write, auto-derived, stable ID). Daily time-based trigger, configured in the GAS UI.

## Google Sheet structure (source of truth)
Code depends on these sheets/headers; keep them in sync.
- **`Transactions`** — header row drives `doPost`. Known columns: `Date`, `Category`, `Account`, `Amount`.
- **`Accounts`** — `Name`, `Currency` (col B), `Interest Frequency`, `Current Balance (PHP)`, `Interest Rate`.
- **`Categories`** — `Category`, `Type`, `Segment`, `Description`.

## clasp workflow (push/deploy to Apps Script)
Linked via `.clasp.json` (`scriptId` is committed; the auth token is not).
- **One-time:** `npm install`; `npm run login` (OAuth → `~/.clasprc.json`, gitignored). Enable the Apps Script API once at https://script.google.com/home/usersettings before first push.
- **Day-to-day:** `npm run push` (upload `.gs`+manifest) · `npm run watch` (auto-push on save) · `npm run pull` · `npm run open` · `npm run logs`.
- **Deploy Web App:** `npm run deploy` (new versioned deployment) · `npm run deployments` (list IDs) · `npx clasp deploy --deploymentId <id> --description "..."` (update existing in place). The n8n workflow calls a specific deployment URL — to change behavior **without breaking the URL**, redeploy the **same** `deploymentId` (a new deployment = new URL).
- **Web App access:** manifest sets `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS` so n8n POSTs without OAuth. The deployment URL is effectively the credential — treat as secret (kept out of git; see MEMORY.md). Revisit when adding the authenticated frontend.

## Conventions & gotchas
- **Never commit credentials:** `.clasprc.json` and the deployment URL stay out of git; `.clasp.json` (`scriptId` only) is safe.
- **clasp pushes only whitelisted files** (`.claspignore`): manifest + `*.gs`/`*.js`/`*.html`. Docs, `package.json`, `node_modules/` never reach GAS.
- **`clasp pull` before editing** if the GAS editor may have changed, to avoid clobbering remote edits.
- **Unique global function names** across all `.gs` (flat namespace).
- **Match sheet headers exactly** — the service maps columns by header text; a renamed header silently breaks mapping.
- **Never write a derived/formula column.** Service writes go through `su_setInputCells_`/`su_appendInputRow_` (input columns only). Never reintroduce `appendRow` on `Transactions` — it writes every column and `#REF!`s the ARRAYFORMULA spills.
- After changing n8n-facing behavior, **redeploy** (saved editor code doesn't affect the live Web App until deployed).
- Keep **MEMORY.md** current: decisions, trigger setup, secret locations, n8n details once added.
- **No Claude metadata in commits:** never add `Co-Authored-By: Claude ...` or `Claude-Session: ...` trailers to commit messages.
