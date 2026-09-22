---
name: apps-script
description: What is left in Google Apps Script — the Gmail courier, the nightly Drive backup and their tests. Use when editing Gmail.gs, Backup.gs, Tests.gs or .clasp.json, or when a GAS trigger, the backup or Gmail ingest fails.
---

# Apps Script (GAS)

Only the owner can ship a change here: `npm run push` from their machine (clasp needs interactive OAuth).

| File | Purpose |
| --- | --- |
| `Gmail.gs` | **The mail courier.** Same trigger, same user lock, same `GMAIL_QUERY_`/label/watermark/trash-on-success logic as v1 — but it parses nothing and writes nothing: `gmail_payload_` builds `{messageId,from,subject,date,hints,body,quote}` and POSTs it to `?action=ingestEmail` with the bearer token, and trashes the mail only when the response says every item landed (`logged === total`), **per message, never per thread** (MariBank's alerts share one thread). `quote` travels with the payload because the Worker cannot call GmailApp — that's what the receipt's ⌕ Email button reads back out of `email_quotes`. Holds `cfg_`/`worker_url_`/`worker_token_`, shared with `Backup.gs` through the GAS flat namespace. Keeps `gmail_dumpSamples`. |
| `Backup.gs` | Nightly `GET ?action=getExportAll` → `JSON.stringify` into ONE Drive file, "FinanceTracker Backup.json", rewritten each night; creates it on first run and remembers the id in `BACKUP_FILE_ID`. **It was a spreadsheet until v3.2.0** — 45 lines to build a union-of-keys header and grow the sheet past 1000×26, and `setValues` COERCED the values (a digit string came back a number, a leading zero vanished), so the dump did not reload into D1, which is a backup's only job. Drive's own revision history now does what rewriting one book destroyed. **`DriveApp` needs the Drive API enabled, which a DEFAULT Apps Script project cannot do** — the first run died with `Permission denied while enabling APIs: drive`, so the project now runs on a STANDARD GCP project (README has the setup). Its consent screen stays at `Testing` with the owner as the one test user: `DriveApp` pulls the RESTRICTED `/auth/drive` scope, so publishing would demand a privacy policy, terms of service and a security assessment for a one-user script. **The open risk that buys:** Google cancels a Testing refresh token after 7 days, and reports disagree on whether that also stops an Apps Script trigger. The `backup_run` trigger therefore carries "Notify me immediately", and the fallback if it does bite is to drop `DriveApp` for a `MailApp` attachment — no GCP project, no Drive API, no new scope. `backup_install()` adds the trigger. Failure → email to the effective user (there's no Telegram token in GAS any more). |
| `Tests.gs` | What is left to test in GAS: the courier's pure helpers. `PURE_TESTS` is driven by `test.js`. |
