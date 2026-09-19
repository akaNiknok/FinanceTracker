# V3_PLAN.md — the v3 design overhaul
The build plan for the redesign. Each phase runs in its own Claude session. **Delete this file in the v3.0.0 release PR.** After that, `git show v3.0.0~1:V3_PLAN.md` holds the history, the same way `OVERHAUL_PLAN.md` did for v1.

## Ground rules (all phases)
- **Read these first, and only these:** this file (your phase and "Ground rules") → `DESIGN.md` → the `spa-frontend` skill (and `worker-backend` if the phase touches `worker/src`). In `app.js`, read the renderer you change and the helpers it calls, never the whole file. Then read **only your phase's mockups** (table below).
- **Mockups: `design/v3/*.dc.html`.** They are the approved screens, exported from a design canvas. Each file is one HTML screen: markup with inline styles, plus a `class Component` script at the end.
  - `theme(d)` holds the light and dark colours. `renderVals()` holds the sample rows.
  - `{{t.x}}` is a colour token, `<sc-for>` is a loop, and `<dc-import name="Sidebar">` inserts the shared part of that name.
  - They need the canvas runtime, so they do not open in a browser. Read them as a spec for layout, spans, spacing and copy.
  - Their figures are invented. The real formulas are under "Numbers" below.
  - If a mockup and DESIGN.md disagree, DESIGN.md wins. Delete `design/` in the v3.0.0 release PR, together with this file.
| Phase | Read these mockups |
| --- | --- |
| 1 | `Sidebar`, `Rail`, `TabBar`, `Toolbar` |
| 2 | `Summary-Phone`, `Summary-iPad`, `Summary-Desktop` |
| 3 | `Activity-Phone`, `Filters-Phone`, `Activity-Desktop` |
| 4 | `QuickAdd-Phone`, `TabBar`, `Toolbar` |
| 5 | `Accounts-Phone`, `Accounts-Desktop`, `Investments-Desktop` |
| 6 | `Swap-Desktop`, `Tax-Desktop`, `Admin-Desktop` |
- **Branch:** `git switch -c feature/v3-p<N>-<name> --no-track origin/develop`. Open one PR into `develop` per phase and wait for CI. The merge deploys to **staging**, and the owner checks it on iPhone and iPad.
- **Release freeze:** no `develop` → `main` release from the Phase 1 merge until Phase 6. A mixed old/new UI must not go live. An urgent live fix uses the hotfix flow (off `main`).
- **Verify before the PR:** run `npm run dev:seed`, then `preview_start worker`. Check the screens you changed at **390×844, 820×1180 and 1440×900**, each in **light and dark**, plus one run with mobile touch emulation. Then take one screenshot set for the PR. Run `npm test` (the push hook also runs it).
- **Tests:** a new pure helper in `app.js` gets an assertion in `test.js`'s "the SPA loads" block (it runs `app.js` in a `vm` and can call top-level functions). A new handler or new SQL gets a test in `test-api.js`. A new write handler must bump the version, and the contract guard checks that.
- **Payloads:** bump `LS_SCHEMA` when a cached payload changes shape. Keep old routes that an old service-worker-cached `app.js` may still call.
- **Do not change** the app-shell scroll model, `--app-h`, the offline queue, `gs()`/`cachedCall`/ETag, or the screen keys (`dashboard`, `transactions` stay in the code and in deep links; only their labels change).
- **Handoff:** at the end of each phase, write `HANDOFF.md` (the CLAUDE.md rule) and tick the phase below.

## Numbers the tooltips must use (checked against the code, 2026-09-19)
- **Emergency runway** (`getInvestments` → `runway`): reachable cash ÷ average monthly spend.
  - Reachable cash = cash-like accounts + EF-subtype shares (IB01), − credit balances, − money you owe through a receivable (a negative receivable).
  - Money you lent (a positive receivable) is left out, because you cannot reach it.
  - Average spend = signed Expense total over the **last 3 closed months** ÷ 3.
  - Target = 4 months.
  - Phase 2 fixed the Accounts card's "− money lent" copy (lent money is excluded, not subtracted), and `runway.parts` carries the four terms.
- **Financially free in** (`getDashboard` → `fire`, `fireEta`):
  - Target = 25 × annual spend (the 4% rule).
  - Progress = net worth at the **last month close** − money lent.
  - Spend and savings = averages over the last 3 closed months.
  - Growth = `meta.fire_real_return`, % real per year.
  - The date is anchored to the 1st of the current month, so the countdown falls by one day each day.
- **Left to spend** (the Essentials + Rewards roll-up in the dashboard's budgets payload): the budget of the two segments − their signed spend this month.
  - "A day" = that remainder ÷ the days-left figure the card already shows (`daysLeft`).
- **Net worth since last month** = `nwBridge`: Saved (income − expense) plus "market, FX and timing" (the residual).
- **Gain** = value − `costPhp` (average cost, the historical peso rate on each buy leg). A sale takes cost out in proportion.
- **Not in the data, so leave out** (the mockups showed them): due dates on recurring rows (the `recurring` table has only `months_left` and `grp`), a card's payment due date, and a "Needs review" state (there is no reviewed flag; see Phase 3).

## Phases
### Phase 1 — Foundation and shell  ☑
Goal: every existing screen runs in the new frame, with no content redesign yet.
- `app.css`: replace the token block with DESIGN.md's light/dark tokens (`:root`, `[data-theme=dark]`, and `prefers-color-scheme` under `:root:not([data-theme=light])`). Map the old token names onto the new ones first, so the old screens restyle without edits. Then delete the old names that nothing uses.
- Theme: Auto / Light / Dark in `localStorage` (`ft.theme`). Apply it in the `index.html` head script before first paint, so the page never flashes the wrong theme. `<meta name="theme-color">` follows the theme. Add the ⌘⇧L / Ctrl Shift L shortcut.
- Type: the system font stack. Delete `worker/public/fonts/`, the `@font-face` rules, the preload, and the `sw.js` `SHELL` entries. Update the spa-frontend skill ("Fonts are ours" paragraph) and any README mention.
- Icons: an SVG `<symbol>` sprite in `index.html` (the DESIGN.md name list). Replace the text-glyph nav icons (☉ ⇅ ▤ ⇆ § ⚙ ⋯).
- Shell: tab bar + docked add bar (under 768px), icon rail (768–1199px), sidebar (1200px and wider), each with the sync state (online / offline / N queued, from the existing queue) and the theme button. The labels become Summary, Activity, Accounts, More. For now the add field opens the existing `openTxModal`, with the text as its description. Phase 4 makes it parse.
- `tip()` helper: the DESIGN.md tooltip (hover and focus on a pointer device, tap on the ⓘ on touch, Esc and outside tap close it; one open at a time). Phase 2 is its first user.
- App icon: the gradient version in `icons.js`, then `npm run icons`.
- Tests: update any `test.js` assertion that names a removed glyph, font or file.
Done when: every screen works at the 3 widths × 2 themes with the new chrome, the theme survives a reload with no flash, and offline shows its state.

### Phase 2 — Summary (dashboard)  ☑
- Rebuild `renderDashboard` as the tile grid: net worth hero (sparkline, "since <month>" chip, bridge line), Left to spend (bar, per-day line, the three segment rows), Financially free in, Emergency runway, Last 6 months (the net-worth stack and cash-flow bars on a **shared month axis** with the 6M / 1Y / 2Y control), spending by category, recent.
- Spans: 4 columns on PC, 2 on iPad, stacked on iPhone (Free in and Runway pair up).
- Runway on Summary: read `cachedCall('investments')` beside the dashboard call. No new route, because the payload already exists. Keep the card on Accounts until Phase 5 moves it.
- Tooltips with the formulas above: runway, free in, left to spend, net worth change.
- Chart inspect: one vertical line through both charts on hover or tap, and a month tooltip with every value.
- Keep the month picker, `wide` spans, and the rAF chart mount rule (the skill explains why).
Done when: seed-data figures match the old dashboard exactly, every tooltip's inputs add up, and inspect works with the mouse and with touch.

### Phase 3 — Activity and filters  ☑
- Frontend: `renderTransactions` becomes Activity.
  - A token search field: typing suggests Category / Account / Month / Type / Amount / Source / Text tokens. The token grammar is a pure helper (`parseTokens`), with tests.
  - The Spent / Earned / Moved segmented control.
  - Click a category, account or date in a row to add it as a token.
  - PC: a filter pane with smart lists and the account list with balances (this replaces the edit-mode account rail), and a table.
  - iPhone: a grouped-by-day list, a Filters sheet, swipe for Edit / Delete, and Select mode.
  - Select mode on every size, with the floating bulk bar (Category, Account, Date, Delete). It reuses `bulkUpdateTransactions` and `bulkDeleteTransactions`.
  - Inline single-field edit stays.
- Backend (`listTransactions`):
  - `minAmount` / `maxAmount`: compare `ABS(amount_php_u)`, but on a share-priced source apply the NOT_SHARES rule. Read the skill first.
  - `source`: the id prefix — `tg-`, `gm-`, `ui-`, `interest-`, anything else = legacy. Needs no schema change.
- Smart lists: the built-in ones are token presets in code (This month, Big spends ₱5,000+, Subscriptions, From Gmail). Saved ones live in `meta.smart_lists` (a JSON list, ≤ 20), written by a new `setSmartLists` handler and echoed in `getBootstrap.smartLists`. It is the same pattern as `setWidgetAccounts`, so they sync across devices. Update README (new meta key).
- **"Needs review" is out of scope for v3.0.** It needs an additive `reviewed_at` column and a rule for clearing it. Offer "From Gmail" / "From Telegram" source lists instead, and log it as a TODO in MEMORY.md.
Done when: every old filter (search, date, month, type, category, account) can be expressed, and the new ones work. Bulk edit works with touch and with the mouse, and `test-api.js` covers the new args and the handler.

### Phase 4 — Type to add and ⌘K  ☐
- The add field parses as you type:
  - **Instant, local:** the amount and the account (fuzzy match on account names, `fuzzyScore`), and the category from the last use of the same description.
  - **On Return, or when the local pass finds no category:** a new read route `getParse` → `gemini.parse` (the bot's parser, the same prompt, so its category rules hold).
- The result sheet shows the amount, the chips (Category, Account, Date) and Spent / Earned / Moved, and each chip can be changed. Return saves through `createTransaction` / `createTransfer`, so it uses the offline queue.
- Offline, or when Gemini fails: keep the local parse. If the category is missing, open the full form with the fields filled.
- "Repeat one" chips: `getBootstrap.quickPicks` gives the top 8 description / category / account / amount sets from the last 90 days (one query).
- ⌘K / Ctrl K: the same field also lists screens ("jump") and search matches (go to Activity with a Text token).
- Keyboard on iOS: the docked bar follows `visualViewport` so it stays above the keyboard.
- Tests: the local parser in `test.js`. `getParse` in `test-api.js` with the Gemini call stubbed. The route-naming guard treats `get*` as a read.
Done when: "vitamins 620 gcash" + Return saves the right row online, offline it queues or opens the filled form, and a parse failure never loses the typed text.

### Phase 5 — Accounts and Investments  ☐
- Accounts:
  - totals row (assets, liabilities, net)
  - cash and banks (with the interest line from `interest_rate` / `interest_frequency`)
  - credit (a limit meter from `credit_limit_u`, "Limit reached" in `--warn`)
  - owed to you ("not counted in runway")
  - recurring and installments ("N months left" from `months_left`, grouped by `grp`)
  - the widget picker card
- Investments, as a **new screen** and nav item (`?screen=investments`): invested with gain, the quarterly pulse (growth tickers only; the note that IB01 is left out), allocation, and the holdings table with average cost. Add ⓘ tooltips on Gain and Pulse. Move the Holdings, Pulse and Runway cards out of Accounts. Runway already shows on Summary.
- iPhone: the More sheet holds Investments, Swap, Tax, Admin.
Done when: nothing that Accounts shows today is lost, and the figures match the old screen.

### Phase 6 — Tools, polish, release v3.0.0  ☐
- Swap: an input list, the hero result, and the fair-rate range bar (the Wise floor → the fair rate → the ceiling, plus the mid-market mark). **Record this swap** opens `openTransferModal`, filled in: from a USD account, to a PHP account, Amount = USD, ToAmount = the ₱ result. The implied-rate rule then stamps the fair rate.
- Tax: quarter tiles (filed status from `Filed?`), the "not in the ledger" banner, the table with the typed BSP-rate cell, and the BSP tooltip.
- Admin: the table picker as a segmented control, locked columns marked (a natural key is in `add` but not in `edit`), paging and CSV unchanged.
- Motion pass (the DESIGN.md table). Sweep the old CSS for dead rules.
- Sync the Scriptable widget colours to the new tokens.
- Update README where the human's world changed (fonts gone, new screens, the smart_lists key if Phase 3 did not add it). Run a final 3 × 2 check of every screen.
- Release: `npm version major --no-git-tag-version` (3.0.0, which stamps `brand-ver`). Delete this file and `design/`, then `npm run release`. The owner merges, the release runs, and later revisions ship as v3.0.x / v3.x.
