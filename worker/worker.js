/**
 * Cloudflare Worker — the 200 that Apps Script cannot give.
 *
 * Telegram refuses a webhook that answers with a redirect ("Wrong response from
 * the webhook: 302 Found") and keeps redelivering, and an Apps Script /exec URL
 * always answers POST with a 302 to script.googleusercontent.com. There is no
 * setting for that on either side, so this sits between them: Telegram gets an
 * immediate 200, and the update is forwarded to GAS, which holds all the logic.
 *
 * It also serves GET /mail — the hop that opens a receipt's ⌕ Email button in the
 * Gmail iOS app. Telegram only allows http(s) on a button, and Gmail does not claim
 * mail.google.com as a universal link (tested: Safari just loads the web page), so
 * the button points here and this bounces to Gmail's own URL scheme.
 *
 * Secrets (wrangler secret put ...):
 *   GAS_URL       — the full endpoint, incl. ?action=telegram and &token= if
 *                   ENFORCE_TOKEN is on. Run tg_gasEndpoint() in the Apps Script
 *                   editor to print exactly this string.
 *   SECRET_TOKEN  — optional; must equal the secret_token registered by
 *                   tg_setWebhook. Set both or neither.
 */

/**
 * Gmail for iOS has no documented deep link; this unofficial one has been in use for
 * years. `cv` takes the same hex id as a Gmail web permalink, and accountId=1 is the
 * value every published example carries — if it opens the wrong account, that digit
 * is the thing to change.
 */
const gmailAppUrl = (id) => `googlegmail:///cv=${id}/accountId=1`;

/**
 * The bounce page. It cannot be a bare 302 to the scheme: when the app doesn't take
 * it (not installed, scheme changed under us, Android), a redirect to an unknown
 * scheme is a dead end, whereas this leaves a link that still opens the mail.
 *
 * `mid` is the RFC822 Message-ID. The web fallback searches for it with `in:anywhere`
 * rather than using the #all/ permalink, because by now Gmail.gs has trashed the mail
 * and All Mail excludes the trash.
 */
function mailPage(id, mid) {
  const web = mid
    ? "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(`rfc822msgid:${mid} in:anywhere`)
    : `https://mail.google.com/mail/u/0/#all/${id}`;
  // id is [0-9a-f] (validated by the caller) and `web` is percent-encoded, so neither
  // can break out of the attribute or the script below.
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width">` +
    `<title>Opening Gmail…</title>` +
    `<body style="font:17px -apple-system,system-ui,sans-serif;padding:2rem;text-align:center">` +
    `<p><a href="${web}">Open in the browser instead</a>` +
    `<script>location.replace("${gmailAppUrl(id)}")</script>`,
    { headers: { "content-type": "text/html;charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/mail") {
      const id = url.searchParams.get("id") || "";
      const mid = (url.searchParams.get("mid") || "").slice(0, 200);
      // Public endpoint: the id lands in HTML, so take only what a Gmail id can be.
      if (!/^[0-9a-f]{1,32}$/i.test(id)) return new Response("bad id", { status: 400 });
      return mailPage(id, mid);
    }
    if (request.method !== "POST") return new Response("ok");   // health check / stray GET
    if (env.SECRET_TOKEN &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }

    const update = await request.text();
    // waitUntil keeps the fetch alive after we have already answered Telegram.
    // The GAS execution happens on the POST itself, so the 302 that comes back
    // is of no interest — it is neither followed nor read.
    ctx.waitUntil(fetch(env.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: update
    }));
    return new Response("ok");
  }
};
