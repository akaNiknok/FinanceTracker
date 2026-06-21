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
| `Code.gs` | `doPost` (append a transaction) + `addDailyInterestTransactions` job. |
| `Get.gs` | `doGet` — returns Categories + Accounts metadata as JSON. |
| `appsscript.json` | Apps Script manifest (runtime, timezone, web app access). |
| `.clasp.json` | Links repo to the Apps Script project (`scriptId`). |
| `.claspignore` | Restricts clasp pushes (only `.gs`/`.js`/`.html` + manifest). |
| `package.json` | npm scripts wrapping clasp. |
| `MEMORY.md` | Durable notes, decisions, secrets-locations, TODOs (read it too). |

> Apps Script has a **flat file namespace** (no folders/modules): all `.gs` files share one global scope, so function names must be unique across files.

## How the backend works
**`doPost(e)` — log a transaction (`Code.gs`):** parses `e.postData.contents` JSON; reads the **`Transactions`** header row and maps incoming JSON keys to columns **by header name** (sheet order, missing keys → `""`); appends one row; returns `{status, message}` JSON. So body keys must exactly match `Transactions` headers; add a sheet column to support a new field — no code change.
**`doGet(e)` — reference data (`Get.gs`):** returns `{Categories, Accounts}` JSON. `Categories` from **`Categories`** sheet → `{Type, Description}` keyed by category. `Accounts` from **`Accounts`** sheet → `{Currency}` keyed by name. When the frontend lands, `doGet` will likely branch (serve `HtmlService` UI vs. JSON API).
**`addDailyInterestTransactions()` — scheduled job (`Code.gs`):** for each `Accounts` row with `Interest Frequency === "Daily"`: `gross = balance * rate / 365`, apply **20% withholding tax** (`WITHHOLDING_TAX_RATE`), round to 2dp, append an `Income: Interest` transaction. Driven by a daily time-based trigger (see MEMORY.md; triggers are configured in the GAS UI, not in source).

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
- **Match sheet headers exactly** — `doPost` and the interest job map by header text; a renamed header silently breaks mapping.
- After changing n8n-facing behavior, **redeploy** (saved editor code doesn't affect the live Web App until deployed).
- Keep **MEMORY.md** current: decisions, trigger setup, secret locations, n8n details once added.
- **No Claude metadata in commits:** never add `Co-Authored-By: Claude ...` or `Claude-Session: ...` trailers to commit messages.
