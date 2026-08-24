#!/usr/bin/env node
// Mirror the live D1 into the local dev database, so `npm run dev` serves real
// data. Read-only against prod (d1 export); wipes and rebuilds ONLY the local
// D1 copy. Run with the dev server STOPPED — Windows locks the sqlite file while
// wrangler dev holds it. The dump (.dev-data.sql) is real money data: gitignored.
const { execSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const path = require('node:path');

const worker = path.join(__dirname, 'worker');
const run = (cmd) => execSync(cmd, { cwd: worker, stdio: 'inherit' });
const DB = 'financetracker', DUMP = '.dev-data.sql';

console.log('→ exporting live D1 (read-only)…');
run(`npx wrangler d1 export ${DB} --remote --output ${DUMP}`);
console.log('→ resetting local D1…');
rmSync(path.join(worker, '.wrangler', 'state', 'v3', 'd1'), { recursive: true, force: true });
console.log('→ loading into local D1…');
run(`npx wrangler d1 execute ${DB} --local --file ${DUMP}`);
console.log('✓ local D1 now mirrors prod — `npm run dev`, log in with APP_PASS.');
