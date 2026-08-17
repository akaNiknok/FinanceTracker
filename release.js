// release.js — run `npm run release` on main only.
// Pushes code to GAS, redeploys the SAME deploymentId (URL stable for the bot),
// deploys the Worker (which serves the SPA), tags vX.Y.Z from package.json,
// pushes, and creates a GitHub Release.
const { execSync } = require('child_process');
const fs = require('fs');
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd).toString().trim();

const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') { console.error(`release runs on main (currently on ${branch})`); process.exit(1); }
if (out('git status --porcelain')) { console.error('working tree not clean'); process.exit(1); }
const tag = 'v' + require('./package.json').version;
if (out(`git tag -l ${tag}`)) { console.error(`${tag} already tagged — bump first: npm version patch|minor`); process.exit(1); }
if (!fs.existsSync('.deploymentid')) { console.error('.deploymentid missing (gitignored file holding the live web-app deploymentId)'); process.exit(1); }
const depId = fs.readFileSync('.deploymentid', 'utf8').trim();

// ponytail: notes from commit subjects, not --generate-notes — this repo commits
// straight to develop, so PR-derived notes come out empty. Revisit if it goes PR-based.
const prev = out('git describe --tags --abbrev=0');
const log = out(`git log --no-merges --invert-grep --grep="^Bump version" --format="* %s" ${prev}..HEAD`);
const repo = out('gh repo view --json nameWithOwner -q .nameWithOwner');
const notes = `## What's Changed\n${log}\n\n**Full Changelog**: https://github.com/${repo}/compare/${prev}...${tag}`;

run('npx clasp push -f');
run(`npx clasp deploy --deploymentId ${depId} --description "${tag}"`);
// The frontend ships here too since v1.6.0 — worker/public IS the app. Before the
// tag, so a failed Worker deploy aborts the release instead of leaving a tag whose
// GAS and Worker halves disagree.
execSync('npx wrangler deploy', { cwd: 'worker', stdio: 'inherit' });
run(`git tag ${tag}`);
run('git push origin main --tags');
execSync(`gh release create ${tag} --title ${tag} --notes-file -`, { stdio: ['pipe', 'inherit', 'inherit'], input: notes });
console.log(`Released ${tag}`);
