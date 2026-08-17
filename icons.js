// Render the app icon -> worker/public/icon-180.png (apple-touch + favicon) and
// icon-512.png (manifest). `npm run icons`; only needed if ICON below changes.
// Uses the Chrome/Edge already on the machine as the renderer, so there is no image
// dependency to install. The art is the SVG in this file — there is no binary master.
// Deliberately square with a full-bleed fill: iOS rounds the apple-touch-icon itself and
// Android masks the maskable manifest icon, so baked-in rounded corners would be
// double-rounded there and leave transparent corners iOS composites onto black.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'worker', 'public');
const SIZES = [180, 512];
// Accent-blue tile, white peso sign, in a 96-unit box. One shape, so it stays legible at
// 16px favicon size and the glyph sits well inside Android's 80% maskable safe circle
// (ink diagonal 53.9 vs the 76.8 safe diameter).
const GLYPH = 58;
// text-anchor="middle" already centres the ink horizontally at x=48 — don't "correct" it.
// Vertically it does NOT: dominant-baseline="central" is the midpoint of the font's
// ascent/descent, which for a caps-only glyph sits ~6.55% of the font size too low. Hence
// the lift below, measured by pixel-scanning the rendered ink box and verified to hold at
// font sizes 48/58/66/72 (residual <0.1 unit), so changing GLYPH alone stays centred.
const ICON = `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <rect width="96" height="96" fill="#5b8cff"/>
  <text x="48" y="${48 - 0.0655 * GLYPH}" font-size="${GLYPH}" font-weight="700" fill="#fff"
    text-anchor="middle" dominant-baseline="central"
    font-family="Segoe UI, Helvetica Neue, Arial, sans-serif">&#8369;</text>
</svg>`;
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const chrome = BROWSERS.find((p) => fs.existsSync(p));
if (!chrome) throw new Error('No Chrome/Edge found; add its path to BROWSERS in icons.js');

for (const size of SIZES) {
  const wrap = path.join(os.tmpdir(), `ft-icon-${size}.html`);
  fs.writeFileSync(wrap, `<style>*{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${ICON}`);
  const out = path.join(OUT_DIR, `icon-${size}.png`);
  execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars',
    `--screenshot=${out}`, `--window-size=${size},${size}`, wrap], { stdio: 'ignore' });
  fs.unlinkSync(wrap);
  console.log(`${out} (${fs.statSync(out).size} bytes)`);
}
