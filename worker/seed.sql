-- seed.sql — INVENTED data for a local database. `npm run dev:seed`.
--
-- WHY: a fresh checkout's local D1 is empty, and `npm run dev:pull` (the real ledger)
-- is denied to agents and cannot travel to a cloud session. Without this, every screen
-- in `wrangler dev` renders a zero. This file is modelled on the real database's SHAPE
-- — the same six subtypes, the same category taxonomy, a USD contract salary into Wise,
-- the Wise -> IBKR growth funding, broker buys, a credit card that gets paid off, and
-- receivables that start negative — with every person, amount and balance invented.
--
-- LOCAL ONLY. It DELETEs before it inserts. `npm run dev:seed` hardcodes `--local`;
-- never point it at --remote.
--
-- Dates are relative to today, so the app always opens on a populated current month:
-- (mo, dy) is "dy-th day of the month mo months back", clamped to today so nothing is
-- future-dated. A row therefore has no fixed date and the seed never goes stale.
--
-- `test-api.js` loads this file against the real migrated schema, so a seed that stops
-- matching the schema fails `npm test` rather than failing an agent at 2am.

DELETE FROM email_quotes;
DELETE FROM ledger;
DELETE FROM nw_snapshots;
DELETE FROM prices;
DELETE FROM transactions;
DELETE FROM recurring;
DELETE FROM budgets;
DELETE FROM accounts;
DELETE FROM categories;
DELETE FROM account_types;

INSERT INTO account_types (subtype, type) VALUES
  ('Liquid','Asset'), ('EF','Asset'), ('Receivable','Asset'),
  ('For Investment','Asset'), ('Stocks','Asset'), ('Credit','Liability');

-- Institutions are real (they are already all over this repo); the two receivables are
-- invented people. Starting balances are small — the balances come from the ledger.
INSERT INTO accounts (id,name,currency,subtype,symbol,starting_balance_u,interest_frequency,interest_rate,credit_limit_u,color) VALUES
  (1, 'Cash',                  'PHP',   'Liquid',         NULL,        400000000, NULL,     NULL,   NULL,          '#e7eaf0'),
  (2, 'MariBank',              'PHP',   'Liquid',         NULL,                0, NULL,     0.0325, NULL,          '#ffb454'),
  (3, 'BPI Banko',             'PHP',   'Liquid',         NULL,                0, 'Monthly',0.05,   NULL,          '#ff6b6b'),
  (4, 'RCBC Hexagon Platinum', 'PHP',   'Credit',         NULL,                0, NULL,     NULL,   100000000000,  NULL),
  (5, 'GCash',                 'PHP',   'Liquid',         NULL,        456550000, NULL,     NULL,   NULL,          '#5b8cff'),
  (6, 'CIMB',                  'PHP',   'Liquid',         NULL,          3800000, 'Monthly',0.026,  NULL,          '#5b8cff'),
  (7, 'Wise',                  'USD',   'Liquid',         NULL,         20000000, NULL,     NULL,   NULL,          '#a78bfa'),
  (8, 'Wise Savings',          'USD',   'EF',             NULL,                0, NULL,     NULL,   NULL,          '#a78bfa'),
  (9, 'IBKR',                  'USD',   'For Investment', NULL,                0, NULL,     NULL,   NULL,          '#f472b6'),
  (10,'SPayLater',             'PHP',   'Credit',         NULL,                0, NULL,     0,      4000000000,    NULL),
  (11,'Alex',                  'PHP',   'Receivable',     NULL,      -8043630000, NULL,     NULL,   NULL,          NULL),
  (12,'Kuya Ramon',            'PHP',   'Receivable',     NULL,      -2000000000, NULL,     NULL,   NULL,          NULL),
  (13,'VWRA',                  'Shares','Stocks',         'VWRA',              0, NULL,     NULL,   NULL,          NULL),
  (14,'APH',                   'Shares','Stocks',         'APH',               0, NULL,     NULL,   NULL,          NULL),
  (15,'IB01',                  'Shares','EF',             'IB01',              0, NULL,     NULL,   NULL,          NULL);

-- The taxonomy is the app's configuration, not personal data: kept as it really is.
-- The descriptions matter — the Gemini prompt inlines them, so the bot's category
-- discipline (the Growth/Internal split especially) lives in this table.
INSERT INTO categories (id,name,type,segment,description) VALUES
  (1, 'Income: Salary',              'Income',  NULL,        'Income from job / Contract Income'),
  (2, 'Income: Side Hustle',         'Income',  NULL,        'Other freelance income'),
  (3, 'Income: Interest',            'Income',  NULL,        'Bank/investment interest'),
  (4, 'Income: Cashback',            'Income',  NULL,        'Bank/card rewards and vouchers'),
  (5, 'Income: Other',               'Income',  NULL,        'Any other income'),
  (6, 'Food: Groceries',             'Expense', 'Essentials','Supermarket / wet market'),
  (7, 'Food: Daily Meals',           'Expense', 'Essentials','Canteen, fast food (McDo, Jollibee, KFC), solo meals'),
  (8, 'Food: Coffee/Snacks',         'Expense', 'Rewards',   'Cafe, convenience store snacks'),
  (9, 'Food: Dining Out',            'Expense', 'Rewards',   'Experience meals. Dates, nice dinners'),
  (10,'Food: Bar/Drinks',            'Expense', 'Rewards',   'Clubs, alcohol drinks'),
  (11,'Transport: Fuel',             'Expense', 'Essentials','Gas/Diesel for the car'),
  (12,'Transport: Ride Hailing',     'Expense', 'Essentials','Grab, Move It, etc.'),
  (13,'Transport: Parking/Tolls',    'Expense', 'Essentials','EasyTrip load, parking fees'),
  (14,'Transport: Public Commute',   'Expense', 'Essentials','Jeep, Bus, Train, Tricycle'),
  (15,'Transport: Car Maintenance',  'Expense', 'Essentials','Oil changes, repairs, LTO registration, car wash'),
  (16,'Utilities: Electric/Water',   'Expense', 'Essentials','Monthly electric or water bills'),
  (17,'Utilities: Internet/Mobile',  'Expense', 'Essentials','Connectivity bills and mobile data'),
  (18,'Housing: Maintenance',        'Expense', 'Essentials','Repairs, upkeep'),
  (19,'Social: Gifts',               'Expense', 'Rewards',   'Specific gifts. Partner name: Alex'),
  (20,'Social: Dates',               'Expense', 'Rewards',   'Cinema, activities, specific couple expenses'),
  (21,'Social: Treating People',     'Expense', 'Rewards',   'Food/coffee for others, parties, treating friends/partner'),
  (22,'Social: Support',             'Expense', 'Essentials','Other essential expenses for friends/partner (transpo, help in bills)'),
  (23,'Family: Support',             'Expense', 'Essentials','Obligatory family cash/support'),
  (24,'Family: Gifts',               'Expense', 'Rewards',   'Specific gifts for family'),
  (25,'Shopping: Household',         'Expense', 'Essentials','Home supplies, cleaning'),
  (26,'Shopping: Personal Care',     'Expense', 'Essentials','Toiletries, skincare, hygiene'),
  (27,'Shopping: Clothing',          'Expense', 'Rewards',   'New clothes, shoes (wants)'),
  (28,'Shopping: Electronics',       'Expense', 'Rewards',   'Big or small electronics/gadgets'),
  (29,'Shopping: Hobbies',           'Expense', 'Rewards',   'Hobbies, Gaming'),
  (30,'Shopping: Software Tools',    'Expense', 'Essentials','Apps, Work tools, Cloud storage'),
  (31,'Shopping: Other Essentials',  'Expense', 'Essentials','Other essential shopping'),
  (32,'Shopping: Other Rewards',     'Expense', 'Rewards',   'Other reward shopping'),
  (33,'Leisure: Travel',             'Expense', 'Rewards',   'Plane ticket, leisure travel expense, accomodation, etc.'),
  (34,'Services: Professional',      'Expense', 'Essentials','Haircut, laundry, package delivery (Lalamove) etc.'),
  (35,'Health: Medical',             'Expense', 'Essentials','Checkups, medicines, vitamins.'),
  (36,'Health: Fitness',             'Expense', 'Essentials','Gym fees, sports equipment (maintenance).'),
  (37,'Gov: Contributions',          'Expense', NULL,        'SSS, PhilHealth, Pag-IBIG (Voluntary).'),
  (38,'Gov: Fees',                   'Expense', 'Essentials','Other government fees'),
  (39,'Financial: Bank Fees',        'Expense', 'Essentials','Transfer fees, charges'),
  (40,'Financial: Untracked Change', 'Expense', 'Essentials','Untracked change'),
  (41,'Financial: Lost money',       'Expense', 'Essentials','Lost money'),
  (42,'Financial: Credit Payment',   'Transfer',NULL,        'Paying back credit'),
  (43,'Financial: Loan',             'Transfer',NULL,        'Loan'),
  (44,'Investment: Growth',          'Transfer','Growth',    'Growth investing funding: the monthly $200 moved to the broker (Wise to IBKR). Funding leg only'),
  (45,'Transfer: Internal',          'Transfer',NULL,        'Moves between own accounts, including broker buys (IBKR to a ticker or IB01) and EF parking'),
  (46,'Transfer: Essential',         'Transfer','Essentials','Do not use unless explicitly stated');

-- Deliberately NO Stability row: the EF accrues as unspent residue and the runway card
-- is its only measure. See CLAUDE.md.
INSERT INTO budgets (id,segment,period,target_type,target,currency,notes) VALUES
  (1,'Essentials','Monthly','Percent',50,NULL,NULL),
  (2,'Rewards',   'Monthly','Percent',10,NULL,NULL),
  (3,'Growth',    'Monthly','Amount', 200,'USD','monthly parking target: $200 to IBKR');

INSERT INTO recurring (id,description,currency,amount_u,fee_u,months_left,grp) VALUES
  (1,'Pag-IBIG',           'PHP',   400000000,  5000000, NULL, 'Govt'),
  (2,'SSS',                'PHP',   760000000,  8000000, NULL, 'Govt'),
  (3,'PhilHealth',         'PHP',   500000000, 15000000, NULL, 'Govt'),
  (4,'BIR',                'PHP',  2000000000,     NULL, NULL, 'Govt'),
  (5,'Water Bill',         'PHP',  2000000000,     NULL, NULL, NULL),
  (6,'Fibre Internet',     'PHP',  1699000000,     NULL, NULL, NULL),
  (7,'Laptop instalment',  'PHP',  4711180000,     NULL,    8, NULL);

-- Two dates per symbol: `prices` is history by design, and the investments screen reads
-- the latest row per symbol.
INSERT INTO prices (symbol,priced_at,price,currency)
SELECT symbol, date('now', days || ' days'), price, 'USD' FROM (
  WITH p(symbol,days,price) AS (VALUES
    ('VWRA',-8,191.20), ('VWRA',-1,194.06),
    ('APH', -8,158.90), ('APH', -1,161.34),
    ('IB01',-8,121.10), ('IB01',-1,121.64))
  SELECT * FROM p);

-- ── the ledger ──────────────────────────────────────────────────────────────
-- (mo, dy) = month offset and day of month. pmo, when set, is the month offset the
-- Period override points at. Amounts are decimals here and become micros in the SELECT.
WITH t(id, mo, dy, pmo, cat, descr, acct, amt, fx, dst, toamt) AS (VALUES
  -- ── two months back ──
  ('seed-m2-salary',  -2, 5,  NULL, 1,  'Contract invoice',            7,  800.00,  60.90, NULL, NULL),
  ('seed-m2-conv',    -2, 6,  NULL, 45, 'Wise to BPI',                 7,  480.00,  60.83, 3,  29198.40),
  ('seed-m2-fund',    -2, 7,  NULL, 44, 'Monthly growth funding',      7,  300.00,  60.57, 9,    300.00),
  ('seed-m2-buyvwra', -2, 8,  NULL, 45, 'Buy VWRA',                    9,  149.39,  60.50, 13,     0.78),
  ('seed-m2-buyib01', -2, 8,  NULL, 45, 'Park EF in IB01',             9,  150.00,  60.50, 15,     1.24),
  ('seed-m2-groc',    -2, 9,  NULL, 6,  'Supermarket run',             3, 3480.00,  NULL,  NULL, NULL),
  ('seed-m2-meal1',   -2, 10, NULL, 7,  'Lunch at the canteen',        1,  180.00,  NULL,  NULL, NULL),
  ('seed-m2-meal2',   -2, 14, NULL, 7,  'Fast food',                   5,  295.00,  NULL,  NULL, NULL),
  ('seed-m2-coffee',  -2, 11, NULL, 8,  'Cafe',                        5,  185.00,  NULL,  NULL, NULL),
  ('seed-m2-fuel',    -2, 12, NULL, 11, 'Gas',                         3, 1500.00,  NULL,  NULL, NULL),
  ('seed-m2-elec',    -2, 15, NULL, 16, 'Electric bill',               3, 3517.00,  NULL,  NULL, NULL),
  ('seed-m2-net',     -2, 15, NULL, 17, 'Fibre internet',              3, 1699.00,  NULL,  NULL, NULL),
  ('seed-m2-gadget',  -2, 17, NULL, 28, 'Mechanical keyboard',         4, 8500.00,  NULL,  NULL, NULL),
  ('seed-m2-family',  -2, 18, NULL, 23, 'Family support',              2, 3000.00,  NULL,  NULL, NULL),
  ('seed-m2-lend',    -2, 19, NULL, 43, 'Lent to Kuya Ramon',          3, 3500.00,  NULL,  12,  3500.00),
  ('seed-m2-move',    -2, 20, NULL, 45, 'BPI to MariBank',             3, 5000.00,  NULL,  2,   5000.00),
  ('seed-m2-move2',   -2, 20, NULL, 45, 'BPI to GCash',                3, 2500.00,  NULL,  5,   2500.00),
  ('seed-m2-move3',   -2, 21, NULL, 45, 'Cash withdrawal',             3, 1500.00,  NULL,  1,   1500.00),
  ('seed-m2-int',     -2, 28, NULL, 3,  'Monthly interest',            2,   62.40,  NULL,  NULL, NULL),
  -- ── one month back ──
  ('seed-m1-salary',  -1, 5,  NULL, 1,  'Contract invoice',            7,  800.00,  61.10, NULL, NULL),
  ('seed-m1-conv',    -1, 6,  NULL, 45, 'Wise to BPI',                 7,  480.00,  61.02, 3,  29289.60),
  ('seed-m1-fund',    -1, 7,  NULL, 44, 'Monthly growth funding',      7,  300.00,  61.00, 9,    300.00),
  ('seed-m1-buyaph',  -1, 8,  NULL, 45, 'Buy APH',                     9,  149.91,  61.35, 14,     0.94),
  ('seed-m1-buyib01', -1, 8,  NULL, 45, 'Park EF in IB01',             9,  150.00,  61.35, 15,     1.24),
  ('seed-m1-move',    -1, 6,  NULL, 45, 'BPI to MariBank',             3, 6000.00,  NULL,  2,   6000.00),
  ('seed-m1-move2',   -1, 7,  NULL, 45, 'BPI to GCash',                3, 2500.00,  NULL,  5,   2500.00),
  ('seed-m1-move3',   -1, 8,  NULL, 45, 'Cash withdrawal',             3, 1500.00,  NULL,  1,   1500.00),
  ('seed-m1-groc',    -1, 9,  NULL, 6,  'Supermarket run',             3, 4620.00,  NULL,  NULL, NULL),
  ('seed-m1-meal1',   -1, 10, NULL, 7,  'Lunch with the team',         1,  260.00,  NULL,  NULL, NULL),
  ('seed-m1-meal2',   -1, 16, NULL, 7,  'Rice bowl',                   5,  210.00,  NULL,  NULL, NULL),
  ('seed-m1-coffee',  -1, 11, NULL, 8,  'Cold brew',                   5,  240.00,  NULL,  NULL, NULL),
  ('seed-m1-dine',    -1, 13, NULL, 9,  'Anniversary dinner',          4, 2400.00,  NULL,  NULL, NULL),
  ('seed-m1-ride',    -1, 13, NULL, 12, 'Grab home',                   5,  268.00,  NULL,  NULL, NULL),
  ('seed-m1-fuel',    -1, 14, NULL, 11, 'Gas',                         3, 1780.00,  NULL,  NULL, NULL),
  ('seed-m1-elec',    -1, 15, NULL, 16, 'Electric bill',               3, 4103.00,  NULL,  NULL, NULL),
  ('seed-m1-net',     -1, 15, NULL, 17, 'Fibre internet',              3, 1699.00,  NULL,  NULL, NULL),
  ('seed-m1-refund',  -1, 19, NULL, 28, 'Keyboard returned - refund',  4,-1200.00,  NULL,  NULL, NULL),
  ('seed-m1-cardpay', -1, 20, NULL, 42, 'RCBC statement',              3, 9700.00,  NULL,  4,   9700.00),
  ('seed-m1-treat',   -1, 21, NULL, 21, 'Coffee for the team',         5,  450.00,  NULL,  NULL, NULL),
  ('seed-m1-support', -1, 22, NULL, 22, 'Alex commute',                2,  340.00,  NULL,  NULL, NULL),
  ('seed-m1-repay',   -1, 24, NULL, 43, 'Kuya Ramon repaid',           12,3500.00,  NULL,  3,   3500.00),
  ('seed-m1-cash',    -1, 25, NULL, 4,  'Card rebate',                 5,  120.00,  NULL,  NULL, NULL),
  ('seed-m1-int',     -1, 28, NULL, 3,  'Monthly interest',            2,   71.85,  NULL,  NULL, NULL),
  -- ── this month ──
  ('seed-m0-salary',  0,  5,  NULL, 1,  'Contract invoice',            7,  800.00,  61.40, NULL, NULL),
  ('seed-m0-late',    0,  2,  -1,   2,  'Late side project payout',    7,  150.00,  61.40, NULL, NULL),
  ('seed-m0-conv',    0,  6,  NULL, 45, 'Wise to BPI',                 7,  480.00,  61.31, 3,  29428.80),
  ('seed-m0-fund',    0,  7,  NULL, 44, 'Monthly growth funding',      7,  300.00,  61.35, 9,    300.00),
  ('seed-m0-sell',    0,  9,  NULL, 45, 'Sold VWRA',                   13,   0.50,  NULL,  9,     97.03),
  ('seed-m0-buyaph',  0,  10, NULL, 45, 'Buy APH',                     9,  322.68,  61.35, 14,     2.00),
  ('tg-990001',       0,  11, NULL, 7,  'Jollibee',                    5,  285.00,  NULL,  NULL, NULL),
  ('tg-990002',       0,  12, NULL, 8,  'Convenience store',           1,   96.00,  NULL,  NULL, NULL),
  ('gm-990003',       0,  12, NULL, 6,  'Grocery delivery',            4, 2950.00,  NULL,  NULL, NULL),
  ('ui-990004',       0,  13, NULL, 12, 'Grab to the office',          5,  312.00,  NULL,  NULL, NULL),
  ('seed-m0-elec',    0,  15, NULL, 16, 'Water bill',                  3, 1180.00,  NULL,  NULL, NULL),
  ('seed-m0-net',     0,  15, NULL, 17, 'Mobile load',                 5,  442.00,  NULL,  NULL, NULL),
  ('seed-m0-care',    0,  16, NULL, 26, 'Toiletries',                  3,  388.00,  NULL,  NULL, NULL),
  ('seed-m0-gift',    0,  17, NULL, 19, 'Birthday gift for Alex',      4, 3200.00,  NULL,  NULL, NULL),
  ('seed-m0-med',     0,  18, NULL, 35, 'Vitamins',                    5,  620.00,  NULL,  NULL, NULL),
  ('seed-m0-move',    0,  6,  NULL, 45, 'BPI to MariBank',             3, 6000.00,  NULL,  2,   6000.00),
  ('seed-m0-move2',   0,  7,  NULL, 45, 'BPI to GCash',                3, 2500.00,  NULL,  5,   2500.00),
  ('seed-m0-move3',   0,  8,  NULL, 45, 'Cash withdrawal',             3, 1500.00,  NULL,  1,   1500.00),
  ('seed-m0-move4',   0,  19, NULL, 45, 'MariBank to BPI',             2,  800.00,  NULL,  3,    800.00),
  ('seed-m0-drift',   0,  20, NULL, 40, 'Untracked change',            1,  126.00,  NULL,  NULL, NULL),
  ('seed-m0-ef',      0,  21, NULL, 45, 'Park in Wise Savings',        7,  100.00,  61.40, 8,    100.00),
  ('seed-m0-int',     0,  27, NULL, 3,  'Monthly interest',            2,   80.15,  NULL,  NULL, NULL)
)
INSERT INTO transactions (id, date, period, category_id, description, account_id, amount_u, fx_rate, to_account_id, to_amount_u)
SELECT
  id,
  -- clamped: a seed row is never in the future, however early in the month today is
  min(date('now','start of month', mo || ' months', (dy - 1) || ' days'), date('now')),
  CASE WHEN pmo IS NULL THEN NULL ELSE
    substr(date('now','start of month', pmo || ' months'), 1, 4) || '-' ||
    substr('JanFebMarAprMayJunJulAugSepOctNovDec',
      (CAST(substr(date('now','start of month', pmo || ' months'), 6, 2) AS INTEGER) - 1) * 3 + 1, 3)
  END,
  cat, descr, acct,
  CAST(ROUND(amt * 1000000) AS INTEGER),
  fx, dst,
  CASE WHEN dst IS NULL THEN NULL ELSE CAST(ROUND(toamt * 1000000) AS INTEGER) END
FROM t;

-- The BIR 8% tracker. Row 4 points at an id that does not exist on purpose: that is
-- how the ledger screen's "transaction deleted" warning row gets exercised.
INSERT INTO ledger (id, tx_id, bsp_rate, filed, date_received, wise_amount_u) VALUES
  (1,'seed-m2-salary',   60.678,'2026-Q2', NULL, NULL),
  (2,'seed-m1-salary',   61.506, NULL,     NULL, NULL),
  (3,'seed-m0-salary',   61.432, NULL,     NULL, NULL),
  (4,'seed-deleted-tx',  61.290, NULL,     NULL, NULL);

-- Net-worth history for the two closed months. The current month is deliberately
-- absent: the dashboard uses the live figure there, and the bridge needs exactly this.
INSERT INTO nw_snapshots (month, net_worth_u, assets_u, liabilities_u, shares_u, taken_at)
SELECT
  substr(d,1,4) || '-' || substr('JanFebMarAprMayJunJulAugSepOctNovDec',
    (CAST(substr(d,6,2) AS INTEGER) - 1) * 3 + 1, 3),
  nw, a, l, s, datetime('now')
FROM (
  WITH n(mo, nw, a, l, s) AS (VALUES
    (-2,  23850000000,  30000000000,  -6150000000, 21000000000),
    (-1,  62000000000,  68150000000,  -6150000000, 42000000000))
  SELECT date('now','start of month', mo || ' months') AS d, nw, a, l, s FROM n);

-- One quote, for the gm-* row above: the receipt's email button reads it back from here.
INSERT INTO email_quotes (message_id, quote) VALUES
  ('990003', 'Your order has been delivered. Total: PHP 2,950.00 charged to your RCBC card ending 1234.');

INSERT OR REPLACE INTO meta (key, value) VALUES
  ('data_version',       '1'),
  ('monthly_income_php', '48000'),
  -- Non-zero on purpose: a local run has no FX key warm, and this is what stops every
  -- USD figure collapsing to zero when the rate lookup cannot reach the network.
  ('usd_php_fallback',   '61'),
  ('owner_email',        'dev@example.com'),
  ('ledger_first_year',  '2026'),
  ('tg_last_ids',        '[]');
