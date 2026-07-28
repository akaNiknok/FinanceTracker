/**
 * Cloudflare Worker — the 200 that Apps Script cannot give.
 *
 * Telegram refuses a webhook that answers with a redirect ("Wrong response from
 * the webhook: 302 Found") and keeps redelivering, and an Apps Script /exec URL
 * always answers POST with a 302 to script.googleusercontent.com. There is no
 * setting for that on either side, so this sits between them: Telegram gets an
 * immediate 200, and the update is forwarded to GAS, which holds all the logic.
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
