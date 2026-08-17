/**
 * Telegram.gs — the Telegram bot, running directly in Apps Script (no n8n).
 *
 * Telegram POSTs each update to the Web App URL with `?action=telegram` (see
 * tg_setWebhook), the router dispatches it here, and this file does what the n8n
 * workflow used to do: authorize the sender, parse the message with Gemini, hand
 * it to the service layer, and reply in the chat. One message can log several
 * transactions, ask a question about past ones, or undo the previous message.
 *
 * Notes on the two things that made this look hard from the n8n side:
 *   • ContentService's 302 — real, and the one thing GAS cannot solve alone.
 *     Telegram rejects a redirecting webhook outright ("Wrong response from the
 *     webhook: 302 Found"), so a Cloudflare Worker (worker/) sits in front,
 *     answers 200, and forwards the update here. Nothing else about the bot
 *     changes; the reply still goes out-of-band via sendMessage.
 *   • update_id dedup — real, and it takes two layers. `tg_seen_` claims the
 *     update_id in CacheService before any work, so a redelivery is answered
 *     instantly instead of re-running the slow path; the deterministic
 *     "tg-<update_id>-<i>" transaction ID (both create paths are idempotent on a
 *     supplied ID) then guarantees no second row if one slips through anyway.
 *
 * Script Properties required: TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, GEMINI_API_KEY
 * (+ WEB_APP_URL for tg_gasEndpoint, and WEBHOOK_URL — the Worker's /tg endpoint —
 * which tg_appUrl_ turns into the receipt's "Edit details" link).
 */

const TG_API_    = "https://api.telegram.org/bot";
// Tried in order; the next one is used if the previous errors (overload, 5xx,
// a model id that stopped existing). Cheapest-capable first.
const TG_MODELS_ = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"];
const TG_HELP_  = "✦ Just send a transaction in plain language.\n" +
                  "e.g. `lunch 250 maya` or `moved 5k from bpi to maribank`\n" +
                  "Several in one message work too (one per line).\n" +
                  "Ask questions: `how much on food this month`\n" +
                  "Check balances: `how much do I have` / `how much is in maya` (or /balance)\n" +
                  "Take it back: `undo` (or /undo) removes the last message's rows.";

// The property holding the IDs written by the last logged message (undo target).
const TG_LAST_IDS_ = "TG_LAST_IDS";

// Gemini structured-output schema (OpenAPI subset: nullable, not union types).
// Only `intent`/`error` are required — a non-transaction message must be able to
// come back as {error:"..."} without the model inventing a Category to satisfy it.
const TG_TX_SCHEMA_ = {
  type: "OBJECT",
  properties: {
    Date:         { type: "STRING", description: "Transaction date, ISO yyyy-MM-dd" },
    Category:     { type: "STRING", description: "Exact match from VALID CATEGORIES" },
    Description:  { type: "STRING", description: "Concise description, max 256 chars" },
    Account:      { type: "STRING", description: "Exact match from VALID ACCOUNTS (source account)" },
    Amount:       { type: "NUMBER", description: "Positive amount leaving/entering the source account" },
    ExchangeRate: { type: "NUMBER", nullable: true, description: "PHP per 1 USD, only if explicitly mentioned" },
    ToAccount:    { type: "STRING", nullable: true, description: "Destination account, transfers only" },
    ToAmount:     { type: "NUMBER", nullable: true, description: "Amount received in the destination account, transfers only" }
  }
};

const TG_SCHEMA_ = {
  type: "OBJECT",
  properties: {
    // Plain STRING, not an enum: an unrecognised value falls back to "log", which
    // is the pre-existing behaviour — safer than risking a schema the API rejects.
    intent: { type: "STRING", description: '"log" to record transactions, "query" to answer a question about past ones, "balance" to report what is in the accounts right now, "undo" to take back the previous message' },
    items:  { type: "ARRAY", nullable: true, items: TG_TX_SCHEMA_,
              description: "One entry per transaction in the message (intent=log). A message may contain several." },
    query:  { type: "OBJECT", nullable: true, description: "Filters for intent=query (intent=balance uses account only); omit the ones the message does not imply",
              properties: {
                month:    { type: "STRING", nullable: true, description: "Month to restrict to, yyyy-MM. Null means all time" },
                category: { type: "STRING", nullable: true, description: "Exact match from VALID CATEGORIES" },
                account:  { type: "STRING", nullable: true, description: "Exact match from VALID ACCOUNTS" },
                search:   { type: "STRING", nullable: true, description: "Free-text words to match in the description" }
              } },
    error:  { type: "STRING", nullable: true, description: "Short error message if the message is none of the four intents; else null" }
  },
  required: ["intent", "error"]
};

// ── webhook entry point (Router: ROUTES_WRITE_.telegram) ──────────────────────
/**
 * Always returns success: a non-2xx tells Telegram to redeliver, and a message we
 * already failed to parse will fail again. Problems are reported in the chat.
 */
// `update` is the Telegram update object (the router merges query params onto it;
// the extra `action`/`token` keys are ignored here).
function tg_webhook_(update) {
  try {
    if (tg_seen_(update && update.update_id)) return { status: "success", message: "duplicate update" };
    tg_handleUpdate_(update);
  } catch (err) {
    console.error("telegram: " + (err && err.stack ? err.stack : err));
  }
  return { status: "success" };
}

/**
 * Claim an update_id, returning true if it was already claimed.
 *
 * Telegram redelivers an update until it gets a timely response, and one pass
 * through Gemini + Sheets is slow enough to lose that race. So a redelivery has
 * to be answered *before* any work — otherwise every retry is as slow as the
 * original, times out the same way, and the redelivery never stops (it also
 * re-replies each time, which is how this showed up: an endless "Already logged").
 *
 * This is a different job from the tg-<update_id> transaction ID: that one keeps
 * a retry from writing a second row, this one keeps the retry storm from starting.
 *
 * ponytail: claimed up front, so an execution that dies mid-way is not retried
 * either — you resend the message. Better than the storm; revisit only if real
 * failures turn out to be common.
 */
function tg_seen_(updateId) {
  if (!updateId) return false;
  const cache = CacheService.getScriptCache();
  const key = "tg-update-" + updateId;
  if (cache.get(key)) return true;
  cache.put(key, "1", 3600);   // Telegram gives up well inside an hour
  return false;
}

function tg_handleUpdate_(update) {
  if (update && update.callback_query) { tg_callback_(update.callback_query); return; }
  const msg = update && update.message;
  if (!msg || !msg.text) return;                       // ignore photos/stickers/edits
  const chat = msg.chat.id;
  const replyTo = msg.message_id;

  if (String(msg.from && msg.from.id) !== String(cfgTelegramUserId_())) {
    tg_send_(chat, "⛔ *Unauthorized. This bot is private.*");
    return;
  }

  const text = String(msg.text).trim();
  if (text.charAt(0) === "/") {
    const cmd = text.slice(1).split(/[\s@]/)[0];
    if (cmd === "undo")         tg_undo_(chat, replyTo);
    else if (cmd === "balance") tg_balance_(chat, null, replyTo);   // no parse needed
    else                        tg_send_(chat, TG_HELP_, replyTo);
    return;
  }

  let parsed;
  try {
    parsed = tg_parse_(text, msg.date);
  } catch (err) {
    tg_send_(chat, "❌ *Failed to add transaction*\n› " + tg_msg_(err), replyTo);
    return;
  }
  if (parsed.error) {
    tg_send_(chat, "❌ *Failed to add transaction*\n› " + parsed.error, replyTo);
    return;
  }

  if (parsed.intent === "undo")    { tg_undo_(chat, replyTo); return; }
  if (parsed.intent === "balance") { tg_balance_(chat, parsed.query, replyTo); return; }
  if (parsed.intent === "query") {
    try { tg_send_(chat, tg_queryReply_(parsed.query), replyTo); }
    catch (err) { tg_send_(chat, "❌ *Query failed*\n› " + tg_msg_(err), replyTo); }
    return;
  }

  const items = parsed.items || [];
  if (!items.length) {
    tg_send_(chat, "❌ *Failed to add transaction*\n› Nothing to log.", replyTo);
    return;
  }
  tg_logItems_(chat, "tg-" + update.update_id, items, replyTo);
}

// ── log (one or many transactions per message) ────────────────────────────────
/**
 * Create every parsed item, reply once, and remember the IDs for undo. A failing
 * item reports itself and the rest still land — a five-line message shouldn't be
 * lost because line three named an account that doesn't exist.
 *
 * `idPrefix` identifies the source that produced these rows and makes their IDs
 * idempotent under retries: "tg-<update_id>" for a chat message, "gm-<messageId>"
 * for a Gmail notification (Gmail.gs). Row IDs are "<idPrefix>-<i>".
 * `mailId` is the Gmail message id when a notification caused the log, which adds the
 * ⌕ Email button that quotes it back. Returns the IDs that landed — Gmail.gs only
 * trashes the email when every item made it.
 *
 * ponytail: one service call per item. There is no bulk create, and a message
 * carries a handful of transactions, not hundreds.
 */
function tg_logItems_(chat, idPrefix, items, replyTo, mailId) {
  const out = [], ids = [], idx = [];
  items.forEach(function (p, i) {
    const args = {
      ID:           idPrefix + "-" + i,                // idempotent under retries
      Date:         p.Date,
      Category:     p.Category,
      Description:  p.Description,
      Account:      p.Account,
      Amount:       p.Amount,
      ExchangeRate: p.ExchangeRate,
      ToAccount:    p.ToAccount,
      ToAmount:     p.ToAmount
    };
    try {
      // Transfers were never possible over the old bare-body POST (it always hit
      // api_createTransaction, which rejects Transfer categories). Route them now.
      const res = p.ToAccount ? api_createTransfer(args) : api_createTransaction(args);
      out.push(tg_receipt_(p, res.status));
      ids.push(args.ID);
      idx.push(i);
    } catch (err) {
      out.push("❌ *Failed to add transaction*\n› " + tg_msg_(err));
    }
  });
  // Only the rows that actually landed, so undo can't chase a failed item.
  if (ids.length) PropertiesService.getScriptProperties().setProperty(TG_LAST_IDS_, JSON.stringify(ids));
  tg_send_(chat, out.join("\n\n"), replyTo, ids.length ? tg_logKeyboard_(idPrefix, idx, ids, mailId) : null);
  return ids;
}

// ── the Undo / Edit details buttons under a receipt ───────────────────────────
/**
 * Undo carries its own IDs in callback_data instead of reading TG_LAST_IDS, so the
 * button under an older receipt still undoes *that* message. Only the indices that
 * landed are encoded — a failed item has no row to delete.
 *
 * Edit details is a plain URL button into the SPA (?tx= opens the edit modal); it
 * needs no callback handling at all. With several rows in one message there is no
 * single row to open, so it just lands on the Transactions screen.
 */
function tg_undoData_(idPrefix, indices) { return "u:" + idPrefix + ":" + indices.join(","); }

/** Reverse of tg_undoData_ → transaction IDs; [] if the payload isn't ours. */
function tg_undoIds_(data) {
  const m = /^u:([A-Za-z0-9-]+):(\d+(?:,\d+)*)$/.exec(String(data || ""));
  if (!m) return [];
  // Receipts sent before the prefix carried a source ("u:90210:0") mean Telegram.
  const prefix = /^\d+$/.test(m[1]) ? "tg-" + m[1] : m[1];
  return m[2].split(",").map(function (i) { return prefix + "-" + i; });
}

function tg_logKeyboard_(idPrefix, indices, ids, mailId) {
  const row = [];
  const data = tg_undoData_(idPrefix, indices);
  // Telegram caps callback_data at 64 bytes; past that, /undo still covers it.
  if (data.length <= 64) row.push({ text: "↻ Undo", callback_data: data });
  const url = tg_appUrl_();
  if (url) row.push({ text: "✎ Edit details", url: url + "?screen=transactions" +
                      (ids.length === 1 ? "&tx=" + encodeURIComponent(ids[0]) : "") });
  const rows = row.length ? [row] : [];
  // Its own row: three buttons abreast get squeezed to unreadable on a phone.
  if (mailId) rows.push([{ text: "⌕ Email", callback_data: "e:" + mailId }]);
  return rows.length ? rows : null;
}

/**
 * A button tap — "u:…" Undo, or "e:<gmail id>" ⌕ Email.
 *
 * Undo rewrites the receipt with the removal summary, which also drops the keyboard,
 * so it can't be pressed twice against deleted rows. Email replies with a quote of the
 * mail and deliberately leaves the keyboard alone: checking the source is a read, and
 * a second look must stay possible. The mail is fetched on demand rather than stashed
 * anywhere — Gmail still serves a trashed message by id, and the receipt outliving the
 * 30-day trash purge is what the catch is for.
 */
function tg_callback_(cq) {
  const msg = cq.message || {};
  const chat = msg.chat && msg.chat.id;
  if (String(cq.from && cq.from.id) !== String(cfgTelegramUserId_()))
    return tg_answer_(cq, "Unauthorized.");

  const mailId = /^e:([0-9a-zA-Z]{1,64})$/.exec(String(cq.data || ""));
  if (mailId) {
    try {
      tg_send_(chat, gmail_quote_(GmailApp.getMessageById(mailId[1])), msg.message_id);
    } catch (err) {
      return tg_answer_(cq, "Email no longer available.");
    }
    return tg_answer_(cq, "");
  }

  const ids = tg_undoIds_(cq.data);
  if (ids.length) tg_edit_(chat, msg.message_id, tg_deleteIds_(ids).join("\n"));
  tg_answer_(cq, ids.length ? "Removed." : "Nothing to undo.");
}

/** Dismiss the button's spinner (an unanswered callback spins for ~30s). */
function tg_answer_(cq, text) {
  tg_api_("answerCallbackQuery", { callback_query_id: cq.id, text: text });
}

// ── undo (the last logged message) ────────────────────────────────────────────
/**
 * Delete the rows written by the previous message. One level deep, and the
 * pointer is cleared afterwards so a second "undo" can't delete someone else's
 * row once these IDs are gone. Script Properties, not CacheService: an undo an
 * hour later must still work.
 */
function tg_undo_(chat, replyTo) {
  let ids = [];
  try { ids = JSON.parse(PropertiesService.getScriptProperties().getProperty(TG_LAST_IDS_) || "[]"); }
  catch (err) { ids = []; }
  if (!ids.length) { tg_send_(chat, "✦ *Nothing to undo.*", replyTo); return; }
  tg_send_(chat, tg_deleteIds_(ids).join("\n"), replyTo);
}

/** Delete those rows and describe what went; shared by /undo and the Undo button. */
function tg_deleteIds_(ids) {
  const out = ["↻ *Removed*"];
  ids.forEach(function (id) {
    try {
      const t = api_deleteTransaction({ ID: id }).transaction;
      out.push("› _" + t.Category + "_ " + tg_php_(t["Amount (PHP)"] || t.Amount));
    } catch (err) {
      out.push("› ❌ " + tg_msg_(err));
    }
  });
  // Cleared either way: the button and /undo point at the same rows, so whichever
  // fires first must stop the other from chasing them.
  PropertiesService.getScriptProperties().deleteProperty(TG_LAST_IDS_);
  return out;
}

// ── query / read-back ─────────────────────────────────────────────────────────
/** Answer a "how much on X" message from the ledger. */
function tg_queryReply_(query) {
  const args = tg_queryFilters_(query);
  const res  = api_listTransactions(args);
  const label = [args.category, args.account, args.search, args.month || "all time"]
    .filter(Boolean).join(" · ");
  return "⌕ *" + label + "*\n" + tg_querySummary_(res.transactions, res.total);
}

/** Parsed query object → api_listTransactions args. */
function tg_queryFilters_(query) {
  const q = query || {};
  // ponytail: one page. 500 rows is more than any single month; paginate only if
  // an all-time query ever needs a total that big to be exact.
  const args = { limit: 500 };
  if (q.month)    args.month    = tg_monthKey_(q.month);
  if (q.category) args.category = q.category;
  if (q.account)  args.account  = q.account;
  if (q.search)   args.search   = q.search;
  return args;
}

/** "2026-08" / "2026-Aug" → the sheet's derived Month key ("2026-Aug"). */
function tg_monthKey_(s) {
  const d = bud_parseMonth_(s);   // tolerant of both forms; falls back to today
  return d.getFullYear() + "-" +
    ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
}

/**
 * Rows → the reply body: total, count, and the most recent few. Amounts are
 * summed absolute (the ledger signs expenses and income differently, and a
 * filtered query is always "how much moved through this").
 */
function tg_querySummary_(rows, total) {
  rows = rows || [];
  const n = (total === undefined) ? rows.length : total;
  if (!n) return "No matching transactions.";
  const sum = rows.reduce(function (s, r) { return s + Math.abs(Number(r["Amount (PHP)"]) || 0); }, 0);
  const lines = rows.slice(0, 5).map(function (r) {
    return "› _" + String(r.Date).slice(0, 10) + "_ " + r.Category +
           (r.Description ? " — " + r.Description : "") +
           " `" + tg_php_(r["Amount (PHP)"]) + "`";
  });
  if (n > lines.length) lines.push("› _…" + (n - lines.length) + " more_");
  return "*" + tg_php_(sum) + "* across " + n + " tx\n" + lines.join("\n");
}

// ── balances ──────────────────────────────────────────────────────────────────
/** Reply with what's in the accounts right now; `query.account` narrows it to one. */
function tg_balance_(chat, query, replyTo) {
  try { tg_send_(chat, tg_balanceText_(api_getAccounts().accounts, query && query.account), replyTo); }
  catch (err) { tg_send_(chat, "❌ *Balance lookup failed*\n› " + tg_msg_(err), replyTo); }
}

/**
 * Accounts (from api_getAccounts, so the sheet's own balance formulas) → the reply.
 * Non-PHP accounts lead with their native amount and carry PHP behind it, matching
 * the web UI. The total is signed net worth: liabilities pull it down.
 */
function tg_balanceText_(accounts, name) {
  const hits = tg_matchAccounts_(accounts || [], name);
  if (!hits.length) return "⌕ No account matching *" + name + "*.";
  const lines = hits.map(function (a) {
    const ccy = String(a.currency || "PHP").toUpperCase();
    const native = (ccy !== "PHP" && a.balanceNative !== null && a.balanceNative !== undefined)
      ? "`" + tg_money_(a.balanceNative, ccy) + "` · " : "";
    return "› _" + a.name + "_ " + native + "`" + tg_php_(a.balancePhp) + "`" +
           (a.isLiability ? " owed" : "");
  });
  if (hits.length > 1) {
    const total = hits.reduce(function (s, a) { return s + (Number(a.netWorthPhp) || 0); }, 0);
    lines.push("*Total* `" + (total < 0 ? "-" : "") + tg_php_(total) + "`");
  }
  return "◈ *Balance" + (hits.length > 1 ? "s" : "") + "*\n" + lines.join("\n");
}

/**
 * No name → every account. Otherwise case-insensitive substring, so a model that
 * echoes "maya" instead of the exact sheet name still resolves (and "maya" legitimately
 * matching two accounts lists both rather than guessing).
 */
function tg_matchAccounts_(accounts, name) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return accounts;
  return accounts.filter(function (a) { return String(a.name).toLowerCase().indexOf(q) !== -1; });
}

/** Absolute amount with its currency's symbol; unknown currencies (SHARES) trail the code. */
function tg_money_(n, ccy) {
  const c = String(ccy || "PHP").toUpperCase();
  const v = Math.abs(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (c === "PHP") return "₱" + v;
  if (c === "USD") return "$" + v;
  return v + " " + c;
}

function tg_php_(n) { return tg_money_(n, "PHP"); }

// ── Gemini parse ──────────────────────────────────────────────────────────────
/** Message text → the structured transaction object. Throws on API/parse failure. */
function tg_parse_(text, unixDate) {
  const key = cfgGeminiKey_();
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: tg_prompt_(unixDate) }] },
    contents: [{ role: "user", parts: [{ text: text }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json",
                        responseSchema: TG_SCHEMA_ }
  });
  return tg_tryModels_(TG_MODELS_, function (model) {
    return JSON.parse(tg_generate_(model, key, payload));
  });
}

/**
 * Call `fn` with each model until one returns; the last failure surfaces if none do.
 * ponytail: retries the whole call, so a 503 on the primary just costs one extra
 * round trip. No per-status logic — a bad response is a bad response either way.
 */
function tg_tryModels_(models, fn) {
  for (var i = 0; i < models.length; i++) {
    try { return fn(models[i]); }
    catch (err) {
      console.warn("gemini " + models[i] + " failed: " + tg_msg_(err));
      if (i === models.length - 1) throw err;
    }
  }
}

/** One generateContent call → the model's raw text. Throws on non-200/empty. */
function tg_generate_(model, key, payload) {
  const res = UrlFetchApp.fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model +
      ":generateContent?key=" + encodeURIComponent(key),
    { method: "post", contentType: "application/json", muteHttpExceptions: true,
      payload: payload });
  if (res.getResponseCode() !== 200)
    throw new Error("Gemini " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
  return tg_geminiText_(JSON.parse(res.getContentText()));
}

/** Pull the model's text out of a generateContent response. Throws if it's empty. */
function tg_geminiText_(json) {
  const c = json && json.candidates && json.candidates[0];
  const parts = c && c.content && c.content.parts;
  const text = parts && parts[0] && parts[0].text;
  if (!text) throw new Error("Gemini returned no content" +
    (c && c.finishReason ? " (" + c.finishReason + ")" : "") + ".");
  return text;
}

/** The parser system prompt, with the live category/account lists inlined. */
function tg_prompt_(unixDate) {
  const tz = Session.getScriptTimeZone();
  const when = unixDate ? new Date(unixDate * 1000) : new Date();
  const today = Utilities.formatDate(when, tz, "yyyy-MM-dd");

  const cats = su_readObjects_(SHEET_CATEGORIES).filter(function (r) { return r.Category; })
    .map(function (r) { return '- "' + r.Category + '" (' + (r.Type || "") + ') - ' + (r.Description || ""); })
    .join("\n");
  const accts = su_readObjects_(SHEET_ACCOUNTS).filter(function (r) { return r.Name; })
    .map(function (r) { return '- "' + r.Name + '" (' + (r.Currency || "") + ')'; })
    .join("\n");

  return [
    "You are a personal finance assistant. Classify the user's message and extract structured data.",
    "",
    'VALID CATEGORIES ("Name" (Type) - Description):', cats,
    "",
    'VALID ACCOUNTS ("Name" (Currency)):', accts,
    "",
    "INTENT:",
    'A. "log" — the message records money moving. Put ONE entry in items per transaction;',
    "   a message may describe several (e.g. one per line). Leave query null.",
    'B. "query" — the message asks about transactions already recorded ("how much on food",',
    '   "what did I spend at bpi"). Fill query with only the filters the message implies,',
    "   and leave items empty.",
    'C. "balance" — the message asks how much is in an account RIGHT NOW ("how much do I',
    '   have", "balance", "how much is in maya", "my bpi balance"). Set query.account only',
    "   when one account is named; leave query null for all accounts. Leave items empty.",
    'D. "undo" — the message asks to take back / cancel / delete what was just logged.',
    "   Leave items and query null.",
    "",
    "RULES:",
    "1. Date must be ISO yyyy-MM-dd. If no date is mentioned, use: " + today,
    "2. Category must exactly match a name from VALID CATEGORIES (case-sensitive)",
    "3. Account must exactly match a name from VALID ACCOUNTS (case-sensitive)",
    "4. Amount must be a positive number",
    "5. For a transfer between accounts: use a Transfer-type category and set BOTH ToAccount and ToAmount",
    "6. ExchangeRate is PHP per 1 USD — only set it if explicitly mentioned, otherwise null",
    "7. If it is not a transfer, ToAccount and ToAmount must be null",
    '8. query.month is yyyy-MM; "this month" is ' + today.slice(0, 7) + ", and no period mentioned means null (all time)",
    '9. Past spending/earning is "query"; money sitting in an account today is "balance"',
    "10. If the message is none of the four intents, set error to a short reason and leave the rest null",
    '11. Description: use normal capitalization even if the source shouts ("SM SUPERMARKET" -> "SM Supermarket");',
    "    keep all-caps only for names that are genuinely all-caps (acronyms, brands like BPI, SM, GCash)",
    "12. Leave reference/confirmation/transaction numbers out of the Description"
  ].join("\n");
}

// ── replies ───────────────────────────────────────────────────────────────────
/** The confirmation message. `status` is "success" or "duplicate" (retried update). */
function tg_receipt_(p, status) {
  const lines = [status === "duplicate" ? "✦ *Already logged*" : "✦ *Logged*",
                 "› _" + p.Date + "_",
                 "› _" + p.Category + "_",
                 "› _" + (p.Description || "") + "_",
                 "› _" + p.Account + "_",
                 "› `" + p.Amount + "`"];
  if (p.ToAccount) lines.push("› To: _" + p.ToAccount + "_");
  if (p.ToAmount)  lines.push("› `" + p.ToAmount + "`");
  return lines.join("\n");
}

/**
 * sendMessage. A description containing `_` or `*` makes Telegram reject the whole
 * Markdown message (400) — so a rejected send is retried as plain text rather than
 * silently swallowing the only feedback the user gets.
 */
function tg_send_(chatId, text, replyTo, keyboard) {
  const p = { chat_id: chatId, text: text };
  if (replyTo)  p.reply_to_message_id = replyTo;
  if (keyboard) p.reply_markup = { inline_keyboard: keyboard };
  tg_api_("sendMessage", p);
}

/** Rewrite a message in place (drops its inline keyboard — no reply_markup sent). */
function tg_edit_(chatId, messageId, text) {
  tg_api_("editMessageText", { chat_id: chatId, message_id: messageId, text: text });
}

/** Bot API call with the Markdown→plain retry above. */
function tg_api_(method, payload) {
  const post = function (p) {
    return UrlFetchApp.fetch(TG_API_ + cfgTelegramToken_() + "/" + method,
      { method: "post", contentType: "application/json",
        payload: JSON.stringify(p), muteHttpExceptions: true });
  };
  const res = post(Object.assign({ parse_mode: "Markdown" }, payload));
  if (res.getResponseCode() !== 200) post(payload);   // markdown rejected → plain text
}

function tg_msg_(err) { return (err && err.message) ? err.message : String(err); }

// ── setup helpers (run from the Apps Script editor) ───────────────────────────
/**
 * Point Telegram at the Cloudflare Worker proxy (WEBHOOK_URL). Run once, and
 * again whenever the Worker URL or the secret changes.
 *
 * Telegram cannot be pointed straight at this deployment: /exec answers a POST
 * with a 302 and Telegram rejects it outright ("Wrong response from the webhook:
 * 302 Found"), redelivering for as long as it can. The Worker in worker/ exists
 * only to answer 200 and forward the update here. Latency stays instant.
 */
function tg_setWebhook() {
  const url = cfg_("WEBHOOK_URL", "");
  if (!url) throw new Error("Set the WEBHOOK_URL script property to the Cloudflare Worker URL first (see worker/).");
  // callback_query = the Undo button under a receipt; without it Telegram drops taps.
  const payload = { url: url, allowed_updates: ["message", "callback_query"], drop_pending_updates: true };
  const secret = cfg_("TELEGRAM_SECRET_TOKEN", "");
  if (secret) payload.secret_token = secret;   // the Worker checks this header
  const res = UrlFetchApp.fetch(TG_API_ + cfgTelegramToken_() + "/setWebhook",
    { method: "post", contentType: "application/json", muteHttpExceptions: true,
      payload: JSON.stringify(payload) });
  Logger.log(res.getContentText());
}

/**
 * Where the SPA lives, for the receipt's "Edit details" button — the Cloudflare
 * Worker root, i.e. WEBHOOK_URL minus its /tg suffix. Derived rather than given a
 * fourth Script Property. NOT WEB_APP_URL: that is the GAS /exec endpoint, which
 * since v1.6.0 answers JSON instead of the UI, so a button pointing there is a
 * dead end.
 */
function tg_appUrl_() {
  return cfg_("WEBHOOK_URL", "").replace(/\/tg\/?$/, "");
}

/** Print the URL to store as the Worker's GAS_URL secret (token included if set). */
function tg_gasEndpoint() {
  const base = cfg_("WEB_APP_URL", "");
  if (!base) throw new Error("Set the WEB_APP_URL script property to the /exec deployment URL first.");
  const token = cfgApiToken_();
  Logger.log(base + "?action=telegram" + (token ? "&token=" + encodeURIComponent(token) : ""));
}

/** What Telegram thinks the webhook is — check `last_error_message` after a test. */
function tg_webhookInfo() {
  Logger.log(UrlFetchApp.fetch(TG_API_ + cfgTelegramToken_() + "/getWebhookInfo").getContentText());
}

/** Unhook the bot (e.g. to hand it back to n8n during a rollback). */
function tg_deleteWebhook() {
  Logger.log(UrlFetchApp.fetch(TG_API_ + cfgTelegramToken_() + "/deleteWebhook",
    { method: "post", muteHttpExceptions: true }).getContentText());
}
