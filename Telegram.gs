/**
 * Telegram.gs — the Telegram bot, running directly in Apps Script (no n8n).
 *
 * Telegram POSTs each update to the Web App URL with `?action=telegram` (see
 * tg_setWebhook), the router dispatches it here, and this file does what the n8n
 * workflow used to do: authorize the sender, parse the message with Gemini into a
 * structured transaction, hand it to the service layer, and reply in the chat.
 *
 * Notes on the two things that made this look hard from the n8n side:
 *   • ContentService's 302 — irrelevant. Telegram only needs the delivery to not
 *     fail; the bot's reply is sent out-of-band via sendMessage, not in the body.
 *   • update_id dedup — real, and it takes two layers. `tg_seen_` claims the
 *     update_id in CacheService before any work, so a redelivery is answered
 *     instantly instead of re-running the slow path; the deterministic
 *     "tg-<update_id>" transaction ID (both create paths are idempotent on a
 *     supplied ID) then guarantees no second row if one slips through anyway.
 *
 * Script Properties required: TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, GEMINI_API_KEY
 * (+ WEB_APP_URL, used only by tg_setWebhook).
 */

const TG_API_   = "https://api.telegram.org/bot";
const TG_MODEL_ = "gemini-flash-latest";
const TG_HELP_  = "✦ Just send a transaction in plain language.\n" +
                  "e.g. `lunch 250 maya` or `moved 5k from bpi to maribank`\n" +
                  "_(/sync is gone — categories and accounts are read live.)_";

// Gemini structured-output schema (OpenAPI subset: nullable, not union types).
// Only `error` is required — a non-transaction message must be able to come back
// as {error:"..."} without the model inventing a Category/Account to satisfy it.
const TG_SCHEMA_ = {
  type: "OBJECT",
  properties: {
    Date:         { type: "STRING", description: "Transaction date, ISO yyyy-MM-dd" },
    Category:     { type: "STRING", description: "Exact match from VALID CATEGORIES" },
    Description:  { type: "STRING", description: "Concise description, max 256 chars" },
    Account:      { type: "STRING", description: "Exact match from VALID ACCOUNTS (source account)" },
    Amount:       { type: "NUMBER", description: "Positive amount leaving/entering the source account" },
    ExchangeRate: { type: "NUMBER", nullable: true, description: "PHP per 1 USD, only if explicitly mentioned" },
    ToAccount:    { type: "STRING", nullable: true, description: "Destination account, transfers only" },
    ToAmount:     { type: "NUMBER", nullable: true, description: "Amount received in the destination account, transfers only" },
    error:        { type: "STRING", nullable: true, description: "Short error message if this is not a financial transaction, else null" }
  },
  required: ["error"]
};

// ── webhook entry point (Router: ROUTES_WRITE_.telegram) ──────────────────────
/**
 * Always returns success: a non-2xx tells Telegram to redeliver, and a message we
 * already failed to parse will fail again. Problems are reported in the chat.
 */
function tg_webhook_(e, body) {
  try {
    if (tg_seen_(body && body.update_id)) return { status: "success", message: "duplicate update" };
    tg_handleUpdate_(body);
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
  if (text.charAt(0) === "/") { tg_send_(chat, TG_HELP_, replyTo); return; }

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

  const args = {
    ID:           "tg-" + update.update_id,            // idempotent under Telegram retries
    Date:         parsed.Date,
    Category:     parsed.Category,
    Description:  parsed.Description,
    Account:      parsed.Account,
    Amount:       parsed.Amount,
    ExchangeRate: parsed.ExchangeRate,
    ToAccount:    parsed.ToAccount,
    ToAmount:     parsed.ToAmount
  };
  try {
    // Transfers were never possible over the old bare-body POST (it always hit
    // api_createTransaction, which rejects Transfer categories). Route them now.
    const res = parsed.ToAccount ? api_createTransfer(args) : api_createTransaction(args);
    tg_send_(chat, tg_receipt_(parsed, res.status), replyTo);
  } catch (err) {
    tg_send_(chat, "❌ *Failed to add transaction*\n› " + tg_msg_(err), replyTo);
  }
}

// ── Gemini parse ──────────────────────────────────────────────────────────────
/** Message text → the structured transaction object. Throws on API/parse failure. */
function tg_parse_(text, unixDate) {
  const key = cfgGeminiKey_();
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  const res = UrlFetchApp.fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + TG_MODEL_ +
      ":generateContent?key=" + encodeURIComponent(key),
    { method: "post", contentType: "application/json", muteHttpExceptions: true,
      payload: JSON.stringify({
        systemInstruction: { parts: [{ text: tg_prompt_(unixDate) }] },
        contents: [{ role: "user", parts: [{ text: text }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json",
                            responseSchema: TG_SCHEMA_ }
      })
    });
  if (res.getResponseCode() !== 200)
    throw new Error("Gemini " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
  return JSON.parse(tg_geminiText_(JSON.parse(res.getContentText())));
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
    "You are a financial transaction parser. Extract structured data from the user's message.",
    "",
    'VALID CATEGORIES ("Name" (Type) - Description):', cats,
    "",
    'VALID ACCOUNTS ("Name" (Currency)):', accts,
    "",
    "RULES:",
    "1. Date must be ISO yyyy-MM-dd. If no date is mentioned, use: " + today,
    "2. Category must exactly match a name from VALID CATEGORIES (case-sensitive)",
    "3. Account must exactly match a name from VALID ACCOUNTS (case-sensitive)",
    "4. Amount must be a positive number",
    "5. For a transfer between accounts: use a Transfer-type category and set BOTH ToAccount and ToAmount",
    "6. ExchangeRate is PHP per 1 USD — only set it if explicitly mentioned, otherwise null",
    "7. If it is not a transfer, ToAccount and ToAmount must be null",
    "8. If the message is not a financial transaction, set error to a short reason and leave the rest null"
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
/** Point Telegram at this deployment. Run once, and again after any URL change. */
function tg_setWebhook() {
  const base = cfg_("WEB_APP_URL", "");
  if (!base) throw new Error("Set the WEB_APP_URL script property to the /exec deployment URL first.");
  const token = cfgApiToken_();
  const url = base + "?action=telegram" + (token ? "&token=" + encodeURIComponent(token) : "");
  const res = UrlFetchApp.fetch(TG_API_ + cfgTelegramToken_() + "/setWebhook",
    { method: "post", contentType: "application/json", muteHttpExceptions: true,
      payload: JSON.stringify({ url: url, allowed_updates: ["message"], drop_pending_updates: true }) });
  Logger.log(res.getContentText());
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
