/**
 * Transactions.gs — create / list / update / delete + transfers.
 *
 * All writes go through su_*InputRow_ so only input columns are touched and the
 * Month/Type/Segment/Currency/Amount (PHP)/ToCurrency ARRAYFORMULAs keep spilling.
 * Validation rejects unknown categories/accounts. IDs are assigned server-side.
 */

// ── reference data ────────────────────────────────────────────────────────────
function tx_categoriesMap_() {
  const map = {};
  su_readObjects_(SHEET_CATEGORIES).forEach(function (r) {
    if (r.Category) map[r.Category] = { Type: r.Type || null, Segment: r.Segment || null };
  });
  return map;
}
function tx_accountsMap_() {
  const map = {};
  su_readObjects_(SHEET_ACCOUNTS).forEach(function (r) {
    if (r.Name) map[r.Name] = r;
  });
  return map;
}

// ── create ────────────────────────────────────────────────────────────────────
function api_createTransaction(args) {
  args = args || {};
  su_lock_(); // serialize writes: covers the idempotency check + append row calc
  const cats = tx_categoriesMap_();
  const accts = tx_accountsMap_();

  const category = args.Category;
  const account  = args.Account;
  if (!category) throw new Error("Missing required field: Category");
  if (!account)  throw new Error("Missing required field: Account");
  if (!cats[category])  throw new Error("Unknown Category: " + category);
  if (!accts[account])  throw new Error("Unknown Account: " + account);
  if (args.Amount === undefined || args.Amount === "" || isNaN(parseFloat(args.Amount)))
    throw new Error("Missing/invalid required field: Amount");
  tx_assertShape_(cats[category].Type, false); // a plain tx never has a ToAccount → reject Transfer categories (use createTransfer)

  // Idempotency: if caller passes an existing ID, return the existing row instead
  // of double-posting (used by n8n retries).
  const sheet = su_sheet_(SHEET_TX);
  const h = su_headerMap_(sheet);
  if (args.ID) {
    const existing = su_findRowById_(sheet, h, args.ID);
    if (existing) return { status: "duplicate", message: "ID already exists.",
                           transaction: tx_rowObject_(sheet, h, existing) };
  }

  const currency = accts[account].Currency;
  const fx = fx_resolveRate_(currency, args.ExchangeRate);

  const input = {
    ID:          args.ID || Utilities.getUuid(),
    Date:        tx_parseDate_(args.Date),
    Category:    category,
    Description: args.Description || "",
    Account:     account,
    Amount:      parseFloat(args.Amount)
  };
  if (!fx.blank) input.ExchangeRate = fx.rate;

  const row = su_appendInputRow_(sheet, h, input);
  const created = tx_rowObject_(sheet, h, row);
  cache_bumpVersion_();
  const res = { status: "success", message: "Transaction created.", transaction: created };
  if (fx.warning) res.warning = fx.warning;
  return res;
}

// ── transfer (one row: source Account + ToAccount/ToAmount) ───────────────────
function api_createTransfer(args) {
  args = args || {};
  su_lock_();
  const cats = tx_categoriesMap_();
  const accts = tx_accountsMap_();

  const account   = args.Account;     // source
  const toAccount = args.ToAccount;   // destination
  const category  = args.Category;    // a Transfer-type category
  if (!account || !toAccount) throw new Error("Transfer needs both Account and ToAccount.");
  if (!accts[account])   throw new Error("Unknown Account: " + account);
  if (!accts[toAccount]) throw new Error("Unknown ToAccount: " + toAccount);
  if (account === toAccount) throw new Error("Account and ToAccount must differ.");
  if (!category) throw new Error("Transfer needs a Category (Transfer type).");
  if (!cats[category]) throw new Error("Unknown Category: " + category);
  tx_assertShape_(cats[category].Type, true); // a transfer row has a ToAccount → its category must be Transfer type
  if (args.Amount === undefined || isNaN(parseFloat(args.Amount)))
    throw new Error("Missing/invalid Amount (source amount).");

  // ToAmount defaults to Amount (same-currency transfer); pass it for cross-currency.
  const toAmount = (args.ToAmount !== undefined && args.ToAmount !== "")
    ? parseFloat(args.ToAmount) : parseFloat(args.Amount);

  const sheet = su_sheet_(SHEET_TX);
  const h = su_headerMap_(sheet);
  const fx = fx_resolveRate_(accts[account].Currency, args.ExchangeRate);

  const input = {
    ID:          args.ID || Utilities.getUuid(),
    Date:        tx_parseDate_(args.Date),
    Category:    category,
    Description: args.Description || "",
    Account:     account,
    Amount:      parseFloat(args.Amount),
    ToAccount:   toAccount,
    ToAmount:    toAmount
  };
  if (!fx.blank) input.ExchangeRate = fx.rate;

  const row = su_appendInputRow_(sheet, h, input);
  cache_bumpVersion_();
  return { status: "success", message: "Transfer created.",
           transaction: tx_rowObject_(sheet, h, row) };
}

// ── list (filters + pagination, most-recent first) ────────────────────────────
function api_listTransactions(args) {
  args = args || {};
  const rows = su_readObjects_(SHEET_TX);
  const month    = args.month    ? String(args.month) : "";
  const account  = args.account  ? String(args.account) : "";
  const category = args.category ? String(args.category) : "";
  const segment  = args.segment  ? String(args.segment) : "";
  const search   = args.search   ? String(args.search).toLowerCase() : "";

  let filtered = rows.filter(function (r) {
    if (month    && String(r.Month)    !== month) return false;
    if (account  && String(r.Account)  !== account && String(r.ToAccount) !== account) return false;
    if (category && String(r.Category) !== category) return false;
    if (segment  && String(r.Segment)  !== segment) return false;
    if (search) {
      const hay = (String(r.Description) + " " + String(r.Category)).toLowerCase();
      if (hay.indexOf(search) === -1) return false;
    }
    return true;
  });
  filtered.sort(tx_byDateDesc_); // by Date desc; backdated rows land in date order, not append order

  const total  = filtered.length;
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const limit  = Math.max(1, parseInt(args.limit, 10) || 100);
  const page = filtered.slice(offset, offset + limit).map(tx_clean_);
  return { status: "success", total: total, offset: offset, limit: limit, transactions: page };
}

// ── update (input columns only, by ID) ────────────────────────────────────────
function api_updateTransaction(args) {
  args = args || {};
  if (!args.ID) throw new Error("update requires an ID.");
  su_lock_(); // row index resolved by ID must not shift under a concurrent delete
  const sheet = su_sheet_(SHEET_TX);
  const h = su_headerMap_(sheet);
  const row = su_findRowById_(sheet, h, args.ID);
  if (!row) throw new Error("No transaction with ID: " + args.ID);

  const cats = tx_categoriesMap_();
  const accts = tx_accountsMap_();
  if (args.Category !== undefined && !cats[args.Category]) throw new Error("Unknown Category: " + args.Category);
  if (args.Account  !== undefined && !accts[args.Account]) throw new Error("Unknown Account: " + args.Account);
  if (args.ToAccount !== undefined && args.ToAccount !== "" && !accts[args.ToAccount])
    throw new Error("Unknown ToAccount: " + args.ToAccount);

  // Only apply provided client fields (never ID via this path, never derived cols).
  const patch = {};
  TX_CLIENT_FIELDS.forEach(function (f) { if (args[f] !== undefined) patch[f] = args[f]; });
  if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");
  if (patch.Date !== undefined) patch.Date = tx_parseDate_(patch.Date);
  if (patch.Amount !== undefined) patch.Amount = parseFloat(patch.Amount);
  if (patch.ToAmount !== undefined && patch.ToAmount !== "") patch.ToAmount = parseFloat(patch.ToAmount);

  // Effective row after the patch, for the two invariants below.
  const cur = tx_rowObject_(sheet, h, row);
  const effCat = patch.Category  !== undefined ? patch.Category  : cur.Category;
  const effTo  = patch.ToAccount !== undefined ? patch.ToAccount : cur.ToAccount;
  tx_assertShape_(cats[effCat] ? cats[effCat].Type : null, tx_hasTo_(effTo)); // issue #8
  // Re-stamp ExchangeRate when Account (currency) changes or the client sends one
  // explicitly — incl. "" to clear a manual override (issue #7). Untouched otherwise
  // so history never reprices.
  if (patch.Account !== undefined || args.ExchangeRate !== undefined) {
    const effAcct = patch.Account !== undefined ? patch.Account : cur.Account;
    const fx = fx_resolveRate_(accts[effAcct] ? accts[effAcct].Currency : "", args.ExchangeRate);
    patch.ExchangeRate = fx.blank ? "" : fx.rate;
  }

  su_setInputCells_(sheet, h, row, patch);
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  return { status: "success", message: "Transaction updated.",
           transaction: tx_rowObject_(sheet, h, row) };
}

// ── delete (by ID) ────────────────────────────────────────────────────────────
function api_deleteTransaction(args) {
  args = args || {};
  if (!args.ID) throw new Error("delete requires an ID.");
  su_lock_();
  const sheet = su_sheet_(SHEET_TX);
  const h = su_headerMap_(sheet);
  const row = su_findRowById_(sheet, h, args.ID);
  if (!row) throw new Error("No transaction with ID: " + args.ID);
  const snapshot = tx_rowObject_(sheet, h, row);
  sheet.deleteRow(row);
  cache_bumpVersion_();
  return { status: "success", message: "Transaction deleted.", transaction: snapshot };
}

// ── bulk update / delete (one read, one flush, one version bump) ──────────────
/**
 * Patch many transactions at once. args = { ids:[...], patch:{Category|Account|
 * Date|...} }. The patch is validated + coerced ONCE, the ID column is read ONCE
 * into an id→row map, every row is written via su_setInputCells_ (input-cols only),
 * then a single flush + version bump. Returns { updated, skipped:[ids not found] }.
 */
function api_bulkUpdateTransactions(args) {
  args = args || {};
  const ids = (args.ids || []).map(String);
  const patch = args.patch || {};
  if (!ids.length) throw new Error("bulkUpdate requires a non-empty ids[].");
  su_lock_();

  const cats = tx_categoriesMap_();
  const accts = tx_accountsMap_();
  if (patch.Category !== undefined && !cats[patch.Category]) throw new Error("Unknown Category: " + patch.Category);
  if (patch.Account  !== undefined && !accts[patch.Account]) throw new Error("Unknown Account: " + patch.Account);
  if (patch.ToAccount !== undefined && patch.ToAccount !== "" && !accts[patch.ToAccount])
    throw new Error("Unknown ToAccount: " + patch.ToAccount);

  const p = {};
  TX_CLIENT_FIELDS.forEach(function (f) { if (patch[f] !== undefined) p[f] = patch[f]; });
  if (Object.keys(p).length === 0) throw new Error("Nothing to update.");
  if (p.Date !== undefined) p.Date = tx_parseDate_(p.Date);
  if (p.Amount !== undefined) p.Amount = parseFloat(p.Amount);
  if (p.ToAmount !== undefined && p.ToAmount !== "") p.ToAmount = parseFloat(p.ToAmount);

  const sheet = su_sheet_(SHEET_TX);
  const h = su_headerMap_(sheet);
  const rowById = tx_idRowMap_(sheet, h);

  const rows = []; const skipped = [];
  ids.forEach(function (id) {
    const row = rowById[id];
    if (!row) { skipped.push(id); return; }
    rows.push(row);
  });

  // Shape guard (issue #8): reject a Category/ToAccount mismatch on any affected row.
  // Values not in the patch are read per-row (one column read each).
  if (p.Category !== undefined || p.ToAccount !== undefined) {
    const catByRow = p.Category  === undefined ? tx_colByRow_(sheet, h, "Category")  : null;
    const toByRow  = p.ToAccount === undefined ? tx_colByRow_(sheet, h, "ToAccount") : null;
    rows.forEach(function (row) {
      const c  = p.Category  !== undefined ? p.Category  : catByRow[row];
      const to = p.ToAccount !== undefined ? p.ToAccount : toByRow[row];
      tx_assertShape_(cats[c] ? cats[c].Type : null, tx_hasTo_(to));
    });
  }
  // Re-stamp ExchangeRate on reassignment / explicit send (issue #7). A bulk reassign
  // sends a single Account so one resolution covers all rows.
  // ponytail: a bulk clear (ExchangeRate:"") with no Account change resolves against
  // the empty currency (→ blank) for every row; fine for reassigns (the only UI path),
  // per-row currency lookup only if a mixed-currency bulk-clear is ever exposed.
  if (p.Account !== undefined || patch.ExchangeRate !== undefined) {
    const cy = accts[p.Account] ? accts[p.Account].Currency : "";
    const fx = fx_resolveRate_(cy, patch.ExchangeRate);
    p.ExchangeRate = fx.blank ? "" : fx.rate;
  }

  if (rows.length) {
    su_invalidateMemo_(sheet.getName());
    // One RangeList write per patched field (not one setValue per cell): N rows ×
    // F fields costs F Sheets calls instead of N×F.
    Object.keys(p).forEach(function (header) {
      if (TX_INPUT_COLS.indexOf(header) === -1) return;   // never touch derived cols
      const col = h[header];
      if (!col || p[header] === undefined) return;
      sheet.getRangeList(rows.map(function (r) { return su_a1_(r, col); })).setValue(p[header]);
    });
  }
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  return { status: "success", message: "Bulk update complete.", updated: rows.length, skipped: skipped };
}

/**
 * Delete many transactions at once. args = { ids:[...] }. Rows are resolved from a
 * single ID-column read, then deleted in DESCENDING row order so earlier deletes
 * don't shift the indices of later ones. One version bump at the end.
 */
function api_bulkDeleteTransactions(args) {
  args = args || {};
  const ids = (args.ids || []).map(String);
  if (!ids.length) throw new Error("bulkDelete requires a non-empty ids[].");
  su_lock_();

  const sheet = su_sheet_(SHEET_TX);
  const h = su_headerMap_(sheet);
  const rowById = tx_idRowMap_(sheet, h);

  const rows = []; const skipped = [];
  ids.forEach(function (id) {
    const row = rowById[id];
    if (!row) { skipped.push(id); return; }
    rows.push(row);
  });
  rows.sort(function (a, b) { return b - a; }); // bottom-up so indices stay valid
  rows.forEach(function (row) { sheet.deleteRow(row); });
  SpreadsheetApp.flush();
  cache_bumpVersion_();
  return { status: "success", message: "Bulk delete complete.", deleted: rows.length, skipped: skipped };
}

// ── helpers ───────────────────────────────────────────────────────────────────
/** Truthy ToAccount (present + non-blank). */
function tx_hasTo_(v) { return !!(v && String(v).trim() !== ""); }

/**
 * Invariant: a Transfer-type category ⇔ the row has a ToAccount. A mismatch would
 * make the derived Type/balance math and budgets read the row wrong, so we reject it
 * on every create/update/bulk path. `type` = effective category Type, `hasTo` = bool.
 */
function tx_assertShape_(type, hasTo) {
  if (type === "Transfer" && !hasTo) throw new Error("A Transfer category requires a destination account (ToAccount).");
  if (type !== "Transfer" && hasTo)  throw new Error("Only a Transfer category may have a ToAccount.");
}

/** {1-based row → value} for one header, from a single column read. */
function tx_colByRow_(sheet, headerMap, header) {
  const col = headerMap[header];
  const last = su_lastDataRow_(sheet, headerMap);
  const map = {};
  if (col && last >= 2) {
    const vals = sheet.getRange(2, col, last - 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) map[i + 2] = vals[i][0];
  }
  return map;
}

/** id (string) → 1-based sheet row, from a single read of the ID column. */
function tx_idRowMap_(sheet, headerMap) {
  const idCol = headerMap["ID"];
  if (!idCol) throw new Error("Transactions has no 'ID' column — run the migration first.");
  const last = su_lastDataRow_(sheet, headerMap);
  const map = {};
  if (last < 2) return map;
  const ids = sheet.getRange(2, idCol, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) map[String(ids[i][0])] = i + 2;
  return map;
}

/**
 * Coerce a client-supplied Date into a real Date the sheet can derive Month from.
 * The UI sends an ISO "yyyy-MM-dd" STRING (google.script.run rejects a Date nested
 * in an object — "illegal property"), so parse that as a LOCAL date (script tz) to
 * avoid the UTC-midnight day-shift `new Date("yyyy-MM-dd")` would introduce. Also
 * tolerates a real Date (n8n/JSON path) or any other parseable value; blank → now.
 */
function tx_parseDate_(v) {
  if (v instanceof Date) return v;
  if (v === undefined || v === null || v === "") return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date() : d;
}

/** Read one transaction row (incl. derived values) as a clean object. */
function tx_rowObject_(sheet, headerMap, row) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const vals = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
  const obj = {};
  headers.forEach(function (hname, i) { if (hname !== "") obj[hname] = vals[i]; });
  return tx_clean_(obj);
}

/**
 * Sort comparator: Date descending, __row descending as tie-breaker (stable for
 * same-day rows → later-entered shows first). Used by list + Dashboard "Recent"
 * so a backdated entry sorts by its date, not by its append position.
 */
function tx_byDateDesc_(a, b) {
  const da = tx_dateVal_(a.Date), db = tx_dateVal_(b.Date);
  if (da !== db) return db - da;
  return (b.__row || 0) - (a.__row || 0);
}
function tx_dateVal_(v) {
  if (v instanceof Date) return v.getTime();
  const d = new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Strip the internal __row marker + stringify Dates (google.script.run-safe). */
function tx_clean_(obj) {
  if (!obj) return obj;
  const c = {};
  Object.keys(obj).forEach(function (k) { if (k !== "__row") c[k] = su_dateStr_(obj[k]); });
  return c;
}
