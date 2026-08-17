/**
 * Auth.gs — access guards for the service layer.
 *
 * Two mechanisms:
 *   • Owner identity  — Session.getActiveUser() equals OWNER_EMAIL. Only ever
 *     true on a restricted deploy, which this is not (see below), so in practice
 *     the token is what does the work.
 *   • Shared token    — a secret (API_TOKEN) passed by the caller. Enforced on
 *     mutations when ENFORCE_TOKEN=true (live since 2026-07-29); the token rides
 *     in the Worker's GAS_URL secret. Rollback = flip the property, no redeploy.
 *
 * The manifest stays ANYONE_ANONYMOUS permanently: a Telegram webhook cannot do
 * OAuth, so `access: MYSELF` would kill the bot.
 *
 * Since v1.6.0 the SPA is served by the Cloudflare Worker and comes through the
 * Router like any other caller, so this guard now covers the UI too — reads
 * included. The Worker supplies the token out of its GAS_URL secret; the browser
 * never sees it. Flipping ENFORCE_TOKEN=false as a rollback therefore opens reads
 * to anyone with the /exec URL, which is the same posture as before v1.3.3.
 */

/** True if the active Google user is the owner (only meaningful on restricted deploys). */
function auth_isOwner_() {
  const email = Session.getActiveUser().getEmail();
  return !!email && email.toLowerCase() === cfgOwnerEmail_().toLowerCase();
}

/** Pull a token from query param, JSON body, or Bearer header. */
function auth_extractToken_(e, body) {
  if (e && e.parameter && e.parameter.token) return e.parameter.token;
  if (body && body.token) return body.token;
  // Apps Script can't read arbitrary headers on a web app, so token travels in
  // the param/body. Kept here for forward-compat if that changes.
  return "";
}

/**
 * Guard a mutating request. Throws on rejection (Router converts to JSON error).
 * Passes when: owner identity matches (restricted deploy) OR token enforcement
 * is off OR the supplied token matches API_TOKEN.
 */
function auth_requireWrite_(e, body) {
  if (auth_isOwner_()) return;            // signed-in owner (restricted deploy)
  if (!cfgEnforceToken_()) return;        // rollback switch: anonymous writes ok
  const expected = cfgApiToken_();
  const given = auth_extractToken_(e, body);
  if (expected && given && given === expected) return;
  throw new Error("Unauthorized: valid API token required.");
}

