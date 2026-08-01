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
 * (+ WEB_APP_URL, used only by tg_setWebhook).
 */

const TG_API_    = "https://api.telegram.org/bot";
// Tried in order; the next one is used if the previous errors (overload, 5xx,
// a model id that stopped existing). Cheapest-capable first.
const TG_MODELS_ = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"];
const TG_HELP_  = "✦ Just send a transaction in plain language.\n" +
                  "e.g. `lunch 250 maya` or `moved 5k from bpi to maribank`\n" +
                  "Several in one message work too (one per line).\n" +
                  "Ask questions: `how much on food this month`\n" +
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
    intent: { type: "STRING", description: '"log" to record transactions, "query" to answer a question about past ones, "undo" to take back the previous message' },
    items:  { type: "ARRAY", nullable: true, items: TG_TX_SCHEMA_,
              description: "One entry per transaction in the message (intent=log). A message may contain several." },
    query:  { type: "OBJECT", nullable: true, description: "Filters for intent=query; omit the ones the message does not imply",
              properties: {
                month:    { type: "STRING", nullable: true, description: "Month to restrict to, yyyy-MM. Null means all time" },
                category: { type: "STRING", nullable: true, description: "Exact match from VALID CATEGORIES" },
                account:  { type: "STRING", nullable: true, description: "Exact match from VALID ACCOUNTS" },
                search:   { type: "STRING", nullable: true, description: "Free-text words to match in the description" }
              } },
    error:  { type: "STRING", nullable: true, description: "Short error message if the message is neither a transaction, a question about them, nor an undo; else null" }
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
    if (text.slice(1).split(/[\s@]/)[0] === "undo") tg_undo_(chat, replyTo);
    else tg_send_(chat, TG_HELP_, replyTo);
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

  if (parsed.intent === "undo")  { tg_undo_(chat, replyTo); return; }
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
  tg_logItems_(chat, update.update_id, items, replyTo);
}

// ── log (one or many transactions per message) ────────────────────────────────
/**
 * Create every parsed item, reply once, and remember the IDs for undo. A failing
 * item reports itself and the rest still land — a five-line message shouldn't be
 * lost because line three named an account that doesn't exist.
 *
 * ponytail: one service call per item. There is no bulk create, and a message
 * carries a handful of transactions, not hundreds.
 */
function tg_logItems_(chat, updateId, items, replyTo) {
  const out = [], ids = [];
  items.forEach(function (p, i) {
    const args = {
      ID:           "tg-" + updateId + "-" + i,        // idempotent under Telegram retries
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
    } catch (err) {
      out.push("❌ *Failed to add transaction*\n› " + tg_msg_(err));
    }
  });
  // Only the rows that actually landed, so undo can't chase a failed item.
  if (ids.length) PropertiesService.getScriptProperties().setProperty(TG_LAST_IDS_, JSON.stringify(ids));
  tg_send_(chat, out.join("\n\n"), replyTo);
}

// ── undo (the last logged message) ────────────────────────────────────────────
/**
 * Delete the rows written by the previous message. One level deep, and the
 * pointer is cleared afterwards so a second "undo" can't delete someone else's
 * row once these IDs are gone. Script Properties, not CacheService: an undo an
 * hour later must still work.
 */
function tg_undo_(chat, replyTo) {
  const props = PropertiesService.getScriptProperties();
  let ids = [];
  try { ids = JSON.parse(props.getProperty(TG_LAST_IDS_) || "[]"); } catch (err) { ids = []; }
  if (!ids.length) { tg_send_(chat, "✦ *Nothing to undo.*", replyTo); return; }

  const out = ["↩︎ *Removed*"];
  ids.forEach(function (id) {
    try {
      const t = api_deleteTransaction({ ID: id }).transaction;
      out.push("› _" + t.Category + "_ " + tg_php_(t["Amount (PHP)"] || t.Amount));
    } catch (err) {
      out.push("› ❌ " + tg_msg_(err));
    }
  });
  props.deleteProperty(TG_LAST_IDS_);
  tg_send_(chat, out.join("\n"), replyTo);
}

// ── query / read-back ─────────────────────────────────────────────────────────
/** Answer a "how much on X" message from the ledger. */
function tg_queryReply_(query) {
  const args = tg_queryFilters_(query);
  const res  = api_listTransactions(args);
  const label = [args.category, args.account, args.search, args.month || "all time"]
    .filter(Boolean).join(" · ");
  return "🔎 *" + label + "*\n" + tg_querySummary_(res.transactions, res.total);
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

function tg_php_(n) {
  return "₱" + Math.abs(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

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
    'C. "undo" — the message asks to take back / cancel / delete what was just logged.',
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
    "9. If the message is none of the three intents, set error to a short reason and leave the rest null"
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
function tg_send_(chatId, text, replyTo) {
  const post = function (payload) {
    return UrlFetchApp.fetch(TG_API_ + cfgTelegramToken_() + "/sendMessage",
      { method: "post", contentType: "application/json",
        payload: JSON.stringify(payload), muteHttpExceptions: true });
  };
  const base = { chat_id: chatId, text: text };
  if (replyTo) base.reply_to_message_id = replyTo;

  const res = post(Object.assign({ parse_mode: "Markdown" }, base));
  if (res.getResponseCode() !== 200) post(base);   // markdown rejected → plain text
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
  const payload = { url: url, allowed_updates: ["message"], drop_pending_updates: true };
  const secret = cfg_("TELEGRAM_SECRET_TOKEN", "");
  if (secret) payload.secret_token = secret;   // the Worker checks this header
  const res = UrlFetchApp.fetch(TG_API_ + cfgTelegramToken_() + "/setWebhook",
    { method: "post", contentType: "application/json", muteHttpExceptions: true,
      payload: JSON.stringify(payload) });
  Logger.log(res.getContentText());
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
