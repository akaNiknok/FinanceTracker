// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: wallet;
/**
 * FinanceTracker home-screen widgets for Scriptable (iOS). One script, four widgets —
 * the widget's Parameter picks which:
 *   recent    small  — the 3 latest transactions            (tap → Transactions)
 *   balances  small  — 3 accounts, picked in the app's Accounts screen (tap → Accounts)
 *   networth  small  — net worth now + a 6-month sparkline  (tap → Dashboard)
 *   segments  medium — Essentials + Rewards, Essentials, Rewards meters (tap → Dashboard)
 * No parameter: medium → segments, small → recent.
 *
 * One GET per refresh window, shared by every widget: /api?action=getWidget. Run the script inside Scriptable once to
 * sign in: it asks for the app URL and the passphrase, posts them to /login and keeps
 * only the session cookie in the iOS Keychain — never the passphrase. The last good
 * payload is cached on the phone, so a refresh with no signal still draws (marked
 * "cached"). Colours are the SPA's own tokens (worker/public/app.css).
 */
const K_URL = 'financetracker.url', K_COOKIE = 'financetracker.cookie';
const C = {
  text: '#e9ecf2', dim: '#9aa3b4', faint: '#6d768a', accent: '#5b8cff',
  pos: '#3ecf8e', neg: '#ff7373', warn: '#ffb454', over: '#d95757'
};
const col = (hex, a) => new Color(hex, a == null ? 1 : a);
const SCREEN = { recent: 'transactions', balances: 'accounts', networth: 'dashboard', segments: 'dashboard' };

// Widget content widths. iOS publishes no API for them; medium ≈ 85.7% of the screen
// width on every iPhone, and a small is half a medium less the gap between them.
// ponytail: iPhone-only table, iPad widget sizes differ — measure there if ever wanted.
const PAD = 14;
const MED = Math.round(Device.screenSize().width * 0.857);
const WIDTH = { small: Math.round((MED - 22) / 2) - PAD * 2, medium: MED - PAD * 2 };

// ── formatting ──────────────────────────────────────────────────────────────
function money(n, cur) {
  cur = cur || 'PHP';
  try {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency: cur,
      maximumFractionDigits: cur === 'PHP' ? 0 : 2 }).format(n);
  } catch (e) { return cur + ' ' + Number(n).toFixed(2); }
}
function compact(n) {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e6) return s + '₱' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return s + '₱' + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
  return s + money(a);
}
function dayLabel(iso) {
  const d = new Date(iso + 'T00:00:00'), t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - d) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// Share of the budget period gone by — the SPA's periodPace, for the live month only.
function pace(period) {
  const n = new Date(), day = n.getDate(), days = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
  return /^quarter/i.test(String(period)) ? (n.getMonth() % 3 + day / days) / 3 : day / days;
}

// ── auth + data ─────────────────────────────────────────────────────────────
async function signIn() {
  const a = new Alert();
  a.title = 'FinanceTracker';
  a.message = 'Sign in once. Only the session cookie is kept, in the iOS Keychain.';
  a.addTextField('https://….workers.dev', Keychain.contains(K_URL) ? Keychain.get(K_URL) : '');
  a.addSecureTextField('Passphrase', '');
  a.addAction('Sign in'); a.addCancelAction('Cancel');
  if (await a.presentAlert() === -1) return false;
  const url = a.textFieldValue(0).trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(url)) throw new Error('The app URL must start with https://');
  const r = new Request(url + '/login');
  r.method = 'POST';
  r.headers = { 'Content-Type': 'application/json' };
  r.body = JSON.stringify({ pass: a.textFieldValue(1) });
  await r.loadString();
  if (r.response.statusCode !== 200) throw new Error('Wrong passphrase.');
  const c = (r.response.cookies || []).find((x) => x.name === 'ft_auth');
  const hdr = Object.keys(r.response.headers || {}).find((k) => /^set-cookie$/i.test(k));
  const pair = c ? 'ft_auth=' + c.value : ((hdr && String(r.response.headers[hdr]).match(/ft_auth=[^;]+/)) || [])[0];
  if (!pair) throw new Error('The server set no session cookie.');
  Keychain.set(K_URL, url);
  Keychain.set(K_COOKIE, pair);
  return true;
}

const fm = FileManager.local();
const CACHE = fm.joinPath(fm.documentsDirectory(), 'financetracker-widget.json');
// iOS refreshes all four widgets at about the same time. A payload younger than this is
// reused, so the four cost ONE request and one radio wake-up, not four. In the app
// (a preview) it always fetches, so a preview shows the live figures.
const FRESH_MS = 15 * 60e3;

async function load() {
  if (!Keychain.contains(K_URL) || !Keychain.contains(K_COOKIE)) {
    throw new Error('Open Scriptable and run FinanceTracker to sign in.');
  }
  if (config.runsInWidget && fm.fileExists(CACHE) &&
      Date.now() - fm.modificationDate(CACHE).getTime() < FRESH_MS) {
    return { d: JSON.parse(fm.readString(CACHE)), stale: false };
  }
  try {
    const r = new Request(Keychain.get(K_URL) + '/api?action=getWidget');
    r.headers = { Cookie: Keychain.get(K_COOKIE) };
    r.timeoutInterval = 20;
    const d = await r.loadJSON();
    if (r.response.statusCode === 401) {
      const e = new Error('Signed out. Run FinanceTracker in Scriptable to sign in again.');
      e.auth = true; throw e;
    }
    if (d.status !== 'success') throw new Error(d.message || 'The API answered an error.');
    fm.writeString(CACHE, JSON.stringify(d));
    return { d, stale: false };
  } catch (e) {
    // No signal is normal for a background refresh: draw the last good payload.
    if (!e.auth && fm.fileExists(CACHE)) return { d: JSON.parse(fm.readString(CACHE)), stale: true };
    throw e;
  }
}

// ── building blocks ─────────────────────────────────────────────────────────
function shell(kind) {
  const w = new ListWidget();
  // The SPA's dark surface with its hero's accent glow in the top-left corner: a
  // tinted-glass slab. In the iOS clear/tinted home screen, iOS replaces it anyway.
  const g = new LinearGradient();
  g.colors = [col('#1d2640'), col('#141925'), col('#0d0f14')];
  g.locations = [0, 0.5, 1];
  g.startPoint = new Point(0, 0); g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;
  w.setPadding(PAD, PAD, PAD, PAD);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60e3);
  if (Keychain.contains(K_URL)) w.url = Keychain.get(K_URL) + '/?screen=' + (SCREEN[kind] || 'dashboard');
  return w;
}
function text(stack, s, size, color, weight) {
  const t = stack.addText(String(s));
  t.font = weight === 'bold' ? Font.boldSystemFont(size)
    : weight === 'semi' ? Font.semiboldSystemFont(size)
    : weight === 'med' ? Font.mediumSystemFont(size) : Font.systemFont(size);
  t.textColor = col(color || C.text);
  t.lineLimit = 1;
  return t;
}
function header(w, title, right) {
  const h = w.addStack();
  h.centerAlignContent();
  const dot = h.addStack();            // the brand dot
  dot.size = new Size(7, 7); dot.cornerRadius = 3.5; dot.backgroundColor = col(C.accent);
  h.addSpacer(6);
  text(h, title.toUpperCase(), 10, C.dim, 'semi');
  h.addSpacer();
  if (right) text(h, right, 10, C.faint, 'med');
  w.addSpacer(9);
}
function glyph(stack, ch, color) {
  const s = stack.addStack();
  s.size = new Size(24, 24); s.cornerRadius = 12;
  s.backgroundColor = col(color, 0.16);
  s.borderColor = col(color, 0.28); s.borderWidth = 1;
  s.centerAlignContent();
  text(s, ch, 12, color, 'bold');
}

// ── the four widgets ────────────────────────────────────────────────────────
function recent(w, d) {
  if (!d.recent.length) { text(w, 'No transactions yet.', 12, C.dim); return; }
  d.recent.forEach((t, i) => {
    if (i) w.addSpacer(7);
    // Same direction rule as the SPA's txRow: a negative Expense is a refund, money in.
    const xfer = t.Type === 'Transfer' || !!t.ToAccount;
    const dir = (t.Type === 'Expense' ? -1 : t.Type === 'Income' ? 1 : 0) * (Number(t.Amount) < 0 ? -1 : 1);
    const color = xfer ? C.accent : dir < 0 ? C.neg : dir > 0 ? C.pos : C.dim;
    const cur = t.Currency || 'PHP';
    const amt = cur === 'PHP' ? money(Math.abs(t['Amount (PHP)'])) : money(Math.abs(Number(t.Amount)), cur);
    const r = w.addStack(); r.centerAlignContent();
    glyph(r, xfer ? '⇄' : dir < 0 ? '−' : dir > 0 ? '+' : '•', color);
    r.addSpacer(8);
    const v = r.addStack(); v.layoutVertically();
    text(v, t.Description || String(t.Category).replace(/^[^:]*:\s*/, ''), 12, C.text, 'semi');
    const sub = v.addStack();
    text(sub, (dir < 0 ? '−' : dir > 0 ? '+' : '') + amt, 11, xfer ? C.text : color, 'bold');
    text(sub, ' · ' + dayLabel(t.Date), 11, C.faint);
  });
  w.addSpacer();
}

function balances(w, d) {
  if (!d.accounts.length) {
    text(w, 'No accounts picked.', 12, C.text, 'semi').lineLimit = 2;
    w.addSpacer(4);
    const t = text(w, 'Choose them in the app: Accounts → Home-screen widget.', 11, C.dim);
    t.lineLimit = 3;
    w.addSpacer();
    return;
  }
  d.accounts.forEach((a, i) => {
    if (i) w.addSpacer(7);
    const top = w.addStack(); top.centerAlignContent();
    const dot = top.addStack();
    dot.size = new Size(7, 7); dot.cornerRadius = 3.5;
    dot.backgroundColor = col(/^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : C.accent);
    top.addSpacer(6);
    text(top, a.name, 11, C.dim, 'med');
    // A share account's native balance is a QUANTITY, so it shows in pesos.
    const cur = a.isShares ? 'PHP' : (a.currency || 'PHP');
    const n = a.isShares ? a.balancePhp : a.balanceNative;
    const t = text(w, n == null ? '—' : money(n, cur), 17, a.isLiability && n > 0 ? C.neg : C.text, 'bold');
    t.minimumScaleFactor = 0.6;
  });
  w.addSpacer();
}

function sparkline(values, W, H) {
  const dc = new DrawContext();
  dc.size = new Size(W, H); dc.opaque = false; dc.respectScreenScale = true;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => new Point(
    4 + i * (W - 8) / Math.max(1, values.length - 1),
    4 + (1 - (v - min) / span) * (H - 8)));
  const curve = (path) => {                    // midpoint smoothing
    path.move(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      path.addQuadCurve(new Point((a.x + b.x) / 2, (a.y + b.y) / 2), a);
    }
    path.addLine(pts[pts.length - 1]);
    return path;
  };
  const line = curve(new Path()), area = curve(new Path());
  area.addLine(new Point(pts[pts.length - 1].x, H));
  area.addLine(new Point(pts[0].x, H));
  area.closeSubpath();
  dc.addPath(area); dc.setFillColor(col(C.accent, 0.16)); dc.fillPath();
  dc.addPath(line); dc.setStrokeColor(col(C.accent)); dc.setLineWidth(2.2); dc.strokePath();
  const e = pts[pts.length - 1];
  dc.setFillColor(col(C.accent, 0.3)); dc.fillEllipse(new Rect(e.x - 4.5, e.y - 4.5, 9, 9));
  dc.setFillColor(col(C.text)); dc.fillEllipse(new Rect(e.x - 2.2, e.y - 2.2, 4.4, 4.4));
  return dc.getImage();
}

function networth(w, d, W) {
  const s = d.netWorth, now = s[s.length - 1].value, delta = now - s[0].value;
  const v = text(w, compact(now), 26, C.text, 'bold');
  v.minimumScaleFactor = 0.5;
  w.addSpacer(2);
  const r = w.addStack();
  text(r, (delta >= 0 ? '▲ ' : '▼ ') + compact(Math.abs(delta)), 11, delta >= 0 ? C.pos : C.neg, 'bold');
  text(r, ' · ' + s.length + ' mo', 11, C.faint, 'med');
  w.addSpacer();
  const img = w.addImage(sparkline(s.map((x) => x.value), W, 40));
  img.imageSize = new Size(W, 40);
  w.addSpacer(3);
  const lab = w.addStack();
  text(lab, s[0].month.slice(5), 9, C.faint, 'med');
  lab.addSpacer();
  text(lab, s[s.length - 1].month.slice(5), 9, C.faint, 'med');
}

function meterImage(pct, isOver, p, W) {
  const H = 12, bar = 7, y = (H - bar) / 2;
  const fill = isOver ? C.over : pct >= 85 ? C.warn : C.accent;
  const dc = new DrawContext();
  dc.size = new Size(W, H); dc.opaque = false; dc.respectScreenScale = true;
  const round = (x, wd, color, a) => {
    const path = new Path();
    path.addRoundedRect(new Rect(x, y, wd, bar), bar / 2, bar / 2);
    dc.addPath(path); dc.setFillColor(col(color, a)); dc.fillPath();
  };
  round(0, W, isOver ? C.neg : pct >= 85 ? C.warn : C.accent, 0.16);
  round(0, Math.max(bar, W * Math.min(100, Math.max(0, pct || 0)) / 100), fill, 1);
  if (p > 0.02 && p < 0.98) {                  // the pace notch: where spend "should" sit
    dc.setFillColor(col(C.dim, 0.95));
    dc.fillRect(new Rect(W * p - 1, 0, 2, H));
  }
  return dc.getImage();
}

function segments(w, d, W) {
  const rows = [];
  const er = d.essentialsRewards;
  if (er) rows.push({ label: 'Essentials + Rewards', actual: er.actualPhp, target: er.targetPhp,
                      currency: 'PHP', pct: er.pctUsed, isOver: er.isOver, period: 'Monthly', hero: true });
  ['Essentials', 'Rewards'].forEach((n) => {
    const b = d.segments.find((x) => x.segment === n);
    if (b) rows.push({ label: n, actual: b.actual, target: b.target, currency: b.currency,
                       pct: b.pctUsed, isOver: b.isOver, period: b.period });
  });
  if (!rows.length) { text(w, 'No Essentials or Rewards budget yet.', 12, C.dim); return; }
  rows.forEach((b, i) => {
    if (i) w.addSpacer(6);
    const h = w.addStack(); h.bottomAlignContent();
    text(h, b.label, 12, C.text, b.hero ? 'bold' : 'semi');
    h.addSpacer(6);
    text(h, b.pct == null ? '' : Math.round(b.pct) + '%', 10, b.isOver ? C.neg : C.faint, 'semi');
    h.addSpacer();
    text(h, money(b.actual, b.currency), 12, b.isOver ? C.neg : C.text, 'bold');
    text(h, ' / ' + (b.target == null ? '—' : money(b.target, b.currency)), 11, C.faint, 'med');
    w.addSpacer(3);
    const img = w.addImage(meterImage(b.pct, b.isOver, pace(b.period), W));
    img.imageSize = new Size(W, 12);
  });
  w.addSpacer();
}

const DRAW = {
  recent: { title: 'Recent', fn: recent, family: 'small' },
  balances: { title: 'Balances', fn: balances, family: 'small' },
  networth: { title: 'Net worth', fn: networth, family: 'small' },
  segments: { title: 'Segment targets', fn: segments, family: 'medium' }
};

async function build(kind, family) {
  const spec = DRAW[kind] || DRAW.recent;
  const w = shell(kind);
  try {
    const { d, stale } = await load();
    const n = new Date(), left = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate() - n.getDate();
    const right = stale ? 'cached' : kind === 'segments' ? left + ' day' + (left === 1 ? '' : 's') + ' left'
      : kind === 'networth' ? '6M' : '';
    header(w, spec.title, right);
    spec.fn(w, d, WIDTH[family] || WIDTH[spec.family]);
  } catch (e) {
    header(w, 'FinanceTracker');
    const t = text(w, e.message || String(e), 11, C.dim);
    t.lineLimit = 5;
    w.addSpacer();
  }
  return w;
}

// ── entry ───────────────────────────────────────────────────────────────────
if (config.runsInWidget) {
  const family = config.widgetFamily === 'medium' ? 'medium' : 'small';
  const kind = String(args.widgetParameter || '').trim().toLowerCase() ||
               (family === 'medium' ? 'segments' : 'recent');
  Script.setWidget(await build(kind, family));
} else {
  // In the app: sign in if needed, then preview any of the four.
  try {
    if (!Keychain.contains(K_COOKIE)) await signIn();
    const m = new Alert();
    m.title = 'FinanceTracker widgets';
    const kinds = Object.keys(DRAW);
    kinds.forEach((k) => m.addAction('Preview ' + DRAW[k].title));
    m.addAction('Sign in again');
    m.addCancelAction('Done');
    const i = await m.presentSheet();
    if (i === kinds.length) await signIn();
    else if (i >= 0) {
      const k = kinds[i], w = await build(k, DRAW[k].family);
      await (DRAW[k].family === 'medium' ? w.presentMedium() : w.presentSmall());
    }
  } catch (e) {
    const a = new Alert(); a.title = 'FinanceTracker'; a.message = e.message || String(e);
    a.addAction('OK'); await a.present();
  }
}
Script.complete();
