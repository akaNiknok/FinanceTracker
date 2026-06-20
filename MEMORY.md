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
- 2026-06-20: Repo configured for clasp (`.clasp.json`, `appsscript.json`, `.claspignore`, `package.json`, `.gitignore`). Manifest: `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS` so n8n POSTs without OAuth.
- 2026-06-20: Deployment URL kept out of git (secret); only its existence + trigger details recorded here.

## TODO / open questions
- [ ] Add the n8n workflow JSON for reference.
- [ ] Plan the Web App frontend: how `doGet` serves HTML vs. JSON.
- [ ] Confirm exact, full column lists for each sheet.
