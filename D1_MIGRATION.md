# D1_MIGRATION.md — Google Sheets → Cloudflare D1 (v2.0.0)

Execution plan for the v2.0.0 platform migration. Written 2026-08-23, decisions confirmed by owner. The implementing session should read this file top-to-bottom, then CLAUDE.md, before touching code. Style rule: this file follows CLAUDE.md's dense style.

## Decisions (owner-confirmed, do not re-litigate)
1. **D1 replaces Google Sheets** as the source of truth. The Sheet is frozen at cutover and kept as a read-only archive.
2. **The Telegram bot moves into the Worker** (Gemini parse, intents, receipts, undo). GAS shrinks to a Gmail courier + a Sheets-backup puller.
3. **GmailApp stays in GAS** — it's free OAuth to the owner's mailbox. The GAS job no longer writes anywhere; it POSTs email text to the Worker.
4. **Admin UI = new SPA screen**: generic CRUD grid over a server-side table whitelist. No SQL console. Anything weirder = `wrangler d1 execute` from the owner's machine.
5. **Backup = nightly GAS pull** of a full JSON export into a backup spreadsheet, plus per-table CSV download in the admin screen. D1 Time Travel (7 days on free) is the oh-no button.
6. **Share prices come from IBKR Flex Web Service** (all holdings are at IBKR), nightly cron, stored in a `prices` table. **No fetch on the read path.** GOOGLEFINANCE is gone with the Sheet.
7. **$0 budget is a hard constraint** (audit below — everything fits free tiers with orders of magnitude to spare).
8. Version after cutover: **v2.0.0** (major: platform swap). Bump before the release merge per gitflow.

## End-state architecture
```
Telegram ─┐
SPA ──────┼─► Cloudflare Worker ── D1 (source of truth)
Gmail(GAS courier) ─┘   │  ├─ KV: fx cache (6h) [API_CACHE repurposed or deleted]
                        │  ├─ cron 1 (daily, 00:30 Manila): interest job
                        │  └─ cron 2 (daily): IBKR Flex → prices table
GAS keeps: Gmail.gs courier (5-min trigger) + Backup.gs (nightly dump pull). No Web App deployment, no doGet/doPost, no deploymentId, no GAS_URL secret.
```
**The prime directive: the `/api` JSON contract does not change.** Same `?action=` names (Router.gs's two tables become the Worker's route table), same request/response shapes, same `{status:'error'}`/`{status:'duplicate'}`/401 semantics, same `DATA_VERSION` protocol. `app.js` changes should be near-zero outside the new admin screen. Capture v1 response fixtures BEFORE cutover (one JSON file per read route, real data) and add a contract test that v2 handlers match those shapes.

## $0 budget audit (verified 2026-08-23)
| Resource | Free limit | Our load | Notes |
| --- | --- | --- | --- |
| Workers requests | 100k/day | <1k/day (SPA + bot + crons; assets unmetered) | |
| Workers CPU | 10ms/invocation | JS only — Gemini/Telegram/IBKR waits are I/O, don't count | Heaviest CPU = dashboard aggregation; push GROUP BYs into SQL |
| Cron triggers | 5/account, no retry on failure | 2 | On failure: catch + `tg_send_` the owner (see Crons) |
| D1 storage | 5 GB | a few MB | |
| D1 reads/writes | 5M read rows/day, 100k written/day | thousands / dozens | |
| D1 Time Travel | 7 days point-in-time restore (free) | backup layer 2 | Layer 1 = nightly Sheets dump |
| KV | 100k reads, 1k writes/day | fx cache only | |
| GAS (consumer) | 90 min triggers/day etc. | Gmail courier + backup pull — less than today | |
| Gemini API | free tier (flash) | unchanged — same key, caller moves GAS→Worker | Billing identity is the API key, not the runtime |
| IBKR Flex Web Service | free, ~1 req/s/token | 2 requests/night | Token expires ≤1 year — maintenance row in README |
Subrequest limit (50/request, free) — bot worst case: 3 Gemini fallbacks + a few D1 batches + 2 Telegram calls ≈ 10. Fine.

## Schema (worker/migrations/0001_init.sql)
Conventions: money/amounts are **INTEGER micros** (native units × 1,000,000) — exact integer sums AND room for fractional IBKR share quantities in the same column (a Shares row's amount is a quantity, same as the Sheet today). Convert to decimals only at the API boundary (`u/1e6`), so the wire format is unchanged. Dates are `yyyy-MM-dd` TEXT; month keys stay `yyyy-MMM` (`2026-Aug`) **everywhere including the DB** — the SPA, bot prompt, and Budgets all compare that exact shape (MIG_MONTH_FORMAT's successor). FKs by integer id internally; the API keeps speaking account/category **names** (resolve on write, JOIN on read) — renames become an UPDATE on one row instead of "never rename".

```sql
PRAGMA foreign_keys = ON; -- D1 default, but importer must insert parents first

CREATE TABLE account_types (            -- was AccountType sheet
  subtype TEXT PRIMARY KEY,
  type    TEXT NOT NULL CHECK (type IN ('Asset','Liability'))
);

CREATE TABLE accounts (                 -- was Accounts sheet (input cols only)
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  currency           TEXT NOT NULL DEFAULT 'PHP',
  subtype            TEXT NOT NULL REFERENCES account_types(subtype),
  symbol             TEXT,              -- NEW: IBKR ticker for Shares accounts (was buried in the GOOGLEFINANCE formula)
  starting_balance_u INTEGER NOT NULL DEFAULT 0,
  interest_frequency TEXT,
  interest_rate      REAL,
  credit_limit_u     INTEGER,
  notes              TEXT,
  color              TEXT
);
-- Current Balance / Available Credit are NOT columns: computed at read (see Balances).

CREATE TABLE categories (               -- was Categories sheet
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('Income','Expense','Transfer')),
  segment     TEXT,
  description TEXT
);

CREATE TABLE transactions (             -- was Transactions input columns; ARRAYFORMULA band → generated cols/JOINs
  id            TEXT PRIMARY KEY,       -- keeps existing id space: tg-*, gm-*, ui-*, interest-*, legacy
  date          TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period        TEXT CHECK (period IS NULL OR period GLOB '[0-9][0-9][0-9][0-9]-[A-Z][a-z][a-z]'),
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  description   TEXT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  amount_u      INTEGER NOT NULL,       -- signed, native units, micros (sheet signs copied verbatim)
  fx_rate       REAL,                   -- was ExchangeRate: stamped at write for non-PHP, NULL = 1 (PHP)
  to_account_id INTEGER REFERENCES accounts(id),   -- transfers stay ONE row, same as the sheet
  to_amount_u   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Month: Period override wins, else derived from date. Replaces the ARRAYFORMULA + the '@' text-format gotcha + tx_parsePeriod_'s downstream half.
  month TEXT GENERATED ALWAYS AS (COALESCE(period,
    strftime('%Y', date) || '-' || substr('JanFebMarAprMayJunJulAugSepOctNovDec',
      (CAST(strftime('%m', date) AS INTEGER) - 1) * 3 + 1, 3))) STORED,
  -- Amount (PHP) in micros. ROUND before CAST — CAST alone truncates.
  amount_php_u INTEGER GENERATED ALWAYS AS (CAST(ROUND(amount_u * COALESCE(fx_rate, 1)) AS INTEGER)) STORED
);
CREATE INDEX idx_tx_month    ON transactions(month);
CREATE INDEX idx_tx_date     ON transactions(date);
CREATE INDEX idx_tx_account  ON transactions(account_id);
CREATE INDEX idx_tx_category ON transactions(category_id);
-- Type/Segment/Currency are JOINs (categories.type/segment, accounts.currency), not columns.

CREATE TABLE budgets (                  -- was Budgets sheet: plan only, actuals stay computed
  id          INTEGER PRIMARY KEY,
  segment     TEXT NOT NULL UNIQUE,
  period      TEXT NOT NULL CHECK (period IN ('Monthly','Quarterly')),
  target_type TEXT NOT NULL CHECK (target_type IN ('Percent','Amount')),
  target      REAL NOT NULL,
  currency    TEXT,                     -- 'USD' → live FX, NULL/'PHP' passes through
  notes       TEXT
);

CREATE TABLE recurring (                -- was Recurring sheet, reference only
  id          INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  currency    TEXT,
  amount_u    INTEGER,
  fee_u       INTEGER,
  months_left INTEGER,
  grp         TEXT                      -- 'Group' is a keyword-ish header; grp in SQL, "Group" on the wire
);

CREATE TABLE ledger (                   -- was Ledger sheet (BIR 8% tracker)
  id            INTEGER PRIMARY KEY,
  tx_id         TEXT,      -- SOFT reference, deliberately no FK: a deleted tx must render '⚠ transaction deleted' (LEFT JOIN misses), not block the delete or silently NULL out
  bsp_rate      REAL,      -- hand-typed BIR reference rate; deliberately NOT fx_rate (see CLAUDE.md Ledger row)
  filed         TEXT,      -- BIR quarter string '2026-Q1'; legacy 'TRUE' values imported as-is
  date_received TEXT,      -- literal fallbacks for legacy rows never linked to a tx; NULL when tx_id set
  wise_amount_u INTEGER
);
-- Derived (Date Received, Reporting Period, Wise Amount, Total Income, 8% Tax) = one LEFT JOIN view:
CREATE VIEW ledger_view AS
SELECT l.id, l.tx_id, l.bsp_rate, l.filed,
  COALESCE(t.date, l.date_received)        AS date_received,
  t.month                                  AS reporting_period,   -- derived month, same rule as the sheet formula
  COALESCE(t.amount_u, l.wise_amount_u)    AS wise_amount_u,
  CAST(ROUND(COALESCE(t.amount_u, l.wise_amount_u) * COALESCE(l.bsp_rate, 1)) AS INTEGER)        AS total_income_u,
  CAST(ROUND(COALESCE(t.amount_u, l.wise_amount_u) * COALESCE(l.bsp_rate, 1) * 0.08) AS INTEGER) AS tax_u,
  (l.tx_id IS NOT NULL AND t.id IS NULL)   AS tx_deleted          -- UI renders the ⚠ row
FROM ledger l LEFT JOIN transactions t ON t.id = l.tx_id;

CREATE TABLE prices (                   -- replaces GOOGLEFINANCE; written by the nightly IBKR cron
  symbol    TEXT NOT NULL,
  priced_at TEXT NOT NULL,              -- yyyy-MM-dd (IBKR report date)
  price     REAL NOT NULL,              -- native quote currency per share
  currency  TEXT NOT NULL,
  PRIMARY KEY (symbol, priced_at)       -- history is free and is the audit trail the Sheet never had
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- Replaces Script Properties AND is editable in the admin grid:
--   data_version, monthly_income_php, usd_php_fallback, tg_last_ids (undo state), ledger_first_year
INSERT INTO meta (key, value) VALUES ('data_version', '1');
```

**Balances (port of "derivation lives in the Sheet"):** derivation now lives in two GROUP BYs, computed in the read handler (a view is possible but the FX/price join is clearer in JS for ~15 accounts):
`SELECT account_id, SUM(amount_u) FROM transactions GROUP BY account_id` + same on `to_account_id`/`to_amount_u`; native balance = starting + out + in. PHP balance: PHP → as-is; USD → × live FX (KV-cached 6h, `usd_php_fallback` fallback — Fx.gs ports to ~20 lines); Shares → qty × latest `prices` row for `accounts.symbol` × FX if the quote currency isn't PHP. `availableCredit` = credit_limit − balance for Liability subtypes. Keep the API fields exactly: `balancePhp` (liabilities positive), `balanceNative`, `netWorthPhp` (signed), `availableCredit`, `isLiability`, `isShares`.
**Budget actuals** become one query: `SELECT c.segment, SUM(ABS(t.amount_php_u)) FROM transactions t JOIN categories c ON c.id=t.category_id WHERE c.type IN ('Expense','Transfer') AND t.month IN (?...) GROUP BY c.segment` (1 month key, or 3 for Quarterly). Percent targets × `monthly_income_php`, USD caps × live FX — port Budgets.gs logic as-is.
**Cash flow / dashboard**: GROUP BY month over the trailing 6 keys; same shapes as `api_getDashboard`.

## Worker layout
`worker/` becomes an ESM multi-module Worker (wrangler bundles):
```
worker/worker.js          entry: fetch (assets fall through; /api, /login, /tg) + scheduled (crons)
worker/src/db.js          D1 helpers: name↔id resolution, micros↔decimal boundary, bumpVersion (same batch as the write)
worker/src/api.js         route table (verbatim port of ROUTES_READ_/ROUTES_WRITE_) + handlers ported from Transactions/Accounts/Budgets/Reads/Dashboard/Ledger .gs
worker/src/telegram.js    port of Telegram.gs: webhook, intents, receipts, undo (meta.tg_last_ids), tg_send_
worker/src/gemini.js      port of tg_parse_/tg_tryModels_ — UrlFetchApp→fetch, same responseSchema, same model fallback list; category/account lists now from D1
worker/src/jobs.js        interest job (port of Interest.gs incl. acct_computeDeltas_) + IBKR Flex fetch + fx helper (port of Fx.gs, KV 6h)
worker/migrations/0001_init.sql
migrate/import.js         one-shot: exported JSON → seed.sql (gitignored output)
```
Rules that carry over verbatim: every write handler bumps `data_version` **in the same `env.DB.batch()`** as its writes (replaces `su_lock_` + `cache_bumpVersion_` — D1 batches are transactional, so the lock discipline is free now); read/write split still derives from the `get…`/`list…` name prefix (port `test_routeMethodPrefixes`); `createTransaction`/`createTransfer` idempotency = `INSERT … ON CONFLICT(id) DO NOTHING` and report `{status:'duplicate'}` when `meta.changes===0` — the offline queue and Telegram-retry dedup depend on that exact contract (port `test_createIdempotencyGuard`).
**Auth:** `/api` accepts the `ft_auth` cookie (unchanged) **or** `Authorization: Bearer <INGEST_TOKEN>` — one extra check, and it's what the Gmail courier and the backup puller use. 401 stays JSON, never a redirect.
**Timezone:** GAS's script-tz safety net is gone. One helper (`manilaDate()` via `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila'})`) owns every "today"/closed-day/quarter computation — interest, month picker default, quarter windows. Grep for `new Date()` in ported code; each one is a suspect. Dates still cross the wire as `yyyy-MM-dd` strings both directions.
**KV edge cache (`cacheableRead`, `_v` stamping):** delete the Worker-side KV read cache — it existed to hide GAS latency and D1 is the thing it was faking. Client `cachedCall`/`S.cache`/version gating stays untouched (still the offline story). `gs()`'s `_v` stamp becomes inert; removing it client-side is optional cleanup, not required for cutover.
**New routes (all under `/api?action=`, registered in the same table):** `listTable`/`updateTableCell`/`insertTableRow`/`deleteTableRow` (admin grid — server-side whitelist of {table → editable columns}; `transactions` deliberately NOT in the whitelist for insert/update, it has real handlers; allow delete-by-id for surgery), `exportAll` (every table as JSON — backup puller + admin CSV), `ingestEmail` (POST, bearer-only: {from, subject, date, body, messageId} → gemini parse with the email preamble → logItems with `gm-<messageId>` prefix → Telegram receipt with ⌕ Email data echoed back to GAS? No — receipt's ⌕ Email button keeps `e:<msgId>` callback, and the callback handler now asks GAS? It can't. See Gmail courier below for the ⌕ Email resolution.)

## Telegram + Gemini continuity (owner's explicit concern)
- **Webhook URL does not change** — Telegram already delivers to the Worker's `/tg`. No `setWebhook` re-run needed unless `allowed_updates` changes (it doesn't; `callback_query` is already enabled). `/tg` stops forwarding to GAS and handles the update in-process; replies get faster (no GAS boot, no 302 dance, no `waitUntil` fire-and-forget guesswork).
- Gemini: same `GEMINI_API_KEY` (becomes a Worker secret), same REST endpoint via `fetch`, same `responseSchema`, same flash→flash-lite→pro fallback. Free tier is keyed to the API key, not the caller.
- Receipts/undo/edit-details: `tg_appUrl_` becomes trivial — the Worker IS the app origin. Undo state `TG_LAST_IDS` → `meta.tg_last_ids`. `u:<idPrefix>:<indices>` callbacks port as-is. Glyph rule (`↻ ✎ ⌕`, no VS15) ports with `test_telegramUndoGlyph`.
- **⌕ Email button:** the Worker can't call GmailApp. Two options; take (a): (a) `ingestEmail` stores the quoted excerpt (the same 1200-char `gmail_quote_` text GAS already builds — GAS sends it in the payload) in `meta` or a tiny `email_quotes` table keyed by messageId; the `e:` callback reads it from D1. (b) drop the button. (a) is ~10 lines and keeps a feature the owner uses.

## GAS after v2 (what remains, ~2 files)
- `Gmail.gs` → courier: same trigger, same lock, same `GMAIL_QUERY_`/label/watermark/trash-on-success logic, but instead of parse+log locally it does `UrlFetchApp.fetch(WORKER_URL + '/api?action=ingestEmail', {headers:{Authorization:'Bearer '+INGEST_TOKEN}, payload: JSON({from,subject,date,body,messageId,quote})})` and trashes the mail **only when the response says every item landed** (same rule as today). Keep `gmail_dumpSamples`, `test_gmailScope`.
- `Backup.gs` (new): nightly trigger → GET `exportAll` with the bearer token → rewrite the tabs of a dedicated "FinanceTracker Backup" spreadsheet (one tab per table, header row + values; plain `setValues`, no formulas — it's a dump, not a live sheet).
- Deleted: Router, Auth, SheetUtil, Transactions, Accounts, Budgets, Reads, Dashboard, Ledger, Cache, Fx, Interest, Telegram, Migration, and the sheet-bound half of Tests. **The Web App deployment itself is deleted** — no doGet/doPost remains, so: no deploymentId, no `.deploymentid` file, no GAS_URL secret, no "never create a new deployment" rule, no clasp redeploy step. `clasp push` still exists for the two remaining files (rare).
- Script Properties kept: `TELEGRAM_* (delete)`, keep `GMAIL_QUERY`/`GMAIL_LAST_TS`/`GMAIL_HINTS`, new `WORKER_URL` + `INGEST_TOKEN`. Everything else migrates to Worker secrets or `meta`.

## Crons (wrangler.toml `[triggers] crons = [...]`, 2 of 5 free)
1. **`30 16 * * *`** (00:30 Manila) — interest job: port of `addDailyInterestTransactions(7)`. Same math (`gross = closing×rate/365` − 20%), same deterministic `interest-<account>-<date>` ids, same closed-days-only + 7-day reprice + subtract-own-output rules, oldest→newest. Closing balances from D1 (`SUM … WHERE date <= ?` per day — or one query grouped by date, both trivial at this row count).
2. **`0 22 * * *`** (06:00 Manila, after IBKR's overnight refresh) — IBKR Flex: `SendRequest?t=<IBKR_FLEX_TOKEN>&q=<IBKR_FLEX_QUERY_ID>&v=3` → ReferenceCode → `GetStatement` (poll a few times, seconds apart — I/O wait, no CPU) → parse Open Positions XML (symbol, position, markPrice, currency) → upsert `prices` rows. **Set the `User-Agent` header** (IBKR requires it). Position quantities are logged for reconciliation against the ledger-derived quantity but **not written** — transactions stay the source of truth for how many shares you own; IBKR only prices them.
3. **Failure handling for both** (free plan does not retry crons): wrap in try/catch → `tg_send_` the owner the error. A missed night is harmless (interest self-repairs 7 days back; prices just stay one day staler).

Owner setup (manual, before cutover): create a Flex Query in Client Portal (Open Positions section: Symbol, Position, Mark Price, Currency), enable Flex Web Service, generate the token (max validity), note query id. **Token expires ≤1 year — add a README maintenance row.**

## Data migration (one-shot)
1. **Freeze:** disable the Gmail trigger, `tg_deleteWebhook` is NOT needed (Worker still 200s; just don't send messages), stop SPA writes. Note the Sheet's `Current Balance`/`Current Balance (PHP)` for every account — they're the acceptance numbers.
2. **Export (GAS, throwaway `Export.gs`):** dump every sheet's **input columns** (+ Categories/AccountType/Budgets/Recurring/Ledger in full, + the balance snapshot above, + each Shares account's GOOGLEFINANCE ticker → `accounts.symbol`) as JSON files to Drive; download.
3. **Import (`migrate/import.js`, node, no deps):** JSON → `seed.sql` — resolve names→ids, decimals→micros (`Math.round(x*1e6)`), parents before children (FKs are ON), legacy Ledger rows without a matched tx get literal `date_received`/`wise_amount_u`. Then `npx wrangler d1 execute financetracker --remote --file=seed.sql`. Create the DB with `--location=apac` (single-region; put it near Manila).
4. **Verify (blocking, all must pass):** row counts per table vs sheet; **balance reconciliation** — v2 `getAccounts` vs the frozen snapshot, to the centavo, every account; spot-check 3 months of `getDashboard`/`getBudgets` vs v1 fixtures; every ledger row's Total Income/8% Tax vs sheet values; contract test green on all read fixtures.
5. **Cutover:** deploy Worker v2 (webhook target unchanged), push the 2-file GAS project, re-enable the Gmail trigger, set the new Backup trigger, delete the GAS Web App deployment + old triggers. Smoke test: SPA all screens, log via bot, undo, edit-details link, one email ingest, admin grid edit, exportAll.
6. **Release:** version → 2.0.0, merge develop→main, `npm run release` (updated — see Tooling).
7. **Rollback (first week):** the Sheet is frozen, not deleted; v1.9.x GAS code is one `git checkout v1.9.x && clasp push` + one `wrangler rollback` away. After a clean week, archive the Sheet and delete the dead `.gs` from the repo. D1 Time Travel covers data mistakes for 7 days; the nightly Sheets dump covers forever.

## Tooling / repo changes
- `release.js`: drop clasp push/redeploy steps entirely (GAS changes are rare and manual now); add `wrangler d1 migrations apply financetracker --remote` before `wrangler deploy`. Tag/GH-release logic unchanged.
- `test.js`: keep the tiny vm harness only for `Gmail.gs`'s pure helpers; everything else becomes plain ESM imports from `worker/src/` (no vm needed). Port the guard tests named above + fixture contract tests. `npm test` stays no-Google-account.
- `wrangler.toml`: add `[[d1_databases]]` binding, `[triggers]` crons; delete the API_CACHE KV block or repurpose the namespace for the fx cache (one binding rename).
- Secrets after v2 — Worker: `APP_PASS` (keep), `SECRET_TOKEN` (keep), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `GEMINI_API_KEY`, `INGEST_TOKEN`, `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID`. Deleted: `GAS_URL`. GAS: `WORKER_URL`, `INGEST_TOKEN`, `GMAIL_*`.
- Docs (same commit as the change, per CLAUDE.md): README Maintenance half largely rewritten (hosting, secrets table, triggers, IBKR token renewal row, new fault-isolation rows, rebuild steps); CLAUDE.md rewritten around the new layout (most of the Sheet-invariant lore — ARRAYFORMULA band, `@` format, header matching, appendRow ban, `su_*` — gets deleted, which is half the point).

## Gotchas for the implementer (each of these is a real bug if missed)
- **Micros boundary:** every handler converts at the edge, never mid-logic. Importer sum-check: Σ amount_php_u/1e6 per account must match the frozen sheet balances exactly.
- **`ROUND` before `CAST`** in generated columns — CAST truncates toward zero; negative amounts make truncation visible fast.
- **Manila time:** D1/Workers run in UTC. Every "today" goes through the one helper. The interest job's "closed day" and the BIR quarter window are the two places a UTC slip silently corrupts data.
- **Month key shape:** `yyyy-MMM` with exactly that capitalization, everywhere. The generated column's substr trick produces it; `period` CHECK enforces it; the bot's Gemini prompt and the SPA already speak it.
- **Idempotency contract:** `ON CONFLICT DO NOTHING` + `{status:'duplicate'}`. The offline queue drops a write ONLY on explicit server rejection — don't turn a D1 error into a shape the client reads as rejection.
- **D1 transactions are `batch()` only** — no interactive BEGIN across await points. Write + version bump = one batch. Bulk ops = one batch of statements.
- **Signs:** copy the sheet's sign conventions verbatim (expenses negative, liability balances positive in `balancePhp`, negative in `netWorthPhp`). The reconciliation step catches this, which is why it's blocking.
- **Gmail courier trash rule:** trash only when the Worker confirms all items landed; per message, never per thread. Unchanged semantics, new transport.
- **`run_worker_first`** already covers `/api`, `/login`, `/tg` — no new paths needed (everything new is an `?action=`). `not_found_handling` stays unset.
- **Worker free CPU is 10ms:** fine for everything here, but don't add a JS full-table scan where a GROUP BY works — the dashboard is the one handler with any aggregation weight.
