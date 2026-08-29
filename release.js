// release.js — run `npm run release` on develop. It does NOT release.
//
// Since the Release workflow took over (.github/workflows/release.yml), the only path
// to live is a merge into main. This script prepares that merge and nothing else: it
// checks the things that are cheaper to catch here than in CI, then opens or updates
// the develop -> main pull request. Merging that PR is what ships.
//
// Deploying needs a Cloudflare API token, which now lives in GitHub repo secrets. No
// credential is required to run this script, so it works the same in a cloud session
// as it does on the owner's machine.
const { execSync } = require('child_process');
const out = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const run = (cmd, opts) => execSync(cmd, { stdio: 'inherit', ...opts });

const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch !== 'develop') { console.error(`prepare the release on develop (currently on ${branch})`); process.exit(1); }
if (out('git status --porcelain')) { console.error('working tree not clean'); process.exit(1); }

const version = require('./package.json').version;
const tag = 'v' + version;
run('git fetch origin main --tags --quiet');
if (out(`git tag -l ${tag}`)) { console.error(`${tag} already tagged — bump first: npm version patch|minor --no-git-tag-version`); process.exit(1); }

const live = JSON.parse(out('git show origin/main:package.json')).version;
if (live === version) { console.error(`version is still ${version}, the same as main — bump first: npm version patch|minor --no-git-tag-version`); process.exit(1); }

// test.js fails when index.html's brand-ver span disagrees with package.json. Catch
// that here rather than after the merge, where CI aborts the release instead.
run('npm test');

if (out('git rev-list origin/develop..HEAD')) { console.error('develop has unpushed commits — push first'); process.exit(1); }

const existing = out('gh pr list --base main --head develop --state open --json number -q ".[0].number"');
if (existing) {
  console.log(`PR #${existing} is already open for this release.`);
  run(`gh pr view ${existing} --web`);
} else {
  const prev = out('git describe --tags --abbrev=0');
  const log = out(`git log --no-merges --invert-grep --grep="^Bump version" --format="* %s" ${prev}..HEAD`);
  run(`gh pr create --base main --head develop --title "Release ${tag}" --body-file -`, {
    input: `Releases \`${tag}\`.\n\n## What's Changed\n${log}\n\n---\nMerging this runs the Release workflow: D1 migrations, \`wrangler deploy\`, the tag and the GitHub Release.\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}
console.log(`\n${tag} is ready. Merge the PR to release; the workflow does the rest.`);
