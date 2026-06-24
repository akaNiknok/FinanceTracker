# Phase 1 Migration — Sheet setup (copy-paste)

One-time migration to prepare the workbook for the overhaul: add a stable `ID` key to
every transaction and convert the derived columns to header-anchored `ARRAYFORMULA`s so
the service layer can write **input columns only**. Code lives in `Migration.gs`.

**Time:** ~5 min · **Reversible:** yes — step 1 makes a timestamped backup sheet first.

---

## Before you start

- Current Transactions layout (A→…): `.`, Date, **Month**, Category, Description,
  **Type**, **Segment**, Account, **Currency**, Amount, **Amount (PHP)**, ExchangeRate,
  ToAccount, **ToCurrency**, ToAmount. Bold = derived (becomes ARRAYFORMULA).
  `ExchangeRate` stays a **static input** (the frozen FX lever) — it is *not* converted.
- The script finds columns by **header name**, so order doesn't matter — but the header
  text must match exactly (`Amount (PHP)`, `ExchangeRate`, etc.).

---

## Step 1 — Push the code

```bash
npm run pull   # optional: sync any edits made in the GAS editor first
npm run push   # uploads Migration.gs to the Apps Script project
```

## Step 2 — Pick the Month format (one constant)

Open `Migration.gs` in the Apps Script editor. Set `MIG_MONTH_FORMAT` to match what your
**Dashboard pivots** group by:

| Want | Set `MIG_MONTH_FORMAT` to | Example |
| --- | --- | --- |
| Sortable year-month | `"yyyy-mm"` | `2026-06` |
| Short month + year | `"mmm-yyyy"` | `Jun-2026` |
| Month name only | `"mmmm"` | `June` |

> If unsure, open the Dashboard, click a pivot's Month grouping, and copy that format.

## Step 3 — Run `setupMigration()`

Editor → function dropdown → **`setupMigration`** → **Run** → authorize if prompted.
It will:
1. Create a backup sheet `Transactions_backup_<timestamp>`.
2. Append an **`ID`** column (if absent) and backfill a UUID into every existing row.

Check **Execution log** for `Backfilled N new ID(s)`. Safe to re-run (idempotent).

## Step 4 — Run `applyDerivationFormulas()`

Function dropdown → **`applyDerivationFormulas`** → **Run**. For each derived column it
clears the old per-row content and drops in one ARRAYFORMULA at row 2 (spills down).
The log prints each formula and `OK` / `FAIL` per column.

> **If any column logs `FAIL`** (most likely if Transactions is a Google Sheets *Table*,
> which restricts whole-column array formulas): either convert it to a plain range
> (Table menu → Convert to range) and re-run, or paste that one formula manually from
> the fallback below.

## Step 5 — Verify

- Add a quick test row (just Date, Category, Account, Amount). Confirm Month, Type,
  Segment, Currency, Amount (PHP) auto-fill, then delete the test row.
- Confirm the Dashboard pivots still read correctly (this is what the Month format guards).
- Spot-check a USD (Wise) row: Amount (PHP) should equal `Amount × ExchangeRate`.

## Step 6 — Done

No redeploy needed for the migration itself (no web-app behavior changed). Keep the
backup sheet for a few days, then delete it.

---

## Phase 1b (optional) — derive Accounts `Type` from `Subtype`

Removes the hand-maintained Asset/Liability column so it can't drift: `Type` becomes
a lookup of `Subtype` against a small `AccountType` reference tab (same pattern as
Transactions deriving Type/Segment from Categories). The service layer reads `Type`
either way — no code change.

**Run:** editor → function dropdown → **`setupAccountType`** → **Run**. It will:
1. Create an **`AccountType`** sheet seeded `Subtype → Type` (Liquid/EF/Receivable/For
   Investment/Stocks → Asset; Credit → Liability). Edit it anytime to add rows.
2. Auto-append any Subtype found in `Accounts` but missing from the reference (guessed
   Asset/Liability) and **log it for review**.
3. Back up `Accounts`, then set each row's `Type` to
   `=IFERROR(VLOOKUP($<Subtype>, AccountType!$A:$B, 2, FALSE), IF($<Subtype>="","Asset",""))`.

**Notes:** uses **per-row** formulas (not a whole-column ARRAYFORMULA) so it works even
though Accounts is a Table — Tables auto-fill the formula on new rows. Idempotent.
**Check the log** for `BLANK Subtype` accounts (e.g. some receivables) and set their
Subtype so reports group correctly; they default to `Asset` meanwhile. A present-but-
unmatched Subtype shows blank `Type` on purpose — add it to `AccountType` to fix.

## Phase 1c (optional) — data-validation dropdowns (typo guard)

Adds dropdowns so a misspelling can't silently break a VLOOKUP / balance SUMIF:
`Accounts.Subtype` ← the `AccountType` list, `Accounts.Interest Frequency` ← a fixed
list, `Transactions.Category` ← the `Categories` list. The range-backed ones auto-extend
as you add subtypes/categories.

**Run:** editor → **`setupDataValidation`** → **Run**. Re-runnable.

**Lenient by default** (`MIG_VALIDATION_STRICT = false`): bad entries are *flagged*
(red corner) but not blocked — so existing legacy values and service-layer/n8n writes
aren't rejected; the service layer stays the hard validator. Flip the constant to `true`
to reject invalid manual entries outright. After running, scan for red-cornered cells —
those are existing typos worth fixing.

## Phase 1d (optional) — redesign Budgets (targets-only) + split out Recurring

Collapses the old Budgets sheet — which stored the same target three ways
(`Target %` / `USD` / `PHP`), pinned its **own** stale `PHP to USD` rate, kept
sheet-computed actuals, and carried an `Essentials & Rewards` roll-up *row* — into
a **plan-only** sheet. Actuals/remaining/% now compute live in `Budgets.gs`
(period-aware), so there's nothing duplicated to drift. The embedded
`Monthly Expenses` table is split into its own `Recurring` sheet.

New `Budgets` columns: `Segment | Period | Target Type | Target | Currency | Notes`.
Hybrid targets — `Percent` rows resolve against `MONTHLY_INCOME_PHP`; an `Amount`
row with `Currency=USD` (e.g. Growth's $200 quarterly cap) converts at the **live**
USD→PHP rate, the single FX source the rest of the app uses.

**Run:** editor → **`setupBudgets`** → **Run**. It will:
1. Find the `Monthly Expenses` block (by its `Description` header) and copy it to a
   new **`Recurring`** sheet (`Description, Currency, Amount, Transaction Fee,
   Months Left, Group`; govt contributions tagged `Group=Govt`).
2. Back up the old Budgets sheet wholesale (`Budgets_backup_<timestamp>`), then
   rebuild **`Budgets`** with the new headers + 4 seed rows (Essentials 50% /
   Rewards 10% / Stability 15% monthly, Growth $200 quarterly). **Adjust to taste.**
3. Set `MONTHLY_INCOME_PHP` (Script Property) to `47200` if unset — the planning
   base for percent targets. Update it when your income changes.

**Idempotent:** re-running won't clobber an already-migrated Budgets sheet (detected
via the `Target Type` header) or an existing `Recurring` sheet. No redeploy needed
(sheet-only change). Verify with `Tests.gs test_budgets`.

---

## Manual fallback — paste the ARRAYFORMULAs yourself

If you'd rather not run `applyDerivationFormulas()`, do this per derived column:
**(a)** select the column's data cells from **row 3 down** and delete, **(b)** click the
**row-2** cell of that column and paste its formula, press Enter — it spills down.

Formulas below assume the **default layout** above and Categories `A=Category, B=Type,
C=Segment` / Accounts `A=Name, B=Currency`. If your columns moved, adjust the letters.
Replace `yyyy-mm` in the Month formula with your chosen format.

**`Month`** (cell `C2`):
```
=ARRAYFORMULA(IF(LEN(B2:B), TEXT(B2:B,"yyyy-mm"), ""))
```

**`Type`** (cell `F2`):
```
=ARRAYFORMULA(IF(LEN(D2:D), IFERROR(VLOOKUP(D2:D, Categories!$A:$C, 2, FALSE), ""), ""))
```

**`Segment`** (cell `G2`):
```
=ARRAYFORMULA(IF(LEN(D2:D), IFERROR(VLOOKUP(D2:D, Categories!$A:$C, 3, FALSE), ""), ""))
```

**`Currency`** (cell `I2`):
```
=ARRAYFORMULA(IF(LEN(H2:H), IFERROR(VLOOKUP(H2:H, Accounts!$A:$B, 2, FALSE), ""), ""))
```

**`ToCurrency`** (cell `N2`) — mirrors Currency but looks up `ToAccount` (col M):
```
=ARRAYFORMULA(IF(LEN(M2:M), IFERROR(VLOOKUP(M2:M, Accounts!$A:$B, 2, FALSE), ""), ""))
```

**`Amount (PHP)`** (cell `K2`):
```
=ARRAYFORMULA(IF(LEN(J2:J), J2:J * IF(LEN(L2:L), L2:L, 1), ""))
```

---

## Notes & guardrails

- **Never write into a formula column.** The Phase 1 service layer must write input
  columns only (`ID`, Date, Category, Description, Account, Amount, `ExchangeRate`,
  transfer fields) by exact column index — a stray write into a derived cell `#REF!`s the
  whole spill.
- **Keep volatile functions out of the derivation band** (no `GOOGLEFINANCE`/`TODAY`/
  `NOW`/`IMPORTRANGE`). `GOOGLEFINANCE` for live share prices stays in the **Accounts**
  sheet only.
- **Manual rows** added by hand won't get an `ID` automatically — re-run
  `stampMissingIds()`, or we wire an installable `onChange` trigger in Phase 1.
- `ExchangeRate` blank ⇒ treated as `1` (PHP rows). The service layer will stamp a live
  rate (overridable) for non-PHP rows.
