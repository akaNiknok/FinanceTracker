#!/usr/bin/env node
/**
 * test-api.js — the handlers against a REAL SQLite database, in memory.
 *
 * `test.js` covers pure functions and contract guards. This covers the half that only
 * a database can answer: does the schema actually create, do the generated columns
 * compute what the JS thinks they compute, does the ledger view join, does a duplicate
 * insert report `duplicate`, do the balances come out right end to end. Every one of
 * those would otherwise be discovered during the owner's cutover.
 *
 * node:sqlite is the same engine D1 runs, so the SQL is genuinely exercised — which is
 * how the two schema traps were caught (a non-deterministic function in a generated
 * column, and CAST truncating before ROUND). A tiny shim maps D1's prepare/bind/
 * all/first/run/batch onto it. batch() is NOT made transactional here; the tests do not
 * exercise rollback, and faking it would be pretending.
 *
 * Requires Node 22+ for node:sqlite. Older Node skips the file rather than failing —
 * `npm test`'s first half still runs everywhere.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) {
  console.log('\nskipping test-api.js: node:sqlite is unavailable (needs Node 22+)');
  process.exit(0);
}
// After the skip guard on purpose: the skip must still work on a Node too old for either
// built-in module.
const { test, describe } = require('node:test');

// ── the D1 shim ──────────────────────────────────────────────────────────────
function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec: () => {
      const st = db.prepare(sql);
      if (/^\s*(select|with)/i.test(sql)) return { results: st.all(...args), meta: { changes: 0 } };
      const r = st.run(...args);
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => s._exec()) };
}

(async function () {
  const load = (p) => import(pathToFileURL(path.join(__dirname, 'worker', p)).href);
  const api = await load('src/api.js');
  const dbm = await load('src/db.js');

  const sqlite = new DatabaseSync(':memory:');
  const env = {
    DB: d1(sqlite),
    // A fixed rate, so no test ever reaches the network. This is also the read path's
    // real shape: fxRate() only fetches when the KV entry is cold.
    FX_CACHE: { get: async () => '50', put: async () => {} },
    TELEGRAM_USER_ID: '1'
  };

  let schemaOk = false;
  await test('every migration applies cleanly, in order (generated columns, view, snapshots)', () => {
    const dir = path.join(__dirname, 'worker', 'migrations');
    fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .forEach((f) => sqlite.exec(fs.readFileSync(path.join(dir, f), 'utf8')));
    schemaOk = true;
  });
  // Awaited on purpose: every fixture and test below reads these tables, so a broken
  // migration must stop the file rather than produce 30 identical "no such table" lines.
  if (!schemaOk) { console.error('\nschema failed — nothing else can run'); return; }

  // ── fixtures ───────────────────────────────────────────────────────────────
  sqlite.exec(`
    INSERT INTO account_types (subtype, type) VALUES ('Savings','Asset'),('Credit','Liability'),('Shares','Asset');
    INSERT INTO accounts (id,name,currency,subtype,symbol,starting_balance_u,interest_frequency,interest_rate,credit_limit_u) VALUES
      (1,'Maya','PHP','Savings',NULL,1000000000,'Daily',0.04,NULL),
      (2,'Wise','USD','Savings',NULL,100000000,NULL,NULL,NULL),
      (3,'Card','PHP','Credit',NULL,0,NULL,NULL,50000000000),
      (4,'IBKR','SHARES','Shares','VOO',0,NULL,NULL,NULL);
    INSERT INTO categories (id,name,type,segment,description) VALUES
      (1,'Income: Salary','Income','Income','monthly pay'),
      (2,'Expense: Food','Expense','Essentials','groceries'),
      (3,'Investment: Growth','Transfer','Growth','into the broker'),
      (4,'Income: Interest','Income','Income','bank interest');
    INSERT INTO budgets (id,segment,period,target_type,target,currency) VALUES
      (1,'Essentials','Monthly','Percent',50,NULL),
      (2,'Growth','Quarterly','Amount',100,'USD');
    INSERT INTO recurring (id,description,currency,amount_u,fee_u,months_left,grp) VALUES
      (1,'Internet','PHP',1699000000,0,NULL,'Bills');
    INSERT INTO prices (symbol,priced_at,price,currency) VALUES ('VOO','2026-08-22',500,'USD');
  `);

  await describe('Writes', () => {
    test('createTransaction: stores, derives, and shapes the reply', async () => {
      const r = await api.createTransaction(
        { ID: 't1', Date: '2026-08-05', Category: 'Expense: Food', Account: 'Maya',
          Amount: 250.5, Description: 'Groceries' }, env);
      assert.strictEqual(r.status, 'success');
      assert.strictEqual(r.transaction.Amount, 250.5);
      assert.strictEqual(r.transaction['Amount (PHP)'], 250.5);
      assert.strictEqual(r.transaction.Month, '2026-Aug');   // the generated column, from SQLite
      assert.strictEqual(r.transaction.Type, 'Expense');
      assert.strictEqual(r.transaction.Segment, 'Essentials');
      assert.strictEqual(r.transaction.Currency, 'PHP');
    });

    test('createTransaction: a replayed ID is a duplicate, never a second row', async () => {
      const r = await api.createTransaction(
        { ID: 't1', Date: '2026-08-05', Category: 'Expense: Food', Account: 'Maya', Amount: 250.5 }, env);
      assert.strictEqual(r.status, 'duplicate');
      assert.strictEqual(r.transaction.ID, 't1');
      const n = sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id='t1'").get().n;
      assert.strictEqual(n, 1, 'the offline queue would have double-posted');
    });

    test('Period overrides the month the row reports under', async () => {
      await api.createTransaction(
        { ID: 't2', Date: '2026-07-31', Period: '2026-08', Category: 'Income: Salary',
          Account: 'Wise', Amount: 800 }, env);
      const row = sqlite.prepare("SELECT month, date, fx_rate, amount_php_u FROM transactions WHERE id='t2'").get();
      assert.strictEqual(row.month, '2026-Aug');            // reports forward
      assert.strictEqual(row.date, '2026-07-31');           // the cash date stays honest
      assert.strictEqual(row.fx_rate, 50);                  // stamped once, from the FX cache
      assert.strictEqual(row.amount_php_u, 40000000000);    // 800 x 50, ROUNDed then CAST
    });

    test('a non-Transfer category with a destination is refused, and the reverse too', async () => {
      await assert.rejects(() => api.createTransaction(
        { Category: 'Investment: Growth', Account: 'Maya', Amount: 10 }, env), /Transfer category requires/);
      await assert.rejects(() => api.createTransfer(
        { Category: 'Expense: Food', Account: 'Maya', ToAccount: 'IBKR', Amount: 10 }, env), /Only a Transfer category/);
    });

    test('createTransfer moves both sides in one row', async () => {
      const r = await api.createTransfer(
        { ID: 'x1', Date: '2026-08-10', Category: 'Investment: Growth', Account: 'Maya',
          ToAccount: 'IBKR', Amount: 5000, ToAmount: 0.2 }, env);
      assert.strictEqual(r.status, 'success');
      assert.strictEqual(r.transaction.ToAccount, 'IBKR');
      assert.strictEqual(r.transaction.ToAmount, 0.2);      // a fractional share quantity
      assert.strictEqual(r.transaction.ToCurrency, 'SHARES');
    });

    test('updateTransaction mirrors ToAmount on a same-currency transfer', async () => {
      await api.createTransfer({ ID: 'x2', Date: '2026-08-11', Category: 'Investment: Growth',
                                 Account: 'Maya', ToAccount: 'Card', Amount: 100 }, env);
      const r = await api.updateTransaction({ ID: 'x2', Amount: 150 }, env);
      assert.strictEqual(r.transaction.ToAmount, 150, 'the destination kept crediting the old figure');
    });

    test('updateAccount writes only whitelisted fields, in micros', async () => {
      const r = await api.updateAccount({ Name: 'Card', 'Credit Limit': 60000, Notes: 'main card',
                                          Nonsense: 'ignored' }, env);
      assert.strictEqual(r.fieldsWritten, 2);
      const a = sqlite.prepare("SELECT credit_limit_u, notes FROM accounts WHERE name='Card'").get();
      assert.strictEqual(a.credit_limit_u, 60000000000);
      await assert.rejects(() => api.updateAccount({ Name: 'Nope', Notes: 'x' }, env), /Unknown Account/);
    });

    test('a write bumps the data version', async () => {
      const before = (await api.getDataVersion({}, env)).version;
      await api.createTransaction({ ID: 't3', Date: '2026-08-12', Category: 'Expense: Food',
                                    Account: 'Card', Amount: 1200 }, env);
      assert.ok((await api.getDataVersion({}, env)).version > before);
    });
  });

  await describe('Reads', () => {
    test('getAccounts: liability sign, available credit, share pricing', async () => {
      const by = Object.fromEntries((await api.getAccounts({}, env)).accounts.map((a) => [a.name, a]));
      // Maya: 1000 start, -250.50 food, -5000 growth, -150 to Card
      assert.strictEqual(by.Maya.balanceNative, 1000 - 250.5 - 5000 - 150);
      assert.strictEqual(by.Maya.balancePhp, by.Maya.balanceNative);
      // Wise: 100 start + 800 salary, in USD, shown at 50
      assert.strictEqual(by.Wise.balanceNative, 900);
      assert.strictEqual(by.Wise.balancePhp, 45000);
      // Card is a liability: 1200 charged, 150 paid in -> 1050 owed, positive as shown
      assert.strictEqual(by.Card.balancePhp, 1050);
      assert.strictEqual(by.Card.netWorthPhp, -1050);
      assert.strictEqual(by.Card.availableCredit, 60000 - 1050);
      // IBKR holds 0.2 shares at $500, at 50 PHP/USD
      assert.strictEqual(by.IBKR.balanceNative, 0.2);
      assert.strictEqual(by.IBKR.balancePhp, 5000);
      assert.ok(by.IBKR.isShares && by.IBKR.isInvestment);
    });

    test('listTransactions: filters, ordering and the total', async () => {
      const all = await api.listTransactions({ limit: 100 }, env);
      assert.strictEqual(all.total, all.transactions.length);
      assert.ok(all.transactions[0].Date >= all.transactions[all.transactions.length - 1].Date, 'not newest-first');
      assert.strictEqual((await api.listTransactions({ month: '2026-Aug', type: 'Expense' }, env)).total, 2);
      assert.strictEqual((await api.listTransactions({ account: 'IBKR' }, env)).total, 1, 'ToAccount must match too');
      assert.strictEqual((await api.listTransactions({ search: 'grocer' }, env)).total, 1);
      assert.strictEqual((await api.listTransactions({ id: 't1' }, env)).total, 1);
    });

    test('getBudgets: percent of income, a USD cap at live FX, transfers counted', async () => {
      const b = await api.getBudgets({ month: '2026-Aug' }, env);
      const by = Object.fromEntries(b.budgets.map((x) => [x.segment, x]));
      assert.strictEqual(b.incomePhp, 47200);
      assert.strictEqual(by.Essentials.targetPhp, 23600);        // 50% of 47200
      assert.strictEqual(by.Essentials.actualPhp, 250.5 + 1200);  // both Expense rows
      assert.strictEqual(by.Growth.targetPhp, 5000);             // $100 x 50
      assert.deepStrictEqual(by.Growth.window, ['2026-Jul', '2026-Aug', '2026-Sep']);
      assert.strictEqual(by.Growth.actualPhp, 5000 + 150, 'a Transfer must draw down its segment');
      assert.ok(b.essentialsRewards, 'the roll-up is missing');
    });

    test('getBudgets: a USD budget is measured in dollars, not round-tripped through PHP', async () => {
      const by = Object.fromEntries((await api.getBudgets({ month: '2026-Aug' }, env))
        .budgets.map((x) => [x.segment, x]));
      // The dollar row counts its own $100; the peso row in the same segment is the
      // only part the live rate touches (PHP 150 / 50).
      assert.strictEqual(by.Growth.currency, 'USD');
      assert.strictEqual(by.Growth.targetNative, 100);
      assert.strictEqual(by.Growth.actualNative, 103);
      assert.strictEqual(by.Growth.remainingNative, -3);
      assert.strictEqual(by.Growth.isOver, true);
      assert.strictEqual(by.Growth.pctUsed, 103);
      // A Percent target is a share of PHP income, so it stays in pesos.
      assert.strictEqual(by.Essentials.currency, 'PHP');
      assert.strictEqual(by.Essentials.targetNative, by.Essentials.targetPhp);
      assert.strictEqual(by.Essentials.actualNative, by.Essentials.actualPhp);
    });

    test('a dollar-funded row holds still in a USD budget when the peso moves', async () => {
      // The fixture's Growth rows are all peso-sourced, so add the case this is
      // about: the real Growth budget is funded by a USD->USD transfer.
      await api.createTransfer({ ID: 'usd-growth', Date: '2026-08-12', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'IBKR', Amount: 100, ToAmount: 0.2 }, env);
      try {
        const at = async (rate) => {
          const e = Object.assign({}, env, { FX_CACHE: { get: async () => String(rate), put: async () => {} } });
          return Object.fromEntries((await api.getBudgets({ month: '2026-Aug' }, e))
            .budgets.map((x) => [x.segment, x])).Growth;
        };
        const [a, b2] = [await at(50), await at(70)];
        assert.strictEqual(a.targetNative, 100);
        assert.strictEqual(b2.targetNative, 100, 'the plan is $100 at any rate');
        // The $100 leg counts as $100 at both rates. Only the peso rows reprice:
        // 5150/50 = 103 vs 5150/70 = 73.57.
        assert.strictEqual(a.actualNative, 203);
        assert.ok(Math.abs(b2.actualNative - 173.57) < 0.01, 'got ' + b2.actualNative);
        // The PHP view is unchanged: fx_rate is stamped at write time, so the dollar
        // leg stays at the 50 it was written with whatever the read rate is.
        assert.strictEqual(a.actualPhp, b2.actualPhp);
        assert.strictEqual(a.actualPhp, 5150 + 100 * 50);
        assert.ok(a.targetPhp !== b2.targetPhp, 'the PHP view of the target still follows the rate');
      } finally {
        await api.deleteTransaction({ ID: 'usd-growth' }, env);
      }
    });

    test('getDashboard: aggregates, cash flow window, recent rows', async () => {
      const d = await api.getDashboard({ month: '2026-Aug' }, env);
      assert.strictEqual(d.month, '2026-Aug');
      assert.strictEqual(d.cashflow.length, 6);
      assert.strictEqual(d.cashflow[5].month, '2026-Aug');
      assert.strictEqual(d.cashflow[0].month, '2026-Mar');
      assert.strictEqual(d.cashflow[5].income, 40000);           // the salary, in PHP
      assert.strictEqual(d.cashflow[5].expense, 250.5 + 1200);
      assert.strictEqual(d.spendBySegment.Essentials, 250.5 + 1200);
      assert.ok(d.recentTransactions.length > 0);
      assert.ok(Math.abs(d.netWorth - (d.assets + d.liabilities)) < 0.01, 'liabilities are already negative');
    });

    test('snapshotNetWorth records this month; getDashboard serves the history', async () => {
      const snap = await api.snapshotNetWorth(env);
      const now = dbm.manilaMonth();
      assert.strictEqual(snap.month, now);
      const dash = await api.getDashboard({}, env);
      assert.ok(Math.abs(snap.netWorth - dash.netWorth) < 0.01, 'snapshot equals the live net worth');
      // The live month is deliberately absent — the chart uses live netWorth there.
      assert.ok(!(now in dash.netWorthHistory), 'live month is excluded from netWorthHistory');
      // A closed month's snapshot IS served (123 PHP = 123_000_000 micros).
      const past = now === '2026-Jul' ? '2026-Jun' : '2026-Jul';
      sqlite.exec("INSERT INTO nw_snapshots (month,net_worth_u,assets_u,liabilities_u,shares_u,taken_at) VALUES ('" +
        past + "',123000000,123000000,0,45000000,'2026-01-01T00:00:00Z')");
      const d2 = await api.getDashboard({ month: '2026-Aug' }, env);
      assert.strictEqual(d2.netWorthHistory[past], 123, 'past snapshot appears in history');
      assert.strictEqual(d2.sharesHistory[past], 45, 'the invested subset ships alongside for the liquid/stacked split');
    });

    test('getBootstrap hydrates everything the app needs', async () => {
      const b = await api.getBootstrap({}, env);
      ['owner', 'baseCurrency', 'categories', 'accounts', 'budgets', 'recurring', 'fxUsdPhp', 'minMonth', 'version']
        .forEach((k) => assert.ok(k in b, 'missing ' + k));
      assert.strictEqual(b.minMonth, '2026-Jul');
      assert.strictEqual(b.recurring[0].Description, 'Internet');
      assert.strictEqual(b.recurring[0].Amount, 1699);
      assert.strictEqual(b.categories['Expense: Food'].Segment, 'Essentials');
    });

    test('getInvestments: quarterly pulse groups buys, runway is the cash-like pool', async () => {
      // A USD buy in an older quarter, next to fixture x1 (2026-08-10 Maya->IBKR).
      await api.createTransfer({ ID: 'x3', Date: '2026-04-05', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'IBKR', Amount: 100, ToAmount: 0.05 }, env);
      // An expense in the last closed month, so the runway average is deterministic.
      const now = dbm.parseMonthKey(dbm.manilaMonth());
      const prev = dbm.shiftMonth(now.y, now.m, -1);
      await api.createTransaction({ ID: 't-rw', Date: prev.y + '-' + String(prev.m).padStart(2, '0') + '-15',
                                    Category: 'Expense: Food', Account: 'Maya', Amount: 300 }, env);

      const inv = await api.getInvestments({}, env);
      assert.match(inv.pulse.currentQuarter, /^\d{4}-Q[1-4]$/);
      const q = Object.fromEntries(inv.pulse.quarters.map((x) => [x.quarter, x]));
      assert.ok(q['2026-Q3'] && q['2026-Q3'].buys.some((b) => b.symbol === 'IBKR' && b.amount === 5000 && b.currency === 'PHP'));
      assert.strictEqual(q['2026-Q2'].totalUsd, 100, 'USD buys total per quarter');
      assert.strictEqual(q['2026-Q2'].buys[0].quantity, 0.05);
      assert.ok(inv.pulse.quarters[0].quarter > inv.pulse.quarters[inv.pulse.quarters.length - 1].quarter, 'newest first');

      // Runway: Maya + Wise count, IBKR (invested) is excluded, Card is subtracted.
      const by = Object.fromEntries((await api.getAccounts({}, env)).accounts.map((a) => [a.name, a]));
      const expected = Math.round((by.Maya.balancePhp + by.Wise.balancePhp - by.Card.balancePhp) * 100) / 100;
      assert.strictEqual(inv.runway.efPhp, expected);
      assert.strictEqual(inv.runway.avgMonthlyExpensePhp, 100);   // 300 over 3 closed months
      assert.strictEqual(inv.runway.targetPhp, 400);
      assert.strictEqual(inv.runway.months, Math.round(expected / 100 * 10) / 10);
      // Sums to 85, not 100: Stability came out in v2.3.0 and the missing 15 is the EF
      // residue the runway card measures instead. The assertion is the guard against it
      // being "fixed" back to 100 or the dead segment creeping in again.
      assert.deepStrictEqual(inv.segmentTargets, { Essentials: 50, Rewards: 10, Growth: 25 });
    });
  });

  await describe('Ledger (Tax screen)', () => {
    test('the ledger view derives from the linked transaction', async () => {
      const added = await api.appendLedgerRow({ 'Transaction ID': 't2' }, env);
      await api.updateLedgerCell({ row: added.row, header: 'BSP Reference Rate', value: '56.5' }, env);
      const l = await api.getLedger({}, env);
      const row = l.rows.find((r) => r.__row === added.row);
      assert.strictEqual(row['Date Received'], '2026-07-31');
      assert.strictEqual(row['Reporting Period'], '2026-Aug');   // the derived month, not the raw Period
      assert.strictEqual(row['Wise Amount'], 800);
      assert.strictEqual(row['Total Income'], 45200);            // 800 x 56.5
      assert.strictEqual(row['8% Tax'], 3616);
      assert.deepStrictEqual(l.derived.includes('Total Income'), true);
      assert.strictEqual(l.unlinked.length, 0, 'the salary is linked now');
    });

    test('a derived ledger column cannot be edited', async () => {
      await assert.rejects(() => api.updateLedgerCell({ row: 1, header: 'Total Income', value: 1 }, env),
        /formula-derived/);
    });

    test('deleting the transaction leaves a warning row, not a broken delete', async () => {
      await api.deleteTransaction({ ID: 't2' }, env);
      const row = (await api.getLedger({}, env)).rows[0];
      assert.strictEqual(row['Date Received'], '⚠ transaction deleted');
      await api.deleteLedgerRow({ row: row.__row }, env);
      assert.strictEqual((await api.getLedger({}, env)).rows.length, 0);
    });
  });

  await describe('Admin grid and export', () => {
    test('listTable converts micros and reports what is editable', async () => {
      const t = await api.listTable({ table: 'accounts' }, env);
      assert.strictEqual(t.rows.find((r) => r.name === 'Card').credit_limit_u, 60000);
      assert.ok(t.editable.includes('color'));
      assert.ok(t.money.includes('starting_balance_u'));
    });

    // The Admin picker draws its buttons from this list, so it is the whole set or the
    // screen loses a table. Every name must survive a round trip back through listTable —
    // a typo here would ship a button that answers "Unknown table" when pressed.
    test('listTable ships the table list the Admin picker is drawn from', async () => {
      const t = await api.listTable({ table: 'accounts' }, env);
      assert.ok(Array.isArray(t.tables) && t.tables.length > 1);
      assert.strictEqual(t.tables[0], 'accounts', 'the landing table must be first');
      for (const name of t.tables) {
        assert.strictEqual((await api.listTable({ table: name }, env)).table, name);
      }
    });

    test('the whitelist is a real boundary', async () => {
      await assert.rejects(() => api.listTable({ table: 'sqlite_master' }, env), /Unknown table/);
      await assert.rejects(() => api.updateTableCell(
        { table: 'transactions', pk: 't1', column: 'amount_u', value: 1 }, env), /not editable/);
      await assert.rejects(() => api.insertTableRow({ table: 'transactions', row: { id: 'z' } }, env), /read-only/);
      // nw_snapshots is fully read-only: no insert, no delete, money cols reported as PHP.
      const nw = await api.listTable({ table: 'nw_snapshots' }, env);
      assert.strictEqual(nw.deletable, false);
      assert.deepStrictEqual(nw.editable, []);
      await assert.rejects(() => api.insertTableRow({ table: 'nw_snapshots', row: { month: 'x' } }, env), /read-only/);
      await assert.rejects(() => api.deleteTableRow({ table: 'nw_snapshots', pk: '2026-Aug' }, env), /read-only/);
    });

    test('updateTableCell and insertTableRow round-trip through micros', async () => {
      await api.updateTableCell({ table: 'accounts', pk: 1, column: 'starting_balance_u', value: '2000' }, env);
      assert.strictEqual(sqlite.prepare('SELECT starting_balance_u u FROM accounts WHERE id=1').get().u, 2000000000);
      const ins = await api.insertTableRow({ table: 'categories', row: { name: 'Expense: Fun', type: 'Expense', segment: 'Rewards' } }, env);
      assert.ok(ins.pk);
      await api.deleteTableRow({ table: 'categories', pk: ins.pk }, env);
    });

    test('getExportAll dumps every whitelisted table', async () => {
      const e = await api.getExportAll({}, env);
      ['accounts', 'categories', 'transactions', 'ledger', 'meta', 'prices'].forEach((t) =>
        assert.ok(Array.isArray(e.tables[t]), 'missing table ' + t));
      assert.ok(e.exportedAt);
    });
  });

  await describe('Bulk', () => {
    test('bulk update and delete report what they skipped', async () => {
      const u = await api.bulkUpdateTransactions(
        { ids: ['t1', 'nope'], patch: { Category: 'Expense: Food', Description: 'bulk' } }, env);
      assert.strictEqual(u.updated, 1);
      assert.deepStrictEqual(u.skipped, ['nope']);
      const d = await api.bulkDeleteTransactions({ ids: ['t3', 'nope'] }, env);
      assert.strictEqual(d.deleted, 1);
      assert.deepStrictEqual(d.skipped, ['nope']);
    });

    test('the other whitelist shapes work too (composite and text primary keys)', async () => {
      const p = await api.listTable({ table: 'prices' }, env);
      assert.ok(p.rows[0].rowid, 'prices needs a rowid handle — its key is composite');
      const m = await api.listTable({ table: 'meta' }, env);
      assert.ok(m.rows.some((r) => r.key === 'data_version'));
      await api.updateTableCell({ table: 'meta', pk: 'monthly_income_php', column: 'value', value: '50000' }, env);
      assert.strictEqual((await api.getBudgets({ month: '2026-Aug' }, env)).incomePhp, 50000);
      // transactions is read + delete: the escape hatch for a row the UI cannot reach.
      await api.deleteTableRow({ table: 'transactions', pk: 'x2' }, env);
      assert.strictEqual((await api.listTransactions({ id: 'x2' }, env)).total, 0);
    });
  });

  // The Worker's own fetch(): auth, the GET/POST split, and the error shape. Driven with
  // real Request objects, because the dispatch is the one place a route can go missing.
  const worker = (await load('worker.js')).default;
  const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const wenv = Object.assign({}, env, { APP_PASS: 'pw', INGEST_TOKEN: 'tok' });
  const ctx = { waitUntil: () => {} };
  const call = async (url, init = {}) => {
    const res = await worker.fetch(new Request('https://x' + url, init), wenv, ctx);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await describe('HTTP layer', () => {
    test('/api is closed without a credential and open with either one', async () => {
      assert.strictEqual((await call('/api?action=getDataVersion')).status, 401);
      const cookie = { Cookie: 'ft_auth=' + await hex('pw') };
      assert.strictEqual((await call('/api?action=getDataVersion', { headers: cookie })).body.status, 'success');
      const bearer = { Authorization: 'Bearer tok' };
      assert.strictEqual((await call('/api?action=getExportAll', { headers: bearer })).body.status, 'success');
    });

    test('/api enforces the GET/POST split and answers errors as JSON 200', async () => {
      const cookie = { Cookie: 'ft_auth=' + await hex('pw'), 'Content-Type': 'application/json' };
      const wrongMethod = await call('/api?action=createTransaction', { headers: cookie });
      assert.match(wrongMethod.body.message, /requires POST/);
      const unknown = await call('/api?action=nope', { headers: cookie });
      assert.ok(Array.isArray(unknown.body.knownActions));
      // A handler that throws must come back as {status:'error'} with HTTP 200 — gs()
      // reads that as a final server rejection, and the offline queue depends on it.
      const bad = await call('/api', { method: 'POST', headers: cookie,
        body: JSON.stringify({ action: 'deleteTransaction', ID: 'does-not-exist' }) });
      assert.strictEqual(bad.status, 200);
      assert.strictEqual(bad.body.status, 'error');
      assert.match(bad.body.message, /No transaction/);
    });
  });
})().catch((err) => { console.error(err); process.exit(1); });
