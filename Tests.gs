/**
 * Tests.gs — what is left to test in Apps Script after v2.0.0: the mail courier.
 *
 * Everything else moved to the Worker and is tested by `npm test` as plain ESM
 * (test.js), which also still runs PURE_TESTS below through a vm — the same trick as
 * before, kept only because these three helpers live in the GAS flat namespace.
 *
 * Sheet-bound tests are gone with the sheet. The end-to-end reconciliation they used
 * to provide is now migrate/verify.js, run against the real database.
 */
var PURE_TESTS = ["test_gmailScope", "test_gmailQuote", "test_gmailPayload"];

function test_all() {
  PURE_TESTS.forEach(function (n) { globalThis[n](); });
  Logger.log("== test_all complete ==");
}

/**
 * GMAIL_QUERY_ — the two things about the job's scope that must not drift: it reads
 * the inbox only (owner rule: never re-read trashed mail) and it selects by the Gmail
 * label, so the sender list stays editable from Gmail rather than from here.
 */
function test_gmailScope() {
  if (GMAIL_QUERY_.indexOf("in:inbox") === -1)
    throw new Error("GMAIL_QUERY_ FAIL: scope left the inbox → " + GMAIL_QUERY_);
  if (GMAIL_QUERY_.indexOf('label:"' + GMAIL_LABEL_ + '"') === -1)
    throw new Error("GMAIL_QUERY_ FAIL: not label-driven → " + GMAIL_QUERY_);
  if (/from:/.test(GMAIL_QUERY_))
    throw new Error("GMAIL_QUERY_ FAIL: senders belong in the Gmail filter, not here");
  Logger.log("test_gmailScope OK");
}

/**
 * gmail_quote_ — what the ⌕ Email button posts back. It exists to be READ on a phone,
 * so the two things that matter are that the amount/merchant line survives and that a
 * long footer cannot push the quote past Telegram's 4096-char message limit.
 */
function test_gmailQuote() {
  const msg = gmailTestMsg_();
  const q = gmail_quote_(msg);
  ["Successful Debit Card Transaction", "alerts@maribank.com.ph",
   "PHP 369.00", "GRAB *TRIP"].forEach(function (needle) {
    if (q.indexOf(needle) === -1) throw new Error("gmail_quote_ FAIL: missing " + needle);
  });
  if (/\n{3,}/.test(q)) throw new Error("gmail_quote_ FAIL: blank-line runs not collapsed");

  const long = Object.assign({}, msg, { getPlainBody: function () { return new Array(9000).join("x"); } });
  const big = gmail_quote_(long);
  if (big.length > GMAIL_QUOTE_BODY_ + 400)
    throw new Error("gmail_quote_ FAIL: body not truncated (" + big.length + ")");
  if (big.length > 4096) throw new Error("gmail_quote_ FAIL: over Telegram's message limit");
  Logger.log("test_gmailQuote OK");
}

/**
 * gmail_payload_ — the courier's whole job now. Four things the Worker cannot recover
 * if this drops them: the messageId (the idempotent row id AND the quote's key), the
 * hints (an Anthropic receipt names a card, never an account, so only the hint puts it
 * on Wise), the body (truncated, or a long footer pushes the amount out of the prompt)
 * and the quote (the Worker cannot call GmailApp to fetch it later).
 */
function test_gmailPayload() {
  const p = gmail_payload_(gmailTestMsg_(), "Anthropic / Stripe receipts are charged to the Wise account.");
  ["messageId", "from", "subject", "date", "hints", "body", "quote"].forEach(function (k) {
    if (!p[k]) throw new Error("gmail_payload_ FAIL: missing " + k);
  });
  if (p.action !== "ingestEmail") throw new Error("gmail_payload_ FAIL: wrong action " + p.action);
  if (p.body.indexOf("PHP 369.00") === -1) throw new Error("gmail_payload_ FAIL: body lost the amount");
  if (p.hints.indexOf("Wise") === -1) throw new Error("gmail_payload_ FAIL: hints dropped");

  const long = Object.assign({}, gmailTestMsg_(), { getPlainBody: function () { return new Array(9000).join("x"); } });
  const big = gmail_payload_(long, "");
  if (big.body.length > GMAIL_MAX_BODY_) throw new Error("gmail_payload_ FAIL: body not truncated");
  Logger.log("test_gmailPayload OK");
}

/** A real MariBank alert from the mailbox, as a GmailMessage-shaped stub. */
function gmailTestMsg_() {
  return {
    getId:        function () { return "198f2a3b4c5d6e7f"; },
    getFrom:      function () { return "alerts@maribank.com.ph"; },
    getSubject:   function () { return "Successful Debit Card Transaction"; },
    getDate:      function () { return new Date(2026, 7, 11); },
    getPlainBody: function () { return "Hi Austin,\n\n\n\n\nTransaction Amount: PHP 369.00\nMerchant: GRAB *TRIP\n"; }
  };
}
