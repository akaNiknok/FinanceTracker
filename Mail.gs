/**
 * Mail.gs — log transactions from bank alert emails.
 *
 * The iPhone angle, solved server-side: iOS gives nothing read access to the
 * notification stream, but the alert that raised the notification is usually also
 * an email. This job reads that email directly, so nothing depends on a Shortcuts
 * automation firing on a locked/asleep/Low-Power phone.
 *
 * Flow (daily/hourly time-driven trigger on `ingestMailTransactions`):
 *   Gmail label → tg_parse_ (the bot's Gemini parser, plus MAIL_RULES_)
 *   → tg_createItems_ (the bot's writer) → tg_send_ (the bot's receipt).
 * Everything after the parse is the Telegram bot's own code path, so an emailed
 * transaction announces itself in exactly the format a typed one does and /undo
 * takes it back the same way.
 *
 * Two independent dedup layers, because either alone has a hole:
 *   • MAIL_SEEN — Gmail message ids already dealt with. Stops a second Gemini call
 *     (and a second notification) on mail we've already judged, including mail we
 *     judged to be *not* a transaction, which leaves no row to detect later.
 *   • The row ID `mail-<messageId>-<i>` — both create paths are idempotent on a
 *     supplied ID, so even a wiped MAIL_SEEN cannot double-post to the ledger.
 * A thread-level "done" label was the obvious third option and is wrong here:
 * Gmail labels are thread-scoped and bank alerts routinely share a subject, so
 * labelling the thread would silently swallow every later alert in it.
 *
 * Setup (owner, one-off): create the Gmail label + a filter that files the alerts
 * into it, then add a time-driven trigger on `ingestMailTransactions` in the Apps
 * Script editor (that's also what prompts for the new Gmail scope). See MEMORY.md.
 */

// Gmail message ids already judged, JSON array, newest first. Bounded: the search
// window bounds how far back a re-check can reach, so the list never needs to
// outlive it. Script Properties, not CacheService — a 6h cache eviction would
// re-notify every alert in the window.
const MAIL_SEEN_     = "MAIL_SEEN";
const MAIL_SEEN_MAX_ = 200;

// Bank alerts are short; the tail of a long one is disclaimers and unsubscribe
// boilerplate. Cap keeps the Gemini call cheap and the signal-to-noise high.
const MAIL_BODY_MAX_ = 4000;

// Appended to the shared bot prompt. The bot's prompt assumes a human typed
// something they meant to log; an inbox is full of mail that merely mentions
// money, and the default reading of "log" would turn a statement summary into a
// row. These rules are the whole difference between the two channels.
const MAIL_RULES_ = [
  "EMAIL RULES (this message is an automated notification email, not something the user typed):",
  "E1. Only log money that has ALREADY moved. An OTP or verification code, a login/security",
  "    alert, a promo, a statement or balance summary, an upcoming-payment reminder, and a",
  "    failed/declined/cancelled transaction are all NOT transactions — set error, items empty.",
  "E2. Never invent a Category or Account. If the email does not identify which of the VALID",
  "    ACCOUNTS the money moved from, set error instead of guessing.",
  "E3. Use the amount actually debited/credited. Ignore running balances, available credit,",
  "    reward points, and cumulative totals.",
  "E4. Ignore signatures, legal disclaimers, and unsubscribe footers.",
  "E5. Most alerts report exactly one transaction; only emit several if the email really",
  "    itemises several completed ones."
].join("\n");

// ── entry point (time-driven trigger target) ─────────────────────────────────
/**
 * Ingest one batch of alert emails. Safe to run by hand from the editor; safe to
 * run twice. `maxMessages` overrides MAIL_MAX_PER_RUN for a manual catch-up.
 *
 * No script lock: the writes take their own (api_createTransaction → su_lock_),
 * and a job-level lock would sit on top of those inner ones. Overlapping runs are
 * already harmless — MAIL_SEEN is saved per message and the row IDs are
 * deterministic, so the worst case is a wasted parse.
 */
function ingestMailTransactions(maxMessages) {
  const cap  = maxMessages || cfgMailMaxPerRun_();
  const msgs = mail_candidates_(cfgMailLabel_(), cfgMailLookbackDays_(), mail_seen_(), cap);
  let logged = 0, skipped = 0, failed = 0;

  msgs.forEach(function (m) {
    try {
      const n = mail_processMessage_(m);
      if (n) logged += n; else skipped++;
      mail_markSeen_(m.getId());   // judged: don't spend another parse on it
    } catch (err) {
      // Transport-ish failure (Gemini overloaded, Sheets hiccup). Leave it unseen
      // so the next run retries; the lookback window bounds how long it can retry.
      failed++;
      console.error("mail: " + m.getId() + " — " + (err && err.stack ? err.stack : err));
    }
  });

  const summary = { status: "success", examined: msgs.length, logged: logged,
                    skipped: skipped, failed: failed };
  Logger.log("mail ingest: " + JSON.stringify(summary));
  return summary;
}

/**
 * One email → rows + a Telegram receipt. Returns how many rows landed (0 = the
 * parser judged it not a transaction, which is the common case for anything that
 * slipped past the Gmail filter).
 */
function mail_processMessage_(m) {
  const body = m.getPlainBody();
  if (!body || !body.trim()) return 0;             // attachment-only / empty: nothing to read

  const text = mail_text_(m.getFrom(), m.getSubject(), body);
  // The email's own date, not now(): an alert read three days late must still
  // resolve "today" to the day the money actually moved.
  const parsed = tg_parse_(text, Math.floor(m.getDate().getTime() / 1000), MAIL_RULES_);

  // intent is a plain string and an inbox is not a chat — anything but a clean
  // "log" is dropped silently rather than routed to the query/undo branches.
  if (parsed.error || parsed.intent !== "log" || !(parsed.items || []).length) return 0;

  const r = tg_createItems_("mail-" + m.getId(), parsed.items);
  // One notification per email, so what /undo removes is exactly what the last
  // notification announced. Receipts are byte-identical to the typed-in ones; the
  // header is the only addition, because an unexplained "✦ Logged" arriving while
  // you're asleep should say where it came from.
  tg_send_(cfgTelegramUserId_(), [mail_header_(m.getFrom())].concat(r.receipts).join("\n\n"));
  return r.ids.length;
}

// ── Gmail ────────────────────────────────────────────────────────────────────
/**
 * The messages worth parsing this run: in the label, inside the window, not yet
 * judged, oldest first (so notifications arrive in the order the money moved and
 * TG_LAST_IDS ends up on the most recent one).
 *
 * Messages are filtered by their own date, not the thread's: a thread matches the
 * window if any message in it does, which would otherwise drag its whole history in.
 */
function mail_candidates_(label, days, seen, cap) {
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  GmailApp.getMessagesForThreads(GmailApp.search(mail_query_(label, days)))
    .forEach(function (thread) {
      thread.forEach(function (m) {
        if (m.getDate().getTime() >= cutoff && seen.indexOf(m.getId()) === -1) out.push(m);
      });
    });
  out.sort(function (a, b) { return a.getDate() - b.getDate(); });
  return out.slice(0, cap);
}

/** Gmail search string. Quoted so a label with spaces still works. */
function mail_query_(label, days) {
  return 'label:"' + label + '" newer_than:' + days + 'd';
}

/**
 * From/Subject/body flattened into what the parser sees. From and Subject stay in
 * — they're usually the only place the bank's name appears, and the name is how
 * the model picks the Account.
 */
function mail_text_(from, subject, body) {
  const clean = String(body || "")
    .replace(/\r/g, "")
    .replace(/^[ \t]+/gm, "")        // quoted-printable indentation, not structure
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAIL_BODY_MAX_);
  return ["From: " + (from || ""), "Subject: " + (subject || ""), "", clean].join("\n");
}

/** '"BPI Alerts" <alerts@bpi.com.ph>' → "📧 *BPI Alerts*" */
function mail_header_(from) {
  return "📧 *" + mail_sender_(from) + "*";
}

/** Display name out of a From header; the bare address if there isn't one. */
function mail_sender_(from) {
  const s = String(from || "").trim();
  const named = s.match(/^"?([^"<]*[^"<\s])"?\s*<[^>]*>$/);
  if (named) return named[1];
  const bare = s.match(/^<?([^<>]+)>?$/);
  return bare ? bare[1].trim() : s;
}

// ── seen-message bookkeeping ─────────────────────────────────────────────────
function mail_seen_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(MAIL_SEEN_) || "[]"); }
  catch (err) { return []; }
}

/** Record a message as judged. Saved per message so a timeout can't lose the batch. */
function mail_markSeen_(id) {
  PropertiesService.getScriptProperties()
    .setProperty(MAIL_SEEN_, JSON.stringify(mail_addSeen_(mail_seen_(), id)));
}

/** Newest first, capped, no duplicates. Pure — the trimming is what's worth testing. */
function mail_addSeen_(seen, id) {
  return [id].concat((seen || []).filter(function (x) { return x !== id; })).slice(0, MAIL_SEEN_MAX_);
}
