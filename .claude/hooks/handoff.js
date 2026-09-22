// SessionStart hook: feed HANDOFF.md back into a fresh session.
// Replaces an inline `node -e` whose JSON-escaped \n became a raw newline
// inside a string literal, so it failed with a SyntaxError on every start.
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const file = join(__dirname, '..', '..', 'HANDOFF.md');
if (existsSync(file)) {
  process.stdout.write('=== HANDOFF.md — previous session resume point (gitignored) ===\n');
  process.stdout.write(readFileSync(file, 'utf8'));
}
