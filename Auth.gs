/**
 * Auth.gs — access guards for the service layer.
 *
 * Two mechanisms, both optional during Phase 1 so the live n8n bot keeps working
 * while the API is built:
 *   • Owner identity  — when the web app runs with a restricted manifest
 *     (access: MYSELF), Session.getActiveUser() is the signed-in user; we check
 *     it equals OWNER_EMAIL. Used by the authenticated UI in Phase 2.
 *   • Shared token    — a secret (API_TOKEN) passed by the caller. Enforced on
 *     mutations only when ENFORCE_TOKEN=true; left off by default so the current
 *     anonymous n8n POST is not broken until Phase 3 cuts it over.
 *
 * The deployment manifest is intentionally NOT flipped to MYSELF in Phase 1 —
 * that happens with the n8n auth migration (Phase 3) to avoid breaking the bot.
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
  if (!cfgEnforceToken_()) return;        // Phase 1 default: anonymous writes ok
  const expected = cfgApiToken_();
  const given = auth_extractToken_(e, body);
  if (expected && given && given === expected) return;
  throw new Error("Unauthorized: valid API token required.");
}

/**
 * What the server sees about the caller. Read-only, echoes back only the
 * caller's own identity (never OWNER_EMAIL), so it is safe behind the read
 * guard. Exists to make the Phase 3 manifest flip verifiable instead of a
 * leap of faith: call it from n8n with the OAuth credential BEFORE flipping
 * `access` to MYSELF — if isOwner is false, the flip would lock the bot out.
 */
function auth_status_(e, body) {
  const email = Session.getActiveUser().getEmail();
  const expected = cfgApiToken_();
  const given = auth_extractToken_(e, body);
  return {
    activeUser: email || null,          // "" when the caller is anonymous
    isOwner: auth_isOwner_(),
    enforceToken: cfgEnforceToken_(),
    tokenAccepted: !!(expected && given && given === expected),
    writeAllowed: auth_isOwner_() || !cfgEnforceToken_() ||
                  !!(expected && given && given === expected)
  };
}

/** Guard a read that may expose raw data (debug dumps). Same policy as writes. */
function auth_requireRead_(e, body) {
  if (auth_isOwner_()) return;
  if (!cfgEnforceToken_()) return;
  const expected = cfgApiToken_();
  const given = auth_extractToken_(e, body);
  if (expected && given && given === expected) return;
  throw new Error("Unauthorized: valid API token required.");
}
