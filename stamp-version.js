#!/usr/bin/env node
// stamp-version.js — copies package.json's version into the SPA's brand-ver span.
//
// npm runs this as the `version` lifecycle script, so `npm version patch|minor` stamps
// index.html by itself and stages it. Before this, the span was hand-edited: forget it
// and `npm test` fails, which is a whole class of failed release runs for a value that
// was never a decision. test.js still asserts the two agree — that guard now catches a
// hand-edit rather than a forgotten one.
const fs = require('node:fs');
const file = 'worker/public/index.html';
const version = require('./package.json').version;

const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/(<span class="brand-ver">)v[^<]*/, `$1v${version}`);
if (after === before) {
  // Either already correct, or the span moved. The second case must be loud: a silent
  // no-op here means the release fails later, in CI, after the merge.
  if (!before.includes(`<span class="brand-ver">v${version}</span>`)) {
    console.error(`${file}: no <span class="brand-ver"> to stamp. Fix the span or this script.`);
    process.exit(1);
  }
  console.log(`${file} already reads v${version}`);
} else {
  fs.writeFileSync(file, after);
  console.log(`${file} -> v${version}`);
}
