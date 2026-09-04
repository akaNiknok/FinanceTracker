/**
 * Gmail.gs — the mail courier. One of the two files left in Apps Script after v2.0.0.
 *
 * WHY THIS IS STILL HERE. GmailApp is free, already-granted OAuth to the owner's
 * mailbox, and there is no off-platform equivalent: an IMAP/Pub-Sub setup would be a
 * second credential, a second thing to renew, and a second thing to debug. So the
 * mailbox side stayed and everything else left. This job no longer parses anything
 * and no longer writes anywhere — it posts the email's fields to the Worker's
 * ingestEmail endpoint and trashes the mail only if the Worker says every item landed.
 *
 * Everything the owner touches is unchanged: the Gmail filter that applies the
 * "Finance Tracker" label still decides which mail counts, the inbox is still the
 * not-yet-logged list, the watermark still means one look per message, and the
 * Telegram receipt (↻ Undo, ✎ Edit details, ⌕ Email) is identical because the Worker
 * runs the same logItems the bot does.
 *
 * Trigger: time-based, every 5 minutes.
 * Script Properties:
 *   WORKER_URL    — the Cloudflare Worker root (no trailing slash, no /tg).
 *   INGEST_TOKEN  — must equal the Worker secret of the same name.
 *   GMAIL_QUERY   — overrides GMAIL_QUERY_ (only to change the SCOPE; adding a sender
 *                   is a Gmail-filter edit, not this).
 *   GMAIL_HINTS   — overrides GMAIL_HINTS_: free text appended to the parser prompt
 *                   for facts the mail itself never states.
 *   GMAIL_LAST_TS — the watermark, managed here; delete it to re-ingest.
 */

const GMAIL_LAST_TS_    = "GMAIL_LAST_TS";
// A post that THREW is RETRIED: the watermark stops just below that message instead of
// stepping over it (2026-09-04 — three MariBank alerts were lost that way, see
// gmail_ingest). The window bounds it, because a message that fails every time would
// otherwise spend a Gemini call every five minutes for ever, and the free tier gives
// about 250 a day.
// ponytail: a time window, not an attempt counter — no second Script Property to keep
// in step. Raise it if a real outage ever outlasts it.
const GMAIL_RETRY_MS_   = 3 * 60 * 60 * 1000;   // 3 hours, so about 36 tries
const GMAIL_MAX_BODY_   = 3000;   // notification mail says everything up top; footers are noise
const GMAIL_QUOTE_BODY_ = 1200;   // the ⌕ Email quote is for eyes, not for the parser
const GMAIL_MAX_THREADS_ = 20;

// The sender list lives in a Gmail filter that applies this label — that is the whole
// point of keying on it: the owner edits the filter, the job needs no change. (Senders
// seen when this was built, 2026-08-11: alerts@maribank.com.ph "Successful Debit Card
// Transaction", mail.anthropic.com Stripe receipts, wise.com — historical note only.)
// `in:inbox` is the other half of the scope: mail this job has not logged yet.
// Everything logged is trashed on the spot, so the inbox is also the to-do list — and
// no `newer_than:` is needed, because nothing that was handled is still in it.
// Search matches *threads* and the loop below reads every message in them, so a label
// on one message pulls in its siblings. That is wanted (MariBank's alerts share one
// thread) and the watermark still means each message is looked at once.
const GMAIL_LABEL_ = "Finance Tracker";
const GMAIL_QUERY_ = 'in:inbox label:"' + GMAIL_LABEL_ + '"';

// The account is the one thing these emails never state — an Anthropic receipt names
// a card ("Payment method - 8681"), never the account it belongs to. Sent to the
// Worker with each message rather than duplicated there: the hint is about the MAIL,
// so it belongs next to the mailbox.
const GMAIL_HINTS_ = "Anthropic / Stripe receipts are charged to the Wise account.";

/** Read a Script Property, with a fallback. The only config helper left in GAS. */
function cfg_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === "") ? fallback : v;
}

/**
 * The trigger entry point. Every message newer than the watermark is posted to the
 * Worker and, if it described money moving, is trashed.
 *
 * Trashing does not replace the two guards against a double post: the watermark (a
 * message is only *looked at* once — mail that parsed as "not a transaction" stays in
 * the inbox and must not be re-parsed every five minutes) and the deterministic
 * "gm-<messageId>-<i>" row id, which both create paths treat as idempotent.
 *
 * On a 5-minute trigger a run can still be mid-request when the next fires, and
 * neither guard covers that: the watermark is written at the end and the mail is
 * trashed only after it lands, so the second run re-finds the same message. The rows
 * would survive (idempotent id) but the owner would get a second Telegram receipt.
 * ponytail: USER lock, not a script lock — this run holds it for minutes.
 * tryLock(0) = skip this tick, the next one is five minutes away.
 *
 * A POST THAT THREW HOLDS THE WATERMARK BACK. This used to step over it, and that lost
 * money: on 2026-09-03 and 2026-09-04 three MariBank alerts stayed in the inbox and
 * were never looked at again, because one transient Gemini failure each moved the mark
 * past them. The mark now stops at the OLDEST failure in the run, so the next tick
 * retries it even when a later message succeeded.
 *
 * The old comment feared that this would replay an unparseable email for ever. It
 * cannot: an email that is genuinely not a transaction comes back HTTP 200 with
 * logged 0 of 0, which is a SUCCESS here — the mail simply stays in the inbox. Only a
 * real fault (Gemini 429/5xx/timeout, the Worker down, a bad token) throws, and that is
 * exactly what deserves another try. GMAIL_RETRY_MS_ caps how long it gets one.
 */
function gmail_ingest() {
  if (!LockService.getUserLock().tryLock(0)) return;

  const q = cfg_("GMAIL_QUERY", GMAIL_QUERY_);
  const hints = cfg_("GMAIL_HINTS", GMAIL_HINTS_);
  const since = Number(cfg_(GMAIL_LAST_TS_, 0)) || 0;
  const now = Date.now();
  let newest = since;
  let hold = Infinity;      // the mark must not reach the oldest message that failed

  GmailApp.search(q, 0, GMAIL_MAX_THREADS_).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const ts = msg.getDate().getTime();
      if (ts <= since) return;
      newest = Math.max(newest, ts);
      try {
        const res = gmail_post_(gmail_payload_(msg, hints));
        // Per message, never per thread: MariBank's alerts share one subject and one
        // thread, so thread.moveToTrash() would bin transactions never logged.
        if (res.total > 0 && res.logged === res.total) msg.moveToTrash();
      } catch (err) {
        // Hold the mark below this message so the next tick tries again. Give up after
        // GMAIL_RETRY_MS_ — then the mail stays in the inbox as the visible to-do.
        const retrying = now - ts < GMAIL_RETRY_MS_;
        if (retrying) hold = Math.min(hold, ts - 1);
        // WARN while the message still has tries left, ERROR only when it is abandoned.
        // Gemini answers 503 "high demand" or runs long often enough that an error per
        // tick made the log unreadable, and a self-healing failure is not news — the
        // next tick logs the same message again 5 minutes later (2026-09-04).
        (retrying ? console.warn : console.error)(
          "gmail_ingest " + msg.getId() + ": " + (err && err.stack ? err.stack : err));
      }
    });
  });

  PropertiesService.getScriptProperties()
    .setProperty(GMAIL_LAST_TS_, String(Math.min(newest, hold)));
}

/**
 * One message -> the ingestEmail payload. The Worker builds the parser prompt out of
 * these fields (gemini.js emailText) and stores `quote` so the receipt's ⌕ Email
 * button can post the mail back into the chat later — the Worker cannot call GmailApp,
 * so the excerpt has to travel with the message.
 *
 * Pure apart from the GmailMessage accessors, so test.js can exercise it with a stub.
 */
function gmail_payload_(msg, hints) {
  return {
    action: "ingestEmail",
    messageId: msg.getId(),
    from: String(msg.getFrom()),
    subject: String(msg.getSubject()),
    date: msg.getDate().toISOString(),
    hints: hints || "",
    body: String(msg.getPlainBody() || "").slice(0, GMAIL_MAX_BODY_),
    quote: gmail_quote_(msg)
  };
}

/**
 * The email as the ⌕ Email button posts it back into the chat — the answer to "did
 * Gemini read this right?" without leaving Telegram.
 *
 * Linking out to Gmail was tried twice and abandoned (2026-08-11). A Telegram button
 * URL must be http(s), and the app scheme it would bounce to (`googlegmail:///cv=<id>`)
 * wants Gmail's opaque web view token (FMfcg…), which cannot be derived from the API id
 * GmailApp returns; the plain web link just loads mail.google.com and sits there.
 *
 * Short body slice, not GMAIL_MAX_BODY_: what is being checked is the merchant/amount
 * line, which notification mail always puts up top, and a 4096-char Telegram message is
 * a wall. Blank-line runs collapse — plaintext-from-HTML bodies are mostly gaps.
 */
function gmail_quote_(msg) {
  const body = String(msg.getPlainBody() || "").replace(/\n{3,}/g, "\n\n").trim();
  return ["✉ " + msg.getSubject(),
          String(msg.getFrom()) + " · " + msg.getDate(),
          "", body.slice(0, GMAIL_QUOTE_BODY_)].join("\n");
}

/** POST the payload to the Worker. Throws on anything that is not a clean success. */
function gmail_post_(payload) {
  const res = UrlFetchApp.fetch(worker_url_("/api"), {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + worker_token_() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) throw new Error("ingestEmail HTTP " + code + ": " + text.slice(0, 200));
  const json = JSON.parse(text);
  if (json.status === "error") throw new Error("ingestEmail: " + json.message);
  return json;
}

/** The Worker endpoint. Shared with Backup.gs (flat namespace). */
function worker_url_(path) {
  const base = cfg_("WORKER_URL", "").replace(/\/+$/, "");
  if (!base) throw new Error("Set the WORKER_URL script property to the Cloudflare Worker root.");
  return base + path;
}
function worker_token_() {
  const t = cfg_("INGEST_TOKEN", "");
  if (!t) throw new Error("Set the INGEST_TOKEN script property (same value as the Worker secret).");
  return t;
}

// ── setup helper (run from the Apps Script editor) ───────────────────────────
/**
 * Print the senders/subjects/bodies of past notification mail, to see what a new
 * sender looks like before pointing the Gmail filter at it. `in:anywhere` on purpose:
 * the best samples are the ones already logged and thrown away. That is a *development*
 * view only — the job itself never reads outside the inbox.
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
