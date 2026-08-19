/**
 * Gmail.gs — log transaction notification emails (MariBank, Anthropic, …) the same
 * way a Telegram message is logged.
 *
 * There is deliberately no per-sender parser: the email text goes through the same
 * Gemini parse the bot uses (tg_parse_, live Categories/Accounts inlined) and the
 * same tg_logItems_, so the receipt in Telegram is identical — ↻ Undo and ✎ Edit
 * details, plus a ⌕ Email button that quotes the mail it came from.
 *
 * Which mail counts is decided in Gmail, not here: a Gmail filter labels transaction
 * notifications "Finance Tracker" and this job takes the labelled mail in the inbox.
 * Adding or dropping a sender is editing that filter — no code, no push, no deploy.
 *
 * Once logged, the email is moved to the trash (recoverable, and the same thing the
 * owner did by hand), which is what keeps the inbox meaning "not yet logged".
 *
 * Run from a time-based trigger (every 5 minutes; see gmail_ingest on overlap).
 * Script Properties (all optional):
 *   GMAIL_QUERY   — overrides GMAIL_QUERY_ below (only needed to change the scope
 *                   itself; adding a sender is a Gmail-filter edit, not this).
 *   GMAIL_HINTS   — overrides GMAIL_HINTS_: free text appended to the parser prompt
 *                   for facts the email itself doesn't carry.
 *   GMAIL_LAST_TS — watermark, managed here; delete it to re-ingest the window.
 */

const GMAIL_LAST_TS_   = "GMAIL_LAST_TS";
const GMAIL_MAX_BODY_  = 3000;   // notification mail says everything up top; footers are noise
const GMAIL_QUOTE_BODY_ = 1200;  // ⌕ Email quotes less than the parser reads — it's for eyes
const GMAIL_MAX_THREADS_ = 20;

// The sender list lives in a Gmail filter that applies this label — that is the whole
// point of keying on it: the owner edits the filter, the job needs no change. (Senders
// seen when this was built, 2026-08-11: alerts@maribank.com.ph "Successful Debit Card
// Transaction", mail.anthropic.com Stripe receipts, wise.com — historical note only.)
// `in:inbox` is the other half of the scope: mail this job hasn't logged yet. Everything
// logged is trashed on the spot (gmail_ingest), so the inbox is also the to-do list — and
// no `newer_than:` is needed, because nothing that was handled is still in it.
// Search matches *threads* but the loop below reads every message in them, so a label on
// one message pulls in its thread siblings. That is wanted — MariBank's alerts all share
// a single thread — and the watermark still means each message is looked at once.
const GMAIL_LABEL_ = "Finance Tracker";
const GMAIL_QUERY_ = 'in:inbox label:"' + GMAIL_LABEL_ + '"';

// The account is the one thing these emails don't state — an Anthropic receipt names
// a card ("Payment method - 8681"), never the account it belongs to.
const GMAIL_HINTS_ = "Anthropic / Stripe receipts are charged to the Wise account.";

/**
 * The trigger entry point. Every message newer than the watermark is parsed and,
 * if it describes money moving, written through the service layer and announced
 * in Telegram.
 *
 * A logged email is moved to the trash, so the inbox stays the to-do list. Only when
 * *every* item landed: a partial failure leaves the mail where the owner will see it.
 * Per message, never per thread — MariBank's alerts all share one subject, so
 * thread.moveToTrash() would bin transactions that were never logged.
 *
 * Trashing does not replace the two guards against a double post: the watermark (a
 * message is only *looked at* once — mail that parsed as "not a transaction" stays
 * in the inbox and must not be re-parsed hourly) and the deterministic
 * "gm-<messageId>-<i>" row ID, which both create paths treat as idempotent.
 *
 * On a 5-minute trigger a run can still be mid-Gemini when the next one fires, and
 * neither guard covers that: the watermark is only written at the end and the mail is
 * only trashed after it lands, so the second run re-finds the same message. The rows
 * would survive (idempotent ID) but the owner would get a second Telegram receipt.
 */
function gmail_ingest() {
  // ponytail: USER lock, not su_lock_()'s script lock — this run holds it for minutes,
  // and the script lock would both deadlock its own api_createTransaction calls and
  // freeze the bot/UI meanwhile. tryLock(0) = skip this tick, the next one is 5 min away.
  if (!LockService.getUserLock().tryLock(0)) return;

  const q = cfg_("GMAIL_QUERY", GMAIL_QUERY_);
  const chat = cfgTelegramUserId_();
  const since = Number(cfg_(GMAIL_LAST_TS_, 0)) || 0;
  let newest = since;

  GmailApp.search(q, 0, GMAIL_MAX_THREADS_).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const ts = msg.getDate().getTime();
      if (ts <= since) return;
      newest = Math.max(newest, ts);
      // ponytail: a message that blows up is logged and skipped, and the watermark
      // still moves past it — otherwise one unparseable email replays every hour
      // forever. Re-ingest by clearing GMAIL_LAST_TS.
      try {
        const items = gmail_items_(msg);
        if (!items.length) return;
        const ids = tg_logItems_(chat, "gm-" + msg.getId(), items, null, msg.getId());
        if (ids.length === items.length) msg.moveToTrash();
      } catch (err) {
        console.error("gmail_ingest " + msg.getId() + ": " + (err && err.stack ? err.stack : err));
      }
    });
  });

  PropertiesService.getScriptProperties().setProperty(GMAIL_LAST_TS_, String(newest));
}

/** One email → the transactions it reports (empty when it reports none). */
function gmail_items_(msg) {
  const text = gmail_text_(msg, cfg_("GMAIL_HINTS", GMAIL_HINTS_));
  const parsed = tg_parse_(text, Math.floor(msg.getDate().getTime() / 1000));
  // Intent is ignored: an email is never a question or an undo. Only `error`
  // (rule 10 of the prompt) decides whether this was a transaction at all.
  return parsed.error ? [] : (parsed.items || []);
}

/**
 * The text handed to the parser. The leading instructions are what the chat prompt
 * can't cover: a chat message is sent *because* it's a transaction, whereas a
 * receipt-shaped marketing email is still not one. `hints` is passed in rather than
 * read here so this stays a pure function (test_gmailText).
 */
function gmail_text_(msg, hints) {
  return [
    "The following is an email notification, not a chat message.",
    "If it does not report money that has actually moved (a payment, charge,",
    "transfer or credit that already happened), set error and log nothing.",
    "The amount to log is the total actually charged or received, tax included.",
    hints || "",
    "",
    "From: " + msg.getFrom(),
    "Subject: " + msg.getSubject(),
    "Date: " + msg.getDate(),
    "",
    String(msg.getPlainBody() || "").slice(0, GMAIL_MAX_BODY_)
  ].join("\n");
}

/**
 * The email itself, as the ⌕ Email button posts it back into the chat — the answer to
 * "did Gemini read this right?" without leaving Telegram.
 *
 * Linking out to Gmail was tried twice and abandoned (2026-08-11). A Telegram button
 * URL must be http(s), so the app can only be reached by bouncing off the Worker, and
 * the app-scheme it would bounce to (`googlegmail:///cv=<id>`) wants Gmail's opaque web
 * "view token" (FMfcg…), which cannot be derived from the API id GmailApp returns —
 * it threw "Unable to understand the link". The plain web link is no better: Safari
 * just loads mail.google.com and sits there. Since the bot is already holding the
 * mail, quoting it is both simpler and more useful than any link would have been.
 *
 * Short body slice, not GMAIL_MAX_BODY_: what's being checked is the merchant/amount
 * line, which notification mail always puts up top, and a 4096-char Telegram message
 * is a wall. Blank-line runs collapse — plaintext-from-HTML bodies are mostly gaps.
 */
function gmail_quote_(msg) {
  const body = String(msg.getPlainBody() || "").replace(/\n{3,}/g, "\n\n").trim();
  return ["✉ " + msg.getSubject(),
          String(msg.getFrom()) + " · " + msg.getDate(),
          "", body.slice(0, GMAIL_QUOTE_BODY_)].join("\n");
}

// ── setup helper (run from the Apps Script editor) ────────────────────────────
/**
 * Print the senders/subjects/bodies of past notification mail, to see what a new
 * sender looks like before pointing the Gmail filter at it. `in:anywhere` on purpose:
 * the best samples are the ones already logged by hand and thrown away. That is a
 * *development* view only — the job itself never reads outside the inbox.
 *
 * Usage: gmail_dumpSamples()                 — everything ever labelled, trash included
 *        gmail_dumpSamples(GMAIL_QUERY_)     — exactly what the next run will see
 *        gmail_dumpSamples("from:bpi.com.ph", 6)
 */
function gmail_dumpSamples(query, limit) {
  const q = query || 'in:anywhere label:"' + GMAIL_LABEL_ + '"';
  const threads = GmailApp.search(q, 0, limit || 8);
  Logger.log("query: %s → %s threads", q, threads.length);
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      Logger.log("────────────────────────────\nfrom: %s\nsubject: %s\ndate: %s\nlabels: %s\n\n%s",
        m.getFrom(), m.getSubject(), m.getDate(),
        t.getLabels().map(function (l) { return l.getName(); }).join(",") || "(none)",
        String(m.getPlainBody() || "").slice(0, 1200));
    });
  });
}
