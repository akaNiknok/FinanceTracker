/**
 * Gmail.gs — log transaction notification emails (MariBank, Anthropic, …) the same
 * way a Telegram message is logged.
 *
 * There is deliberately no per-sender parser: the email text goes through the same
 * Gemini parse the bot uses (tg_parse_, live Categories/Accounts inlined) and the
 * same tg_logItems_, so the receipt in Telegram is identical — ↻ Undo and ✎ Edit
 * details, plus a ⌕ Email button back to the mail it came from. A new sender needs
 * no code, only a wider GMAIL_QUERY.
 *
 * Once logged, the email is moved to the trash (recoverable, and the same thing the
 * owner did by hand), which is what keeps the inbox meaning "not yet logged".
 *
 * Run from a time-based trigger (hourly is plenty). Script Properties (all optional):
 *   GMAIL_QUERY   — overrides GMAIL_QUERY_ below (add a sender, widen the window).
 *   GMAIL_HINTS   — overrides GMAIL_HINTS_: free text appended to the parser prompt
 *                   for facts the email itself doesn't carry.
 *   GMAIL_LAST_TS — watermark, managed here; delete it to re-ingest the window.
 */

const GMAIL_LAST_TS_   = "GMAIL_LAST_TS";
const GMAIL_MAX_BODY_  = 3000;   // notification mail says everything up top; footers are noise
const GMAIL_MAX_THREADS_ = 20;

// Senders confirmed from the real mailbox (2026-08-11):
//   alerts@maribank.com.ph — "Successful Debit Card Transaction", body carries
//                            "Transaction Amount: PHP 369.00 Merchant: …"
//   mail.anthropic.com     — "Your receipt from Anthropic, PBC #…" (Stripe; USD + PH VAT)
//   wise.com               — "Money received from …" (the Pareto salary), "Transfer sent (#…)"
// `in:inbox` is the whole scope: mail this job hasn't logged yet. Everything logged
// is trashed on the spot (gmail_ingest), so the inbox is also the to-do list — and
// no `newer_than:` is needed, because nothing that was handled is still in it.
const GMAIL_QUERY_ = "in:inbox (from:alerts@maribank.com.ph OR from:mail.anthropic.com OR from:wise.com)";

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
 */
function gmail_ingest() {
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
        const ids = tg_logItems_(chat, "gm-" + msg.getId(), items, null,
                                 gmail_link_(msg, cfg_("WEBHOOK_URL", "")));
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
 * A URL that opens this email — the receipt's ⌕ Email button, for checking what a
 * row was logged from.
 *
 * Prefers the Worker's /mail bounce (`base`, the same Worker Telegram delivers to),
 * which is the only way to reach the **Gmail iOS app**: a Telegram button URL must be
 * http(s), and mail.google.com is not a Gmail universal link — confirmed on the
 * owner's phone, Safari just loads the web page. Without a Worker URL configured it
 * degrades to that same web link.
 *
 * The web form searches `rfc822msgid` rather than the obvious "#all/<id>" permalink,
 * because by the time anyone taps the button the mail has been trashed, and Gmail's
 * All Mail excludes the trash — `in:anywhere` is what makes the link survive its own
 * job. ponytail: /u/0 is the first signed-in account. Right on a one-account phone,
 * which is where these get tapped; add an account index only if it's ever wrong.
 */
function gmail_link_(msg, base) {
  const mid = String(msg.getHeader("Message-ID") || "").replace(/[<>]/g, "");
  if (base) return String(base).replace(/\/+$/, "") + "/mail?id=" + encodeURIComponent(msg.getId()) +
                  (mid ? "&mid=" + encodeURIComponent(mid) : "");
  if (!mid) return "";
  return "https://mail.google.com/mail/u/0/#search/" +
         encodeURIComponent("rfc822msgid:" + mid + " in:anywhere");
}

// ── setup helper (run from the Apps Script editor) ────────────────────────────
/**
 * Print the senders/subjects/bodies of past notification mail, to see what a new
 * sender looks like before adding it to GMAIL_QUERY_. `in:anywhere` on purpose:
 * the best samples are the ones already logged by hand and thrown away. That is a
 * *development* view only — the job itself never reads outside the inbox.
 *
 * Usage: gmail_dumpSamples()                 — the known senders, trash included
 *        gmail_dumpSamples(GMAIL_QUERY_)     — exactly what the next run will see
 *        gmail_dumpSamples("from:bpi.com.ph", 6)
 */
function gmail_dumpSamples(query, limit) {
  const q = query || "in:anywhere (from:alerts@maribank.com.ph OR from:wise.com OR from:mail.anthropic.com)";
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
