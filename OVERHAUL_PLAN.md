# FinanceTracker — System Overhaul Plan

Status: **draft for review** (2026-06-22). Confirmed decisions are locked; "Open
items" near the end list defaults that can still change before Phase 1 ships.

## 1. Goal

Turn the current code-poor / schema-rich setup into a coherent personal finance
system with three pillars:

1. **Google Sheets** — the database (already is; schema is richer than the code uses).
2. **GAS Web App** — the **primary UI**, responsive on desktop / tablet / mobile,
   with **full CRUD plus investment / FIRE analytics**.
3. **n8n + Telegram** — natural-language capture: log transactions & transfers,
   answer read-back queries, and correct / undo recent entries.

### Confirmed decisions (from clarification)

| # | Decision |
| --- | --- |
| Build order | **Backend / schema first**, then Web App UI, then bot upgrades. |
| UI scope | **Full CRUD + investments/FIRE** views (primary UI, responsive). |
| Security | **Native Google sign-in** for the UI; n8n stops posting anonymously. |
| Bot | Add **transfers + multi-transaction**, **queries / read-back**, **corrections / undo**. |

## 2. Current state (audit)

**Sheet (7 tabs) — the real DB, only partly used by code:**

- **Transactions** (~950 rows, 15 cols): `.` index, Date, Month, Category,
  Description, Type, Segment, Account, Currency, Amount, Amount (PHP),
  ExchangeRate, **ToAccount / ToCurrency / ToAmount** (transfers as one row).
  `doPost` writes only 4 fields; Type / Segment / Month / Amount (PHP) are derived
  (formula or LLM/manual — to confirm); transfers and multi-currency aren't modeled in code.
- **Accounts** (26 rows, 12 cols): multi-currency (PHP / USD / Shares), Type
  (Asset / Liability), Subtype (Liquid / Credit / EF / Stocks / Receivable /
  For Investment), Starting Balance, Interest Frequency / Rate, Credit Limit, Notes.
  `doGet` exposes only Name + Currency.
- **Budgets**: 25 / 15 / 50 / 10 segment targets + embedded Monthly_Expenses table
  (recurring & one-off obligations w/ "Months Left") + Target Salary $800 / FX 59.
- **Calendar**: monthly gov't-contribution schedule (Pag-IBIG / SSS / BIR / PhilHealth).
- **Categories** (46 rows): Category → Type → Segment → Description (source of truth
  for derived fields).
- **Ledger** (BIR): per-payout tax tracker (Wise amount, BSP rate, total income,
  Filed?) for the 8% gross-income regime.
- **Dashboard**: pivot tables + charts.

**Backend (GAS):** `doPost` append-by-header; `doGet` returns Categories + Accounts
or raw dumps; `addDailyInterestTransactions` daily job. Web app is
`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS` (URL = the only credential).

**n8n:** Telegram → auth check → Switch (`/sync` vs text) → Gemini structured
parse → POST one transaction. Separate error-handler workflow.

## 3. Target architecture

```
                ┌──────────────────────────────────────┐
                │        Google Sheets (database)        │
                │ Transactions · Accounts · Categories · │
                │ Budgets · Calendar · Ledger · (Rates)  │
                └────────────────▲───────────────────────┘
                                 │ SpreadsheetApp (runs as owner)
                ┌────────────────┴───────────────────────┐
                │   GAS backend (one service layer)       │
                │   Router · Auth guard · Transactions ·  │
                │   Accounts · Budgets · Calendar ·       │
                │   Ledger · Interest · Aggregations      │
                └───▲────────────────────────────▲────────┘
   HtmlService UI   │                            │  authenticated JSON API
 (responsive SPA)───┘                            └────── n8n (Telegram bot)
```

**Core principle:** one **service layer** in GAS owns every write and all business
rules (derivation, transfers, balances, validation). The Web App UI **and** n8n both
go through it — no logic duplicated in n8n.

## 4. Phase 1 — Backend / schema foundation (build first)

### 4.1 Schema changes
- **Stable transaction `ID`** column (UUID or timestamp+rand) on every row. This is
  the enabler for UI edit/delete and bot undo/correct — nothing reliable works without it.
- **Derived fields computed on write** by the service layer (Type, Segment from
  Categories; Currency from Account; Month from Date; Amount (PHP) from FX). Gives the
  API consistent values and avoids appendRow vs. formula conflicts. *(Alternative:
  ARRAYFORMULA helper columns — see Open items #2.)*
- **FX handling**: small `Rates` mechanism (sheet or live lookup) so Amount (PHP) is
  computed at write time from the row currency, instead of a single hard-coded 59.
- **Transfers** stay one row (ToAccount / ToCurrency / ToAmount); the service layer,
  UI, and bot all understand that shape.

### 4.2 Service layer (flat namespace — unique fn names)
- `Router.gs` — `doGet` / `doPost` dispatch by `?action=`; JSON vs. HTML.
- `Auth.gs` — Google-identity guard (active user must equal owner) for the UI;
  caller identity check for the API.
- `Transactions.gs` — create / list / update / delete; derivation; transfer expansion; ID assignment; validation.
- `Accounts.gs` — list / update; balance computation.
- `Budgets.gs` · `Calendar.gs` · `Ledger.gs` — reads + obligations + BIR/tax logic.
- `Interest.gs` — existing daily job, refactored onto the service layer.
- `Read.gs` — keep debug dumps, but **behind the auth guard**.

### 4.3 JSON API (versioned via `?action=`)
- `getBootstrap` — categories, accounts, budgets, segments, FX, calendar in one hydrate call.
- `listTransactions` — filters: month / account / category / segment / search; pagination.
- `createTransaction` · `createTransfer` — validate, derive, return created row + ID.
- `updateTransaction` · `deleteTransaction` — by ID.
- `getAccounts` · `updateAccount`.
- `getDashboard` — net worth, balances by Type/Subtype, budget-vs-actual per segment
  (current month), recent tx, upcoming obligations.
- `getInvestments` — positions (Stocks/EF) valued in PHP & %, vs Lean-6 core targets
  (60/25/15) and segment targets (25/15/50/10).

### 4.4 Integrity & security
- **Balances**: decide authoritative source — recommend **derive from Starting
  Balance + transaction deltas** (transfers touch two accounts) so ledger and balances
  never drift (Open item #1).
- **Validation / idempotency**: reject unknown categories/accounts; accept an
  idempotency key from n8n to prevent double-posts.
- **Auth migration**: manifest → `executeAs: USER_DEPLOYING`, `access: MYSELF`
  (or restricted). n8n authenticates as owner (OAuth Bearer) or writes via the Sheets
  API node (Open item #5). Redeploy the **same deploymentId** to keep the URL stable.

**Phase 1 deliverable:** documented, authenticated JSON API + clean schema with stable
IDs and consistent derived fields; `Tests.gs` runner functions for verification.

## 5. Phase 2 — Responsive Web App (full CRUD + investments)

- **Serving**: `doGet` returns `HtmlService` (templated, `IFRAME` sandbox, mobile
  viewport meta) when no `action`; `google.script.run` / fetch to the API.
- **Responsive**: mobile-first CSS grid/flex; bottom-nav on phone, sidebar on desktop.
- **Screens**:
  1. **Dashboard** — net worth, balances by Type/Subtype, this-month budget vs actual
     per segment (progress bars), recent tx, upcoming obligations.
  2. **Transactions** — filter/paginate; add / edit / delete; add transfer; quick-add FAB.
  3. **Accounts** — balances, edit, interest config, receivables.
  4. **Budgets** — segment targets vs actual; recurring/one-off obligations + Months Left.
  5. **Investments / FIRE** — portfolio value (PHP), allocation vs Lean-6 core (60/25/15)
     and segments (25/15/50/10), quarterly-rotation reminder, Stability-target progress
     (~$2,000). Read-only analytics — *no trade execution*.
  6. **Tax / BIR** — Ledger view: per-payout income, filed status, what's due (Calendar),
     running 8% liability.

Investment/FIRE views are read-only numbers from Accounts + the documented strategy;
rebalancing advice and the emotional-regulation/sell checks stay in the Claude advisor
project (`Financial_System.md`), not the app.

## 6. Phase 3 — n8n / Telegram upgrades

- **Auth**: HTTP nodes switch to the authenticated API (no more anonymous URL).
- **Richer Gemini parsing** (structured output):
  - **Transfers** and **multi-transaction** messages → array output → batch create.
  - **Queries / read-back**: intent detection (log vs. query); query intents hit the
    read API and format a reply ("Food this month: ₱X across N tx").
  - **Corrections / undo**: "undo last", "change last to 500", "that was groceries not
    gas" → resolve recent tx by ID (bot remembers last IDs per chat) → update/delete.
- **Confirmations**: ambiguous parses echo the parsed result with inline confirm/cancel
  before writing.
- Keep `/sync` and the error-handler workflow; update redacted-secrets docs.

## 7. Cross-cutting

- **Docs**: update `CLAUDE.md` (architecture, API, auth), `MEMORY.md` (decisions),
  `n8n/README.md` (new auth). Keep token-efficient.
- **Deploy discipline**: always redeploy the **same deploymentId** (stable URL).
- **Migration safety**: back up the Sheet before schema changes; add + backfill the ID
  column; verify derived columns reconcile against existing values.

## 8. Open items (defaults chosen; confirm before Phase 1 lands)

1. **Balances** — derive from transactions *(recommended)* vs. keep manually-maintained
   Current Balance?
2. **Derived fields** — how are Type / Segment / Amount (PHP) populated today (sheet
   formula vs. manual)? Drives migration; affects compute-on-write vs. ARRAYFORMULA.
3. **FX** — static (Budgets = 59) vs. live rate captured at write time?
4. **Investments v1** — read-only analytics *(recommended)* vs. editable holdings?
5. **n8n auth** — OAuth-as-owner Bearer to the same API *(keeps one write path,
   recommended)* vs. n8n writing directly via the Google Sheets API node?
