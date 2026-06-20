# MEMORY.md

Durable, append-only notes for the FinanceTracker project. Record decisions,
context, and TODOs here so they survive across sessions. Newest entries on top.

## Project facts

- **What it is:** Personal finance tracker. Backend = Google Apps Script over a
  single Google Sheets workbook, published as a Web App (JSON API).
- **Apps Script ID:** `1IiUkd6dyJFnLuGXjjcS_CEohyeZLsXNO3eqFGm438IQL02dyhUxjgarE`
  (linked via `.clasp.json`).
- **Current client:** a single **n8n workflow** (workflow JSON to be added to
  the repo later for more context).
- **Goal:** also build a **GAS Web App frontend** (HTML UI via `HtmlService`)
  on top of the existing API.
- **Currency:** PHP. **Timezone:** `Asia/Manila`.
- **Daily interest:** `gross = balance * rate / 365`, minus **20% withholding
  tax**, posted as `Income: Interest` transactions for accounts with
  `Interest Frequency = "Daily"`.

## Sheets (must stay in sync with code)

- `Transactions` — header row drives `doPost`; known: `Date`, `Category`,
  `Account`, `Amount`.
- `Accounts` — `Name`, `Currency`, `Interest Frequency`,
  `Current Balance (PHP)`, `Interest Rate`.
- `Categories` — `Category`, `Type`, `Segment`, `Description`.

## Decisions

- 2026-06-20: Repo configured for clasp (`.clasp.json`, `appsscript.json`,
  `.claspignore`, `package.json`, `.gitignore`). Web App manifest set to
  `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS` so n8n can POST
  without OAuth.

## TODO / open questions

- [ ] Add the n8n workflow JSON to the repo for reference.
- [ ] Record the live Web App deployment URL (treat as secret — keep out of git).
- [ ] Document the time-based trigger that runs `addDailyInterestTransactions`.
- [ ] Plan the Web App frontend: how `doGet` will serve HTML vs. JSON.
- [ ] Confirm exact, full column lists for each sheet.
