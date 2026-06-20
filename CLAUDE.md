# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## Project overview

**FinanceTracker** is a **personal finance tracker** whose backend runs on
**Google Apps Script (GAS)** against a single Google Sheets workbook. The Apps
Script project is published as a Web App that exposes a small JSON API for
recording transactions and reading reference data (accounts, categories), plus a
scheduled job that posts daily interest.

- **Primary use:** personal finance tracking — logging transactions, accounts,
  and interest into a private Google Sheet.
- **Current client:** an **n8n workflow** is the only consumer of the API today.
  (The workflow JSON will be added to this repo later for additional context.)
- **Direction:** the goal is to also build a **GAS Web App frontend** (served
  HTML via `doGet` / `HtmlService`) so the tracker has a UI, not just an API.
- **Currency / locale:** amounts are in **PHP**; script timezone is
  `Asia/Manila`.

## Repository layout

| File              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `Code.gs`         | `doPost` (append a transaction) and `addDailyInterestTransactions` job. |
| `Get.gs`          | `doGet` — returns Categories + Accounts metadata as JSON.               |
| `appsscript.json` | Apps Script manifest (runtime, timezone, web app access).               |
| `.clasp.json`     | Links this repo to the Apps Script project (`scriptId`).                |
| `.claspignore`    | Restricts what clasp pushes to GAS (only `.gs` / `.js` / `.html` + manifest). |
| `package.json`    | Convenience npm scripts wrapping clasp.                                 |
| `MEMORY.md`       | Durable project notes, decisions, and TODOs (read this too).            |

> Apps Script has a **flat file namespace** — there are no folders/modules.
> Every `.gs` file shares one global scope, so function names must be unique
> across all files. New top-level code just adds to the same global namespace.

## How the backend works

### `doPost(e)` — log a transaction (`Code.gs`)
- Parses `e.postData.contents` as JSON.
- Reads the header row of the **`Transactions`** sheet and maps incoming JSON
  keys to columns **by header name** (order follows the sheet, missing keys → `""`).
- Appends one row; returns `{status, message}` JSON.
- **Implication:** the JSON body keys must exactly match the `Transactions`
  header text. Add a column to the sheet to support a new field — no code change
  needed.

### `doGet(e)` — reference data (`Get.gs`)
- Returns `{ Categories, Accounts }` as JSON.
- `Categories` from the **`Categories`** sheet → `{ Type, Description }` keyed by category.
- `Accounts` from the **`Accounts`** sheet → `{ Currency }` keyed by account name.
- **Note:** when the Web App frontend is built, `doGet` will likely need to
  branch (e.g. serve `HtmlService` for the UI vs. JSON for the API).

### `addDailyInterestTransactions()` — scheduled job (`Code.gs`)
- For each `Accounts` row with `Interest Frequency === "Daily"`:
  `gross = balance * rate / 365`, then applies a **20% withholding tax**
  (`WITHHOLDING_TAX_RATE`), rounds to 2 dp, and appends an
  `Income: Interest` transaction.
- Intended to be driven by a **time-based trigger** (daily). Triggers are
  configured in the Apps Script UI and are not part of the source files.

## Google Sheet structure (source of truth)

The code depends on these sheets/headers existing. Keep them in sync.

- **`Transactions`** — header row drives `doPost`. Known columns referenced in
  code: `Date`, `Category`, `Account`, `Amount`.
- **`Accounts`** — columns referenced: `Name`, `Currency` (col B),
  `Interest Frequency`, `Current Balance (PHP)`, `Interest Rate`.
- **`Categories`** — columns: `Category`, `Type`, `Segment`, `Description`.

## clasp workflow (push / deploy to Apps Script)

This repo is set up for [`clasp`](https://github.com/google/clasp). It is
already linked to the Apps Script project via `.clasp.json` (`scriptId` is
committed; the secret is the auth token, which is **not**).

### One-time setup
```bash
npm install            # installs @google/clasp locally
npm run login          # opens browser; OAuth -> writes ~/.clasprc.json (gitignored)
```
> Enable the Apps Script API for your account once at
> https://script.google.com/home/usersettings before the first push.

### Day-to-day
```bash
npm run push           # upload local .gs + appsscript.json to Apps Script
npm run watch          # auto-push on save while developing
npm run pull           # pull remote changes into the repo
npm run open           # open the project in the Apps Script editor
npm run logs           # tail execution logs
```

### Deploying the Web App
```bash
npm run deploy                 # create a new versioned deployment
npm run deployments            # list deployment IDs
npx clasp deploy --deploymentId <id> --description "..."   # update existing deployment in place
```
> The n8n workflow calls a specific deployment URL. To change behavior **without
> breaking the existing URL**, redeploy the **same** `deploymentId` rather than
> creating a new one (a new deployment yields a new URL).

### Web App access
`appsscript.json` sets `executeAs: USER_DEPLOYING` and
`access: ANYONE_ANONYMOUS` so n8n can POST without OAuth. The deployment URL is
effectively the credential — treat it as a secret. Revisit this when adding the
authenticated frontend.

## Conventions & gotchas

- **Never commit credentials:** `.clasprc.json` is gitignored. `.clasp.json`
  (just the `scriptId`) is safe to commit.
- **clasp only pushes whitelisted files** (see `.claspignore`): `appsscript.json`
  and `*.gs` / `*.js` / `*.html`. `CLAUDE.md`, `MEMORY.md`, `package.json`,
  `node_modules/`, etc. are never pushed to Apps Script.
- **Always `clasp pull` before editing** if changes may have been made in the
  Apps Script editor, to avoid clobbering remote edits on the next push.
- **Unique global function names** across all `.gs` files (flat namespace).
- **Match sheet headers exactly** — `doPost` and the interest job map by header
  text; a renamed header silently breaks mapping.
- After changing backend behavior used by n8n, **redeploy** (the editor's saved
  code does not affect the live Web App until deployed).

## Pointers

- Update **`MEMORY.md`** with any new decisions, the Apps Script Web App
  deployment URL (kept out of git if treated as secret), trigger setup, and the
  n8n workflow details once added.
