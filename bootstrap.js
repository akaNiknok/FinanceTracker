#!/usr/bin/env node
// bootstrap.js — `npm run bootstrap`. Makes a fresh checkout or a new git worktree
// runnable. Safe to re-run; it changes nothing that is already correct.
//
// Three things do not travel into a worktree, because all three are gitignored:
//   1. node_modules      -> npm ci
//   2. worker/.dev.vars  -> copied from the main checkout (the dev secrets)
//   3. a free dev port   -> .claude/launch.json is generated, not committed, so two
//                           worktrees never fight over 8123
//
// `npm run dev:pull` is deliberately NOT run here: it downloads real financial data.
// Run it by hand in the one worktree that needs it.
const { execSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

// Anchor to this file, not to the caller's cwd: a SessionStart hook runs from
// wherever Claude Code starts, and every worktree has its own copy of this script.
process.chdir(__dirname);
const here = __dirname;
const gitCommonDir = execSync('git rev-parse --path-format=absolute --git-common-dir').toString().trim();
const mainCheckout = path.dirname(gitCommonDir);
const isWorktree = path.resolve(mainCheckout) !== path.resolve(here);
console.log(isWorktree ? `worktree of ${mainCheckout}` : 'main checkout');

// 1. dependencies
if (fs.existsSync('node_modules')) {
  console.log('- node_modules present, skipping npm ci');
} else {
  console.log('- npm ci');
  execSync('npm ci', { stdio: 'inherit' });
}

// 2. dev secrets, worktrees only
const devVars = path.join('worker', '.dev.vars');
if (!isWorktree) {
  console.log(fs.existsSync(devVars)
    ? '- worker/.dev.vars present'
    : '- worker/.dev.vars missing. Create it before `npm run dev` (README lists the keys).');
} else if (fs.existsSync(devVars)) {
  console.log('- worker/.dev.vars present');
} else {
  const source = path.join(mainCheckout, devVars);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, devVars);
    console.log('- copied worker/.dev.vars from the main checkout');
  } else {
    console.log('- worker/.dev.vars not found in the main checkout either; `npm run dev` will not start');
  }
}

// 3. a dev port this checkout can have to itself
const free = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

// The port is derived from the checkout path, not from what happens to be listening:
// two idle worktrees bootstrapped on the same day must still get different ports.
// Probing only breaks a hash collision or a port some other program already holds.
const portFor = (dir) => {
  if (!isWorktree) return 8123;
  const h = require('node:crypto').createHash('sha1').update(path.resolve(dir)).digest()[0];
  return 8124 + (h % 40);
};

(async () => {
  const BASE = portFor(here);
  let port = BASE;
  while (port < BASE + 50 && !(await free(port))) port++;

  const launch = {
    version: '0.0.1',
    configurations: [{
      name: 'worker',
      runtimeExecutable: 'npx',
      runtimeArgs: ['wrangler', 'dev', '--port', String(port), '--local', '--show-interactive-dev-session=false'],
      cwd: 'worker',
      port,
    }],
  };
  // 4. fake data. Not applied here: it costs two wrangler round trips and this script
  // runs from a SessionStart hook. Say so instead, and let whoever needs it run one line.
  const localD1 = path.join('worker', '.wrangler', 'state', 'v3', 'd1');
  console.log(fs.existsSync(localD1)
    ? '- local D1 present'
    : '- local D1 is empty. `npm run dev:seed` fills it with invented data (worker/seed.sql).');

  fs.mkdirSync('.claude', { recursive: true });
  fs.writeFileSync(path.join('.claude', 'launch.json'), JSON.stringify(launch, null, 2) + '\n');
  console.log(`- .claude/launch.json -> port ${port}${port === BASE ? '' : ' (8123 was busy)'}`);
  console.log('\nReady. `npm run dev` serves this checkout on its own port.');
})();
