// release.js — run `npm run release` on main only.
// Applies pending D1 migrations, deploys the Worker (which IS the app: API, bot, crons
// and the SPA), tags vX.Y.Z from package.json, pushes, and creates a GitHub Release.
//
// The clasp push/redeploy steps are gone with v2.0.0: there is no Apps Script web app
// any more, only two trigger-driven files (Gmail.gs, Backup.gs) that change rarely and
// are pushed by hand with `npm run push` when they do.
//
// Migrations run BEFORE the deploy, and the deploy before the tag: new code must never
// meet an old schema, and a failed deploy must abort rather than leave a tag whose
// halves disagree.
const { execSync } = require('child_process');
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const inWorker = (cmd) => execSync(cmd, { cwd: 'worker', stdio: 'inherit' });
const out = (cmd) => execSync(cmd).toString().trim();

const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') { console.error(`release runs on main (currently on ${branch})`); process.exit(1); }
if (out('git status --porcelain')) { console.error('working tree not clean'); process.exit(1); }
const tag = 'v' + require('./package.json').version;
if (out(`git tag -l ${tag}`)) { console.error(`${tag} already tagged — bump first: npm version patch|minor`); process.exit(1); }

// ponytail: notes from commit subjects, not --generate-notes — this repo commits
// straight to develop, so PR-derived notes come out empty. Revisit if it goes PR-based.
const prev = out('git describe --tags --abbrev=0');
const log = out(`git log --no-merges --invert-grep --grep="^Bump version" --format="* %s" ${prev}..HEAD`);
const repo = out('gh repo view --json nameWithOwner -q .nameWithOwner');
const notes = `## What's Changed\n${log}\n\n**Full Changelog**: https://github.com/${repo}/compare/${prev}...${tag}`;

inWorker('npx wrangler d1 migrations apply financetracker --remote');
inWorker('npx wrangler deploy');
run(`git tag ${tag}`);
run('git push origin main --tags');
execSync(`gh release create ${tag} --title ${tag} --notes-file -`, { stdio: ['pipe', 'inherit', 'inherit'], input: notes });
console.log(`Released ${tag}`);
