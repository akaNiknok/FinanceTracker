---
name: clasp-deploy
description: Push code to the Apps Script project and deploy the Web App with clasp. Use when pushing/pulling GAS code, deploying or redeploying the Web App, setting up clasp for the first time, or when a change needs to reach the live bot/UI.
---

# clasp workflow (push/deploy to Apps Script)

The repo is linked to the Apps Script project via `.clasp.json` (`scriptId` is committed; the auth token is not). Day-to-day commands are the `scripts` block of `package.json` — read it rather than memorizing them here.

## One-time setup
```bash
npm install
```
Then `npm run login` (OAuth → `~/.clasprc.json`, gitignored). Before the first push, enable the Apps Script API once at https://script.google.com/home/usersettings.

## Deploying the Web App
- `npm run deploy` — new versioned deployment (**new URL** — almost never what you want).
- `npm run deployments` — list deployment IDs.
- `npx clasp deploy --deploymentId <id> --description "..."` — update an existing deployment **in place**.

**Redeploy the same `deploymentId`.** The Cloudflare Worker's `GAS_URL` secret points at one specific deployment URL; a new deployment mints a new URL and silently breaks the Telegram bot. `npm run release` handles this correctly on `main` (it reads the gitignored `.deploymentid`).

`npm run push` alone does **not** change what Telegram hits — saved editor code doesn't affect the live Web App. After any bot/API behavior change, redeploy.

## Web App access
The manifest sets `executeAs: USER_DEPLOYING` and `access: ANYONE_ANONYMOUS`. `ANYONE_ANONYMOUS` is **required and permanent** — the Telegram webhook can't do OAuth, so `access: MYSELF` would kill the bot. The deployment URL is effectively the credential: treat it as secret, keep it out of git (see MEMORY.md). The write guard is `ENFORCE_TOKEN=true` plus the token carried in the Worker's `GAS_URL` secret.
