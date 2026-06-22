# MEMORY.md
Durable, append-only project notes (newest on top). **Keep token-efficient: dense, minimal blank lines, lines may exceed 80 chars.**

## Project facts
- **What:** personal finance tracker; backend = GAS over one Google Sheets workbook, published as a Web App (JSON API).
- **Apps Script ID:** `1IiUkd6dyJFnLuGXjjcS_CEohyeZLsXNO3eqFGm438IQL02dyhUxjgarE` (linked via `.clasp.json`).
- **Current client:** one **n8n workflow** (workflow JSON to be added later).
- **Goal:** also build a **GAS Web App frontend** (HTML via `HtmlService`) atop the API.
- **Locale:** PHP; timezone `Asia/Manila`.
- **Daily interest:** `gross = balance * rate / 365`, minus **20% withholding tax**, posted as `Income: Interest` for accounts with `Interest Frequency = "Daily"`.

## Deployment & triggers
- **Web App deployment:** a live deployment exists. URL is **kept out of git** (treated as secret — web app is `ANYONE_ANONYMOUS`); stored separately by the owner. n8n calls this URL. Redeploy the **same** `deploymentId` to avoid changing it.
- **Trigger:** 1 time-based **daily** trigger runs `addDailyInterestTransactions` at ~5–6am (`Asia/Manila`). Configured in the GAS UI (not in source).

## Sheets (keep in sync with code)
- `Transactions` — header row drives `doPost`; known: `Date`, `Category`, `Account`, `Amount`.
- `Accounts` — `Name`, `Currency`, `Interest Frequency`, `Current Balance (PHP)`, `Interest Rate`.
- `Categories` — `Category`, `Type`, `Segment`, `Description`.

## Decisions
- 2026-06-22: Added data-pull read endpoint for testing (`Read.gs`, wired into `doGet`). `?sheets` lists names; `?sheet=<name>` (or `all`) dumps raw rows as JSON; `&limit=<n>` caps rows. Default `doGet` (Categories+Accounts) unchanged → n8n `/sync` unaffected. Note: web app is `ANYONE_ANONYMOUS`, so this exposes raw `Transactions` to anyone with the URL — same URL-as-secret model as before; revisit/lock down when the authenticated frontend lands. Live behavior only changes after redeploying the same `deploymentId`.
- 2026-06-20: Web App frontend must be responsive — usable on desktop, tablet, and mobile.
- 2026-06-20: Repo configured for clasp (`.clasp.json`, `appsscript.json`, `.claspignore`, `package.json`, `.gitignore`). Manifest: `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS` so n8n POSTs without OAuth.
- 2026-06-20: Deployment URL kept out of git (secret); only its existence + trigger details recorded here.

## TODO / open questions
- [x] Add the n8n workflow JSON for reference — exports in `n8n/` (`Finance Tracker.json`, `Finance Tracker - Error Handler.json`), 2026-06-21. Client = private Telegram bot: parses messages via Gemini → POSTs to GAS Web App; `/sync` refreshes Categories/Accounts; separate error-handler workflow. Secrets redacted: Apps Script Web App URL → `<<APPS_SCRIPT_WEB_APP_URL>>`, n8n API key → `<<N8N_API_KEY>>` (see `n8n/README.md`).
- [ ] Plan the Web App frontend: how `doGet` serves HTML vs. JSON.
- [ ] Confirm exact, full column lists for each sheet.
