// Crop + downscale icon-master.png -> worker/public/icon-180.png (apple-touch) and
// icon-512.png (manifest). `npm run icons`; only needed if the master art changes.
// Uses the Chrome/Edge already on the machine as the resampler, so there is no image
// dependency to install. The master lives at the repo root, not in worker/public/, so
// the 448 KB original is never served.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MASTER = path.join(__dirname, 'icon-master.png');
const OUT_DIR = path.join(__dirname, 'worker', 'public');
const SIZES = [180, 512];
// Source rect. The master is 1408x768; the coin's measured bounding box is
// (394,75)-(1013,695), i.e. centred at (703.5, 385) with diameter 621. This square is
// centred on that and sized so the coin fills ~92% of the icon — a plain centre crop of
// the 768px height would sit 6px off and waste a fifth of a 16px favicon on margin.
const CROP = { x: 366, y: 47, size: 676 };
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
  const scale = size / CROP.size;
  const wrap = path.join(os.tmpdir(), `ft-icon-${size}.html`);
  fs.writeFileSync(wrap, `<style>*{margin:0;padding:0}
    body{width:${size}px;height:${size}px;overflow:hidden;position:relative}
    img{position:absolute;width:${1408 * scale}px;left:${-CROP.x * scale}px;top:${-CROP.y * scale}px}
  </style><img src="file:///${MASTER.replace(/\\/g, '/')}">`);
  const out = path.join(OUT_DIR, `icon-${size}.png`);
  execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars',
    `--screenshot=${out}`, `--window-size=${size},${size}`, wrap], { stdio: 'ignore' });
  fs.unlinkSync(wrap);
  console.log(`${out} (${fs.statSync(out).size} bytes)`);
}
