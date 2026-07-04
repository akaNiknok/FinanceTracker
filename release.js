// release.js — run `npm run release` on main only.
// Pushes code to GAS, redeploys the SAME deploymentId (URL stable for n8n),
// tags vX.Y.Z from package.json, pushes, and creates a GitHub Release.
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

run('npx clasp push -f');
run(`npx clasp deploy --deploymentId ${depId} --description "${tag}"`);
run(`git tag ${tag}`);
run('git push origin main --tags');
run(`gh release create ${tag} --generate-notes`);
console.log(`Released ${tag}`);
