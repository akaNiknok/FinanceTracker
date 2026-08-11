/**
 * Cloudflare Worker — the 200 that Apps Script cannot give.
 *
 * Telegram refuses a webhook that answers with a redirect ("Wrong response from
 * the webhook: 302 Found") and keeps redelivering, and an Apps Script /exec URL
 * always answers POST with a 302 to script.googleusercontent.com. There is no
 * setting for that on either side, so this sits between them: Telegram gets an
 * immediate 200, and the update is forwarded to GAS, which holds all the logic.
 *
 * A GET /mail route lived here briefly (2026-08-11) to open a receipt's ⌕ Email button
 * in the Gmail iOS app. Both forms failed on the owner's phone — the unofficial
 * `googlegmail:///cv=<id>` scheme wants Gmail's opaque web "view token" (FMfcg…), which
 * cannot be derived from the API id, and a plain mail.google.com link is not a Gmail
 * universal link so Safari just loads the web page. The button now quotes the mail into
 * the chat instead (Gmail.gs gmail_quote_), and this Worker is a pure Telegram proxy.
 *
 * Secrets (wrangler secret put ...):
 *   GAS_URL       — the full endpoint, incl. ?action=telegram and &token= if
 *                   ENFORCE_TOKEN is on. Run tg_gasEndpoint() in the Apps Script
 *                   editor to print exactly this string.
 *   SECRET_TOKEN  — optional; must equal the secret_token registered by
 *                   tg_setWebhook. Set both or neither.
 */

export default {
  async fetch(request, env, ctx) {
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
