/* ============================================================================
 * app.js — the FinanceTracker SPA.
 * Vanilla JS, served as a static asset by the Cloudflare Worker, which also
 * proxies /api to the Apps Script service layer (same origin: no CORS). Eight
 * screens: Dashboard · Transactions · Budgets · Accounts · Review · Investments
 * · Exchange · Tax.
 * ========================================================================== */

/* ── server bridge: /api → Promise ───────────────────────────────────────────
 * fn is the GAS handler name ('api_getDashboard'); the Worker takes the action
 * without the prefix. Reads go over GET so they stay cacheable — the `get`/`list`
 * name prefix IS the rule, matching Router.gs ROUTES_READ_, so there's no second
 * list to keep in sync. Writes POST the args as JSON. The Worker adds the GAS
 * token; nothing secret reaches this file. */
function gs(fn, arg, _retried){
  var action = fn.replace(/^api_/, '');
  var read = /^(get|list)/.test(action);
  var url = '/api?action=' + encodeURIComponent(action), init, body = null;
  if (read){
    Object.keys(arg || {}).forEach(function(k){
      if (arg[k] != null && arg[k] !== '') url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(arg[k]);
    });
    init = { method:'GET' };
  } else {
    body = arg ? JSON.parse(JSON.stringify(arg)) : {};
    body.action = action;
    // A client-supplied ID is what makes an offline replay safe: if the request did
    // reach GAS before the connection died, the retry hits the idempotency check and
    // returns {status:'duplicate'} instead of posting a second row. Stamped here,
    // before the first attempt, so the attempt and the replay carry the same one.
    if (QUEUEABLE[action] && !body.ID) body.ID = 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    init = { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) };
  }
  return fetch(url, init).then(function(res){
    // The passphrase cookie expired (or was never set). Ask once, then retry —
    // a clean 401 is why /api answers JSON instead of redirecting to a login page.
    if (res.status === 401 && !_retried) return unlock().then(function(){ return gs(fn, arg, true); });
    return res.json().then(function(r){
      if (r == null) throw new Error('Empty response from server (a Date may have leaked into the payload).');
      if (r.status === 'error'){
        // GAS looked at the payload and refused it. `_server` marks that as final: it's
        // the ONLY thing flushQueue is allowed to discard a queued write for.
        var se = new Error(r.message || 'Server error'); se._server = true; throw se;
      }
      return r;
    }, function(){ throw new Error('Server returned '+res.status+' (not JSON)'); });
  }, function(){
    // fetch only rejects on a genuine network failure — a 4xx/5xx resolves — so this
    // branch IS "offline", without trusting navigator.onLine (true on a captive portal).
    if (body && QUEUEABLE[action] && !flushQueue._busy) return enqueue(fn, body);
    var err = new Error(read ? 'Offline — no cached copy of this yet'
                             : 'Offline — reconnect to save this');
    err._offline = true;
    throw err;
  });
}

/* ── offline ─────────────────────────────────────────────────────────────────
 * Reads already survive a dead connection: cachedCall paints from the persisted
 * S.cache and swallows the failed revalidation. sw.js caches the shell so the app
 * opens at all. What's left is writes, and only these two get queued — both are
 * idempotent on a client-supplied ID, so replaying one that actually landed can't
 * double-post. Edits, deletes, account and Ledger writes are NOT queued: they're
 * desk work rather than something you do in a queue at a till, and
 * appendLedgerRow isn't idempotent at any price. They fail with a clear message. */
var LS_QUEUE = 'ft.queue';
var QUEUEABLE = { createTransaction:1, createTransfer:1 };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function(){});

function queue(){ try{ return JSON.parse(localStorage.getItem(LS_QUEUE)||'[]'); }catch(e){ return []; } }
function queueSet(q){ try{ localStorage.setItem(LS_QUEUE, JSON.stringify(q)); }catch(e){} }
function queueDrop(id){ queueSet(queue().filter(function(x){ return x.arg.ID !== id; })); }
function enqueue(fn, body){
  var q = queue(); q.push({ fn:fn, arg:body }); queueSet(q);
  toast('Saved offline — '+q.length+' waiting to sync','ok');
  return { status:'queued' };
}
/* Pending rows are derived from the queue, so an offline entry is still on screen
 * after a relaunch. Called on boot and after a flush — NOT on enqueue, where the
 * call site's own optimistic row is already painted and equivalent. */
function rebuildPending(){
  S.tx.pendingAdds = queue().map(function(item){ return optimisticTx(item.arg); });
  repaintTxList();
}
/* Replay oldest-first, serially (writes take a script lock anyway, and order is the
 * order they were entered). `_busy` is also what stops gs() re-queueing a call that
 * fails mid-flush — without it, flushing on a still-dead connection would duplicate
 * every entry it touched. */
function flushQueue(){
  if(flushQueue._busy || !queue().length) return Promise.resolve();
  flushQueue._busy = true;
  var sent = 0;
  return queue().reduce(function(p, item){
    return p.then(function(){
      return gs(item.fn, item.arg).then(function(){ sent++; queueDrop(item.arg.ID); }, function(e){
        // Discard ONLY when GAS itself rejected the payload (a category renamed while
        // offline, say) — that would otherwise retry forever and wedge the queue behind
        // one bad row. Everything else keeps the entry and stops the run: still offline,
        // an expired passphrase cookie, a cancelled or mistyped prompt, a 5xx. Dropping
        // money because the cookie lapsed would be the worst bug in here.
        if(!(e && e._server)) throw e;
        queueDrop(item.arg.ID);
        toast('Dropped an offline entry: '+(e.message||e),'err');
      });
    });
  }, Promise.resolve()).catch(function(){}).then(function(){
    flushQueue._busy = false;
    rebuildPending();
    if(sent){ toast('Synced '+sent+(sent>1?' entries':' entry'),'ok'); afterMutation(); }
  });
}
window.addEventListener('online', flushQueue);

/* ── login ───────────────────────────────────────────────────────────────────
 * A real <form> with a real password field, NOT window.prompt. prompt() was the
 * single cause of all three complaints about this dialog: it shows the passphrase
 * in clear text, no password manager will ever fill it, and on iOS its field
 * autocapitalises and autocorrects — which is why the passphrase used to take
 * several attempts to land. The form is what makes iOS offer AutoFill (the key
 * above the keyboard) and offer to save into Apple Passwords on submit; the
 * username field is there so the saved entry has a name to match on.
 * A wrong passphrase now re-asks in place instead of rejecting every in-flight
 * call, so one typo no longer costs you the whole boot.
 * Shared between concurrent callers: boot fires several /api calls at once, so a
 * lapsed cookie produces several 401s together — without this you get a stack of
 * identical dialogs, one per in-flight request. */
var _unlocking = null;
function unlock(){
  if (_unlocking) return _unlocking;
  _unlocking = new Promise(function(resolve, reject){
    var f = el('form');
    f.innerHTML =
      '<div class="modal-h"><h3>Unlock</h3></div>' +
      '<div class="modal-b">' +
        '<div class="field"><label for="loginUser">App</label>' +
          '<input id="loginUser" name="username" autocomplete="username" value="FinanceTracker" readonly></div>' +
        '<div class="field"><label for="loginPass">Passphrase</label>' +
          '<input id="loginPass" name="password" type="password" autocomplete="current-password" ' +
                 'autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" required>' +
          '<p class="hint" id="loginErr" style="color:var(--neg)" hidden></p></div>' +
      '</div>' +
      '<div class="modal-f"><button type="button" class="btn" id="loginCancel">Cancel</button>' +
        '<button type="submit" class="btn primary">Unlock</button></div>';
    openModal(f);
    closeModal.onClose = function(){ reject(new Error('Locked')); };   // backdrop / Escape / ✕
    $('#loginCancel', f).onclick = closeModal;
    setTimeout(function(){ $('#loginPass', f).focus(); }, 0);
    f.onsubmit = function(e){
      e.preventDefault();
      var pass = $('#loginPass', f).value, btn = $('.btn.primary', f), err = $('#loginErr', f);
      btn.disabled = true; err.hidden = true;
      fetch('/login', { method:'POST', headers:{'Content-Type':'application/json'},
                        body:JSON.stringify({ pass:pass }) })
        .then(function(r){
          btn.disabled = false;
          if (!r.ok){ err.textContent = 'Wrong passphrase'; err.hidden = false; $('#loginPass', f).select(); return; }
          closeModal.onClose = null; closeModal();
          resolve();
        }, function(){
          btn.disabled = false;
          err.textContent = 'No connection'; err.hidden = false;
        });
    };
  });
  _unlocking.then(function(){ _unlocking = null; }, function(){ _unlocking = null; });
  return _unlocking;
}

/* ── stale-while-revalidate cache, gated by the server data version ──────────
 * cachedCall(key, loader, onData): paint instantly from cache, then check the
 * tiny api_getDataVersion; only re-run `loader` (the big payload) when the
 * version moved. onData may fire twice: once from cache, once after a refetch.
 * `loader` is a thunk returning a Promise (so callers can Promise.all).
 *
 * Round trips are the whole cost here — every /api call is a fresh GAS execution
 * behind the Worker — so two things keep them to a minimum: a cold key takes the version
 * straight out of its own payload (read handlers stamp `version`; the separate
 * api_getDataVersion is only a fallback for composite payloads), and a version
 * checked within VER_TTL is trusted, which kills the duplicate pings from a
 * re-render or a quick tab flip back and forth. */
var VER_TTL = 3000;
function verKnown(){ return S._verAt && (Date.now() - S._verAt) < VER_TTL; }
/* Post-write invalidation: drop every payload AND the "version just checked"
 * stamp, since the write bumped the version server-side. */
function dropCache(){ S.cache={}; S._verAt=0; saveCache(); }
function putCache(key, data, version){
  S.cache[key] = { data:data, version:version };
  S.dataVersion = version; S._verAt = Date.now();
  saveCache();
}
function cachedCall(key, loader, onData){
  var cached = S.cache[key], gen = screenGen;
  // Cache the payload regardless, but only PAINT it if the screen that asked for it
  // is still on screen — otherwise a slow fetch lands after you've navigated away and
  // yanks you back to the screen you left.
  function emit(d){ if (gen === screenGen) onData(d); }
  function fill(v){                       // fetch the payload and cache it at version v
    return loader().then(function(data){
      var ver = (data && data.version != null) ? data.version : v;
      if (ver == null) return gs('api_getDataVersion').then(function(r){ putCache(key, data, r.version); emit(data); });
      putCache(key, data, ver); emit(data);
    });
  }
  if (!cached) return fill(verKnown() ? S.dataVersion : null);
  emit(cached.data);                      // instant paint from cache
  if (verKnown()) return S.dataVersion === cached.version ? Promise.resolve() : fill(S.dataVersion);
  return gs('api_getDataVersion').then(function(v){
    S.dataVersion = v.version; S._verAt = Date.now();
    if (v.version === cached.version) return;          // unchanged → no big fetch
    return fill(v.version);                            // repaint with fresh data
  }).catch(function(){ /* keep showing stale on a revalidation hiccup */ });
}

/* ── cache persistence ───────────────────────────────────────────────────────
 * The version gate makes the cache safe to reuse across a reload, so keep it in
 * localStorage: a reload (or reopening the home-screen shortcut) paints from disk
 * and spends one tiny version call instead of going cold on every screen. Since
 * v1.6.0 this actually survives: the app has a stable origin of its own, where the
 * old GAS sandbox origin could rotate and wipe it. Still best-effort (Safari
 * evicts under storage pressure and in private browsing). */
// `s` is a schema stamp: bump it whenever a cached payload's SHAPE changes, so a
// deploy can't leave the old session's blob rendering against new code.
var LS_CACHE = 'ft.cache', LS_SCHEMA = 1;
function saveCache(){
  clearTimeout(saveCache._t);
  saveCache._t = setTimeout(function(){
    try{
      // ponytail: keep the last 12 keys — that's the entire eviction policy. Object
      // key order is insertion order, and S.cache is wiped on every write anyway.
      var keys = Object.keys(S.cache).slice(-12), c = {};
      keys.forEach(function(k){ c[k] = S.cache[k]; });
      localStorage.setItem(LS_CACHE, JSON.stringify({ s:LS_SCHEMA, boot:S.boot, cache:c }));
    }catch(e){ try{ localStorage.removeItem(LS_CACHE); }catch(e2){} }  // quota/full → start clean
  }, 400);
}
function loadCache(){
  try{
    var o = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
    if(!o || o.s !== LS_SCHEMA) return false;
    if(o.cache) S.cache = o.cache;
    if(o.boot){ S.boot = o.boot; S.dataVersion = o.boot.version; }  // _verAt stays 0 → still revalidates
    return !!o.boot;
  }catch(e){ return false; }
}

/* Shared transaction-page fetch (Transactions + Review). st = {filters,offset,limit}. */
function fetchTxPage(st){
  var args={ limit:st.limit, offset:st.offset };
  var fl=st.filters||{};
  if(fl.month)args.month=fl.month; if(fl.category)args.category=fl.category;
  if(fl.account)args.account=fl.account; if(fl.search)args.search=fl.search;
  if(fl.segment)args.segment=fl.segment;
  return gs('api_listTransactions',args);
}

/* ── app state ───────────────────────────────────────────────────────────── */
var S = {
  boot:null,            // getBootstrap payload
  month:null,           // selected period "yyyy-MMM"
  screen:'dashboard',
  dataVersion:null,     // last server data version we hold cache against
  _verAt:0,             // when we last confirmed dataVersion with the server (ms)
  cache:{},             // key → { data, version } (stale-while-revalidate, persisted)
  tx:{ rows:[], total:0, offset:0, limit:50, filters:{},
       pendingAdds:[], pendingDeletes:{}, pendingEdits:{} },  // optimistic rows: in-flight creates / edits / deletes
  review:{ sel:{}, filters:{}, rows:[], total:0, offset:0, limit:50 }
};

var PHP = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2});
var PHP0 = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:0});
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* ── tiny DOM helpers ────────────────────────────────────────────────────── */
function $(s,r){return (r||document).querySelector(s);}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function money(n,big){if(n==null||n==='')return '—';return (big?PHP0:PHP).format(Number(n));}
// Currency-aware format — used for non-PHP transactions so a USD amount renders
// as $ (narrow symbol), not ₱. Falls back to "CUR 1,234.56" on unknown codes.
var _curFmt={};
function moneyCur(n,cur){
  if(n==null||n==='')return '—';
  cur=cur||'PHP';
  if(cur==='PHP')return PHP.format(Number(n));
  try{ if(!_curFmt[cur])_curFmt[cur]=new Intl.NumberFormat('en-PH',{style:'currency',currency:cur,currencyDisplay:'narrowSymbol',maximumFractionDigits:2});
       return _curFmt[cur].format(Number(n)); }
  catch(e){ return cur+' '+Number(n).toLocaleString('en-PH',{maximumFractionDigits:2}); }
}
function num(n){return n==null?'—':Number(n).toLocaleString('en-PH',{maximumFractionDigits:4});}
function pct(n){return n==null?'—':(Math.round(n*10)/10)+'%';}

/* ── account color helpers (color-coding across screens) ─────────────────── */
function isHex6(c){return !!c && /^#[0-9a-fA-F]{6}$/.test(c);}
// Look up an account's color by name from the bootstrap (null if boot not loaded).
function acctColor(name){
  if(!S.boot||!name) return null;
  var a=(S.boot.accounts||[]).filter(function(x){return x.name===name;})[0];
  return (a && isHex6(a.color))?a.color:null;
}
// A small colored dot (validated hex, so safe to inline into innerHTML).
function dotHTML(c){ return isHex6(c)?'<span class="acct-dot" style="background:'+c+'"></span>':''; }
// Account options for comboEl, carrying each account's color for the dropdown dots.
function acctOptions(){
  return (S.boot&&S.boot.accounts?S.boot.accounts:[]).map(function(a){
    return {value:a.name,label:a.name,color:a.color};
  });
}
function acctCurrency(name){
  var a=((S.boot&&S.boot.accounts)||[]).filter(function(x){return x.name===name;})[0];
  return a?(a.currency||'PHP'):'PHP';
}
// A tx is a transfer if its derived Type says so or it carries a ToAccount.
function txIsXfer(t){ return String(t.Type||'')==='Transfer'||!!(t.ToAccount&&String(t.ToAccount).trim()); }
// Categories valid for a row's shape: Transfer categories only on transfers, and
// vice versa (mirrors the server invariant so the picker can't offer a mismatch).
function catsForShape(isXfer){
  var c=(S.boot&&S.boot.categories)||{};
  return Object.keys(c).filter(function(k){ return (String(c[k].Type)==='Transfer')===!!isXfer; }).sort();
}

/* ── toast ───────────────────────────────────────────────────────────────── */
function toast(msg,kind){
  var t=el('div','toast '+(kind||''),esc(msg));
  $('#toastRoot').appendChild(t);
  var ms = kind==='err'?6000:2400; // errors linger long enough to read
  setTimeout(function(){t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(function(){t.remove();},300);},ms);
}

/* ── month helpers ───────────────────────────────────────────────────────── */
function monthKey(d){return d.getFullYear()+'-'+MONTHS[d.getMonth()];}      // "2026-Jun"
function monthLabel(m){var p=String(m).split('-');return p.length===2?p[1]+' '+p[0]:m;} // "Jun 2026"
function monthOptions(){return buildMonthList().map(function(m){return {value:m,label:monthLabel(m)};});}
/* The period control lives on the screens it actually drives (Dashboard, Budgets),
 * not the topbar — there it was a silent no-op on the other six screens, since
 * Transactions/Review own their month as one of four in-screen filters.
 * Refocus after the repaint: the picker is inside the screen we just replaced, and
 * arrow-keying a closed <select> fires change per keypress. */
function monthPickerEl(){
  var mp=el('select','month-picker'); mp.title='Period';
  buildMonthList().forEach(function(m){var o=el('option');o.value=m;o.textContent=monthLabel(m);mp.appendChild(o);});
  mp.value=S.month;
  mp.onchange=function(){
    S.month=mp.value; S.cache={};
    Promise.resolve(render()).then(function(){ var n=$('.month-picker'); if(n) n.focus(); });
  };
  return mp;
}
function buildMonthList(){
  var out=[], now=new Date();
  // Extend back to the oldest ledger month so older history is reachable; floor at
  // 15 months (before any data lands) and cap at 120 to bound a huge/garbled ledger.
  var min=(S.boot&&S.boot.minMonth)?monthKey2date(S.boot.minMonth):null;
  var count=15;
  if(min){
    var months=(now.getFullYear()-min.getFullYear())*12+(now.getMonth()-min.getMonth())+1;
    count=Math.min(120,Math.max(15,months));
  }
  // Starts at i=-1 (NEXT month) so income booked forward via Period — salary paid on
  // the 29th for the following month — is both selectable and viewable.
  for(var i=-1;i<count;i++){var d=new Date(now.getFullYear(),now.getMonth()-i,1);out.push(monthKey(d));}
  return out;
}
// "2026-Jun" → Date(first of month); null on bad input.
function monthKey2date(m){
  var p=String(m).split('-'); if(p.length!==2) return null;
  var mi=MONTHS.indexOf(p[1]); if(mi<0) return null;
  return new Date(parseInt(p[0],10),mi,1);
}

/* ── boot ────────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', boot);

// getBootstrap (categories/accounts for modals & filters) loads in the BACKGROUND
// so the first screen can paint without waiting on it / on the live FX fetch.
var _bootPromise=null;
function applyBoot(b){
  S.boot=b;
  if(b.version!=null){ S.dataVersion=b.version; S._verAt=Date.now(); }
  // getBootstrap already carries the full api_getAccounts payload, so seed that
  // screen's cache key from it — the Accounts screen then opens with zero fetches.
  if(b.accounts && b.version!=null) S.cache['accounts']={data:{status:'success',accounts:b.accounts},version:b.version};
  saveCache();
  return b;
}
function ensureBoot(){
  if(S.boot) return Promise.resolve(S.boot);   // incl. a boot restored from storage
  if(!_bootPromise) _bootPromise=gs('api_getBootstrap').then(applyBoot);
  return _bootPromise;
}
/* A boot restored from localStorage is stale by definition (and FX drift doesn't
 * bump the data version), so refetch in the background and repaint only if
 * something actually moved. */
function revalidateBoot(){
  var old=S.boot;
  return gs('api_getBootstrap').then(function(b){
    var moved = b.version!==old.version || b.fxUsdPhp!==old.fxUsdPhp;
    applyBoot(b);
    if(moved) render();
    return b;
  });
}
/** Run cb once reference data is available (used by modals/filters that need it). */
function withBoot(cb){
  if(S.boot) return cb();
  toast('Loading…');
  return ensureBoot().then(cb).catch(function(e){ toast(e.message||e,'err'); });
}

function boot(){
  var warm = loadCache();   // before the first render: paint from the last session
  S.month = monthKey(new Date());
  document.querySelectorAll('.nav-item[data-screen]').forEach(function(b){
    b.addEventListener('click', function(){ go(b.dataset.screen); });
  });
  // mobile "More" sheet (secondary screens)
  $('#navMore').addEventListener('click', openSheet);
  $('.sheet-backdrop').addEventListener('click', closeSheet);
  document.querySelectorAll('.sheet-item').forEach(function(b){
    b.addEventListener('click', function(){ go(b.dataset.screen); });
  });
  $('#refreshBtn').addEventListener('click', refresh);
  $('#fab').addEventListener('click', function(){ withBoot(function(){ openTxModal(null); }); });

  // Browser back/forward moves between screens. Plain History API now that the app
  // is served from its own origin instead of the GAS sandbox iframe (which blocked
  // pushState and needed google.script.history).
  window.addEventListener('popstate', function(){
    var s=new URLSearchParams(location.search).get('screen')||'dashboard';
    if(s!==S.screen) go(s,true);
  });
  // Scroll-wheel over a focused number input silently changes the value — block it.
  document.addEventListener('wheel',function(e){
    if(e.target.type==='number' && document.activeElement===e.target) e.preventDefault();
  },{passive:false});

  // Paint the first screen right away (it fetches its own data); hydrate the
  // reference data in parallel, then re-render so warm FX / counts are reflected.
  // One synchronous decision, so a reload never flashes the Dashboard first:
  // ?screen= (a bookmarked or Telegram-sent link) wins over the stored last screen.
  // Before the first paint, so anything written while offline is already in the row
  // list the render is about to build (S.screen is still the default here, so this
  // can't re-enter renderTxList early).
  rebuildPending();
  var p=new URLSearchParams(location.search);
  var first=p.get('screen')||lastScreen();
  if(first) go(first,true); else render();
  // ?tx=<ID> — the Telegram receipt's "Edit details" button: open that row's modal.
  if(p.get('tx')) openTxById(p.get('tx'));
  (warm ? revalidateBoot() : ensureBoot().then(function(){
    if(S.screen==='dashboard'||S.screen==='budgets') render();
  })).catch(function(e){ toast('Reference data failed: '+(e.message||e),'err'); });
  // Launching IS a reconnect signal: the 'online' event doesn't fire for an app that
  // was closed while offline and reopened with a connection.
  flushQueue();
}

function refresh(){
  var btn=$('#refreshBtn'); btn.classList.add('spin');
  S.cache={}; S.boot=null; _bootPromise=null; S._verAt=0; saveCache();
  // Also drop the cached shell and retry the queue, which makes Refresh the single
  // answer to both "I deployed and still see the old UI" (new files land next launch,
  // see sw.js) and "this is still waiting to sync".
  if(window.caches) caches.keys().then(function(ks){ ks.forEach(function(n){ caches.delete(n); }); });
  flushQueue();
  ensureBoot().then(function(){ return render(); }).finally(function(){ btn.classList.remove('spin'); });
}

var SECONDARY_SCREENS={review:1,investments:1,exchange:1,tax:1};
/* Last screen, so a browser reload comes back where you were. The parent URL
 * (?screen=, pushed below) is the primary channel; localStorage covers reloads
 * that drop it — an iOS home-screen shortcut reopens its start_url, not the
 * current one. Best-effort: Safari can evict storage under pressure or in private
 * browsing, hence the try/catch. */
function lastScreen(){ try{ return localStorage.getItem('ft.screen')||null; }catch(e){ return null; } }
function openSheet(){ $('#sheetRoot').hidden=false; }
function closeSheet(){ $('#sheetRoot').hidden=true; }

function go(screen, fromHistory){
  S.screen=screen;
  document.querySelectorAll('.nav-item[data-screen]').forEach(function(b){b.classList.toggle('active', b.dataset.screen===screen);});
  $('#navMore').classList.toggle('active', !!SECONDARY_SCREENS[screen]);
  document.querySelectorAll('.sheet-item').forEach(function(b){b.classList.toggle('active', b.dataset.screen===screen);});
  closeSheet();
  try{ localStorage.setItem('ft.screen',screen); }catch(e){}
  if(!fromHistory) history.pushState(null,'','?screen='+encodeURIComponent(screen));
  render();
}

/* Bumped on every screen render; every async paint captures it and bails if it
 * moved (see cachedCall / needBoot). */
var screenGen=0;
/* Screens that can't paint without the bootstrap payload: show a skeleton, then
 * re-enter once it lands — unless the user has moved on. */
function needBoot(kind, fn){
  if(S.boot) return false;
  loading(kind); var gen=screenGen;
  ensureBoot().then(function(){ if(gen===screenGen) fn(); }).catch(showErr);
  return true;
}

/* ── render dispatcher ───────────────────────────────────────────────────── */
function render(){
  screenGen++;
  var fns={dashboard:renderDashboard,transactions:renderTransactions,accounts:renderAccounts,
           review:renderReview,budgets:renderBudgets,investments:renderInvestments,
           exchange:renderExchange,tax:renderTax};
  return (fns[S.screen]||renderDashboard)();
}
function paint(node){ var m=$('#main'); m.innerHTML=''; m.appendChild(node); }

/* ── skeletons ───────────────────────────────────────────────────────────────
 * A placeholder shaped like the screen that's coming, instead of a spinner: the
 * layout doesn't jump when data lands, and the wait reads as progress. Built out
 * of the REAL .card/.stat/.grid/.litem boxes with shimmer bars inside, so the
 * shapes track the actual screens for free. */
function skBar(h,w){ return '<div class="skeleton" style="height:'+h+'px;width:'+w+'"></div>'; }
function skRows(n){
  var o='';
  for(var i=0;i<(n||5);i++) o+='<div class="litem">'+
    '<div class="skeleton" style="height:34px;width:34px;border-radius:10px;flex:none"></div>'+
    '<div class="grow">'+skBar(12,(50+(i%3)*14)+'%')+skBar(10,'30%')+'</div>'+skBar(14,'72px')+'</div>';
  return o;
}
function skCard(inner){ return '<div class="card">'+inner+'</div>'; }
function skTiles(n){
  var o=''; for(var i=0;i<n;i++) o+='<div class="stat">'+skBar(11,'46%')+skBar(24,'70%')+'</div>';
  return '<div class="grid grid-'+n+'">'+o+'</div>';
}
var SKELS={
  dashboard:function(){ return '<div class="stat hero">'+skBar(11,'30%')+skBar(34,'58%')+skBar(10,'100%')+'</div>'+
    skTiles(3)+skCard(skBar(11,'34%')+skBar(150,'100%'))+skCard(skBar(11,'26%')+skRows(4)); },
  accounts: function(){ return skTiles(2)+skCard(skBar(11,'26%')+skRows(4))+skCard(skBar(11,'26%')+skRows(3)); },
  budgets:  function(){ return skCard(skBar(11,'34%')+skBar(28,'50%')+skBar(10,'100%'))+skCard(skBar(11,'26%')+skRows(5)); },
  list:     function(){ return '<div class="filters">'+skBar(34,'170px')+skBar(34,'130px')+skBar(34,'130px')+'</div>'+skCard(skRows(7)); },
  table:    function(){ return skCard(skBar(11,'30%')+skRows(6)); }
};
function loading(kind){
  var f=SKELS[kind]||SKELS.table;
  $('#main').innerHTML='<div class="screen">'+skBar(21,'34%')+'<div style="height:16px"></div>'+f()+'</div>';
}

/* ════════════════════════════════════════════════════════════════════════
 *  CHART HELPERS — inline SVG, no library. Specs: thin marks with a rounded
 *  data end, square baseline; hairline solid gridlines; text in ink tokens
 *  (never the series color); a legend for 2 series; hover tooltip on a hit
 *  band wider than the marks. Series colors are the validated --chart-* pair.
 * ════════════════════════════════════════════════════════════════════════ */
function svgEl(tag,attrs){
  var e=document.createElementNS('http://www.w3.org/2000/svg',tag);
  Object.keys(attrs||{}).forEach(function(k){e.setAttribute(k,attrs[k]);});
  return e;
}
// Axis labels: ₱1.2M / ₱45K / ₱450. Intl also keeps a 2500 tick as "₱2.5K"
// (the old hand-rolled rounding rendered it "₱3K").
var PHPC = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',notation:'compact',maximumFractionDigits:1});
function compactPhp(n){ return PHPC.format(Number(n)); }
function niceCeil(n){                 // round up to 1/2/2.5/5×10^k for clean axis ticks
  if(!(n>0)) return 1;
  var p=Math.pow(10,Math.floor(Math.log(n)/Math.LN10)), f=n/p;
  return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p;
}
// Column rounded at the top (the data end), square at the baseline.
function barPath(x,y,w,h,r){
  r=Math.min(r==null?4:r,w/2,h);
  return 'M'+x+' '+(y+h)+' V'+(y+r)+' Q'+x+' '+y+' '+(x+r)+' '+y+' H'+(x+w-r)+
         ' Q'+(x+w)+' '+y+' '+(x+w)+' '+(y+r)+' V'+(y+h)+' Z';
}
// 6-point sparkline: de-emphasis stroke, current period as an accent dot.
function sparklineSVG(values,h){
  if(!values || values.length<2) return null;
  var w=110; h=h||26; var pad=4;
  var max=Math.max.apply(null,values), min=Math.min.apply(null,values);
  if(max===min) max=min+1;
  var pts=values.map(function(v,i){
    return [pad+i*(w-2*pad)/(values.length-1), h-pad-(v-min)/(max-min)*(h-2*pad)];
  });
  var svg=svgEl('svg',{class:'chart-svg stat-spark',viewBox:'0 0 '+w+' '+h,'aria-hidden':'true'});
  svg.appendChild(svgEl('polyline',{points:pts.map(function(p){return p.join(',');}).join(' '),
    fill:'none',stroke:'var(--text-faint)','stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round'}));
  var lp=pts[pts.length-1];
  svg.appendChild(svgEl('circle',{cx:lp[0],cy:lp[1],r:3.5,fill:'var(--accent)',stroke:'var(--surface)','stroke-width':2}));
  return svg;
}
// Delta pill: arrow follows direction, color follows whether the move is GOOD
// (spending up = red, income up = green — semantic color, not raw direction).
function deltaEl(cur,prev,upIsGood,vsLabel){
  if(cur==null||prev==null||!isFinite(prev)||prev<=0) return null;
  var ch=(cur-prev)/prev*100;
  var dir=ch>0.5?'up':(ch<-0.5?'down':'flat');
  var cls=dir==='flat'?'flat':(((dir==='up')===!!upIsGood)?'up':'down');
  var arrow=dir==='up'?'▲':(dir==='down'?'▼':'·');
  var s=el('span','delta '+cls,arrow+' '+Math.abs(Math.round(ch))+'%'+
    (vsLabel?' <span style="opacity:.72;font-weight:500">'+esc(vsLabel)+'</span>':''));
  s.style.marginTop='8px';
  return s;
}
// Paired-column cash-flow chart (income vs spending per month) + tooltip.
// `width` = the host's real pixel width, so SVG text renders at 1:1 scale
// (a fixed viewBox scaled down would shrink labels below legibility).
function cashflowChart(cf,width){
  var wrap=el('div','chart-wrap');
  var legend=el('div','chart-legend');
  legend.innerHTML='<span class="lg"><span class="lg-key" style="background:var(--chart-income)"></span>Income</span>'+
    '<span class="lg"><span class="lg-key" style="background:var(--chart-spend)"></span>Spending</span>';
  wrap.appendChild(legend);
  var W=Math.max(300,width||640),H=200,L=48,R=6,T=10,B=26,pw=W-L-R,ph=H-T-B;
  var max=0; cf.forEach(function(m){max=Math.max(max,m.income,m.expense);});
  max=niceCeil(max);
  var svg=svgEl('svg',{class:'chart-svg',viewBox:'0 0 '+W+' '+H,role:'img','aria-label':'Cash flow — income vs spending, last '+cf.length+' months'});
  [0,.5,1].forEach(function(f){
    var y=T+ph-f*ph;
    if(f>0) svg.appendChild(svgEl('line',{x1:L,y1:y,x2:W-R,y2:y,stroke:'var(--grid-line)','stroke-width':1}));
    var t=svgEl('text',{x:L-8,y:y+3.5,'text-anchor':'end'}); t.textContent=compactPhp(max*f); svg.appendChild(t);
  });
  var band=pw/cf.length, bw=Math.min(20,band*0.26);
  var tip=el('div','chart-tip'); tip.hidden=true;
  cf.forEach(function(m,i){
    var cx=L+band*i+band/2;
    var hI=m.income/max*ph, hS=m.expense/max*ph;
    var topY=T+ph-Math.max(hI,hS);
    if(hI>=1) svg.appendChild(svgEl('path',{d:barPath(cx-bw-1,T+ph-hI,bw,hI),fill:'var(--chart-income)'}));
    if(hS>=1) svg.appendChild(svgEl('path',{d:barPath(cx+1,T+ph-hS,bw,hS),fill:'var(--chart-spend)'}));
    var lbl=svgEl('text',{x:cx,y:H-8,'text-anchor':'middle'});
    if(i===cf.length-1){ lbl.setAttribute('fill','var(--text-dim)'); lbl.setAttribute('font-weight','700'); }
    lbl.textContent=String(m.month).split('-')[1]||m.month;
    svg.appendChild(lbl);
    var hit=svgEl('rect',{x:L+band*i,y:T,width:band,height:ph,fill:'transparent'});
    function show(){
      tip.innerHTML='<b>'+esc(monthLabel(m.month))+'</b><br>'+
        '<span class="lg-key" style="background:var(--chart-income)"></span>Income <b>'+money(m.income,true)+'</b><br>'+
        '<span class="lg-key" style="background:var(--chart-spend)"></span>Spending <b>'+money(m.expense,true)+'</b>';
      var sr=svg.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
      var x=sr.left-wr.left+cx/W*sr.width;
      x=Math.max(78,Math.min(x,wr.width-78));
      tip.style.left=x+'px';
      tip.style.top=(sr.top-wr.top+topY/H*sr.height)+'px';
      tip.hidden=false;
    }
    hit.addEventListener('mouseenter',show);
    hit.addEventListener('click',show);                 // touch
    hit.addEventListener('mouseleave',function(){ tip.hidden=true; });
    svg.appendChild(hit);
  });
  svg.appendChild(svgEl('line',{x1:L,y1:T+ph,x2:W-R,y2:T+ph,stroke:'var(--border-2)','stroke-width':1}));
  wrap.appendChild(svg); wrap.appendChild(tip);
  return wrap;
}
// Horizontal single-hue category bars (spend by segment) — label left,
// value outside the bar end (never clipped inside).
function hbarList(entries){
  var host=el('div');
  var max=0; entries.forEach(function(e2){max=Math.max(max,e2[1]);});
  entries.forEach(function(pair){
    var r=el('div','hbar');
    r.appendChild(el('div','hbar-lab',esc(pair[0])));
    var tr=el('div','hbar-track');
    tr.innerHTML='<div class="hbar-fill" style="width:'+(max?Math.max(2,pair[1]/max*100):0)+'%"></div>';
    r.appendChild(tr);
    r.appendChild(el('div','hbar-val',money(pair[1],true)));
    host.appendChild(r);
  });
  return host;
}
// Budget meter: track is a lighter step of the fill's own ramp; the pace notch
// marks how much of the period has elapsed (spend "should" sit near it).
function meterRow(b,paceFrac){
  var r=el('div'); r.style.marginBottom='18px';
  var p=b.pctUsed==null?0:b.pctUsed;
  var state=b.isOver?'over':(p>=85?'warn':'');
  var head=el('div','row-between');
  head.innerHTML='<div><strong>'+esc(b.segment)+'</strong> <span class="pill">'+esc(b.period)+'</span></div>'+
    '<div class="mono" style="font-size:13px">'+money(b.actualPhp,true)+' <span class="faint">/ '+money(b.targetPhp,true)+'</span></div>';
  r.appendChild(head);
  var m=el('div','meter '+state);
  m.innerHTML='<div class="meter-fill" style="width:'+Math.min(100,p)+'%"></div>';
  if(paceFrac!=null&&paceFrac>0.02&&paceFrac<0.98){
    var pm=el('div','meter-pace'); pm.style.left='calc('+(paceFrac*100)+'% - 1px)';
    pm.title=Math.round(paceFrac*100)+'% of the period has elapsed';
    m.appendChild(pm);
  }
  r.appendChild(m);
  var over=b.isOver&&b.remainingPhp!=null;
  var sub=el('div','row-between'); sub.style.cssText='margin-top:6px;font-size:12px';
  sub.innerHTML='<span class="dim">'+pct(b.pctUsed)+' used</span>'+
    '<span class="'+(b.isOver?'neg':'dim')+'">'+(b.remainingPhp==null?'':
      (over?money(Math.abs(b.remainingPhp),true)+' over':money(b.remainingPhp,true)+' left'))+'</span>';
  r.appendChild(sub);
  return r;
}
// Fraction of the current budget period already elapsed (null off-period).
function periodPace(period,monthStr){
  var now=new Date();
  if(monthStr!==monthKey(now)) return null;
  var day=now.getDate(), days=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  if(/^quarter/i.test(String(period))) return (now.getMonth()%3+day/days)/3;
  return day/days;
}

/* ════════════════════════════════════════════════════════════════════════
 *  DASHBOARD — hierarchy: hero number → KPI row → cash flow → budgets →
 *  where it went → balances → recent. One glance answers "am I okay?".
 * ════════════════════════════════════════════════════════════════════════ */
function renderDashboard(){
  var key='dashboard|'+S.month;
  if(!S.cache[key]) loading('dashboard');
  return cachedCall(key, function(){return gs('api_getDashboard',{month:S.month});}, function(d){
    var w=el('div','screen');
    var head=el('div','screen-head');
    head.appendChild(el('div','screen-title','Dashboard'));
    head.appendChild(monthPickerEl());
    w.appendChild(head);

    var cf=d.cashflow||[];
    var cur=cf.length?cf[cf.length-1]:null, prev=cf.length>1?cf[cf.length-2]:null;
    var prevLbl=prev?('vs '+String(prev.month).split('-')[1]):null;

    // ── hero: net worth + asset/liability split bar ──
    var hero=el('div','stat hero');
    var assets=d.assets||0, liabAbs=Math.abs(d.liabilities||0);
    hero.innerHTML='<div class="stat-label">Net worth</div><div class="stat-value">'+money(d.netWorth,true)+'</div>';
    if(assets>0||liabAbs>0){
      var sb=el('div','split-bar');
      sb.innerHTML='<div class="split-a" style="flex:'+(assets||0.0001)+'"></div>'+
        (liabAbs>0?'<div class="split-l" style="flex:'+liabAbs+'"></div>':'');
      hero.appendChild(sb);
      var lg=el('div','split-legend');
      lg.innerHTML='<span><span class="lg-key" style="background:var(--chart-income)"></span>Assets <b>'+money(assets,true)+'</b></span>'+
        '<span><span class="lg-key" style="background:var(--chart-neg)"></span>Liabilities <b>'+money(liabAbs,true)+'</b></span>';
      hero.appendChild(lg);
    }
    w.appendChild(hero);

    // ── KPI row ──
    // A live (incomplete) month vs a finished month is a misleading delta, so
    // deltas only show for completed months; the live month says "month to date".
    var isLive=S.month===monthKey(new Date());
    var monthSpend=0; Object.keys(d.spendBySegment||{}).forEach(function(k){monthSpend+=d.spendBySegment[k];});
    var stats=el('div','grid grid-3 kpis');
    var tIn=el('div','stat','<div class="stat-label">Income</div><div class="stat-value">'+money(cur?cur.income:null,true)+'</div>');
    var dIn=!isLive&&cur&&prev?deltaEl(cur.income,prev.income,true,prevLbl):null;
    if(dIn)tIn.appendChild(dIn); else if(isLive)tIn.appendChild(el('div','stat-sub','month to date'));
    var sparkIn=sparklineSVG(cf.map(function(m){return m.income;}));
    if(sparkIn)tIn.appendChild(sparkIn);
    stats.appendChild(tIn);
    var tSp=el('div','stat','<div class="stat-label">Spending</div><div class="stat-value">'+money(cur?cur.expense:monthSpend,true)+'</div>');
    var dSp=!isLive&&cur&&prev?deltaEl(cur.expense,prev.expense,false,prevLbl):null;
    if(dSp)tSp.appendChild(dSp); else if(isLive)tSp.appendChild(el('div','stat-sub','month to date'));
    var spark=sparklineSVG(cf.map(function(m){return m.expense;}));
    if(spark)tSp.appendChild(spark);
    stats.appendChild(tSp);
    var tInv=el('div','stat','<div class="stat-label">Invested</div><div class="stat-value">'+money(d.sharesValue,true)+'</div>');
    tInv.appendChild(el('div','stat-sub','shares & funds'));
    stats.appendChild(tInv);
    w.appendChild(stats);

    // ── cash flow (last 6 months) — drawn after paint at the host's real width ──
    if(cf.length>=2){
      var cc=el('div','card');
      cc.appendChild(el('div','card-h','Cash flow · last 6 months'));
      var cfHost=el('div'); cc.appendChild(cfHost);
      w.appendChild(cc);
      requestAnimationFrame(function(){
        if(cfHost.isConnected) cfHost.appendChild(cashflowChart(cf, cfHost.clientWidth));
      });
    }

    // ── budgets vs actual ──
    if (d.budgets && d.budgets.length){
      var bc=el('div','card');
      bc.appendChild(el('div','card-h','Budget vs actual'));
      d.budgets.forEach(function(b){ bc.appendChild(meterRow(b, periodPace(b.period,S.month))); });
      w.appendChild(bc);
    }

    // ── where it went (spend by segment) ──
    var segs=Object.keys(d.spendBySegment||{}).map(function(k){return [k,d.spendBySegment[k]];})
      .sort(function(a,b){return b[1]-a[1];});
    if(segs.length){
      var sc=el('div','card');
      sc.appendChild(el('div','card-h','Where it went'));
      sc.appendChild(hbarList(segs));
      w.appendChild(sc);
    }

    // ── balances by type ──
    var byType=d.balancesByType||{};
    if (Object.keys(byType).length){
      var tc=el('div','card');
      tc.appendChild(el('div','card-h','Balances by type'));
      var l=el('div','list');
      Object.keys(byType).forEach(function(k){
        var v=byType[k];
        var r=el('div','litem');
        r.innerHTML='<div class="grow"><div class="t1">'+esc(k)+'</div></div><div class="amt '+(v<0?'neg':'')+'">'+money(v)+'</div>';
        l.appendChild(r);
      });
      tc.appendChild(l); w.appendChild(tc);
    }

    // ── recent transactions ──
    var rc=el('div','card');
    var rh=el('div','row-between'); rh.innerHTML='<div class="card-h" style="margin:0">Recent</div>';
    var more=el('button','btn sm ghost','View all →'); more.onclick=function(){go('transactions');};
    rh.appendChild(more); rc.appendChild(rh);
    var rl=el('div','list'); rl.style.marginTop='8px';
    (d.recentTransactions||[]).forEach(function(t){ rl.appendChild(txRow(t,true)); });
    if(!(d.recentTransactions||[]).length) rl.appendChild(el('div','empty','<span class="empty-ico">◌</span>No transactions yet.'));
    rc.appendChild(rl); w.appendChild(rc);

    paint(w);
  }).catch(showErr);
}

function tile(label,val,sub){
  return el('div','stat','<div class="stat-label">'+esc(label)+'</div><div class="stat-value">'+
    (typeof val==='string'?val:esc(val))+'</div>'+(sub?'<div class="stat-sub">'+esc(sub)+'</div>':''));
}

/* ════════════════════════════════════════════════════════════════════════
 *  TRANSACTIONS
 * ════════════════════════════════════════════════════════════════════════ */
function renderTransactions(){
  if(needBoot('list', renderTransactions)) return;
  var w=el('div','screen');
  w.appendChild(el('div','screen-title','Transactions'));

  // filters
  var f=el('div','filters');
  // Distinguish unset (→ current period) from an explicit '' ("all months"); '' meant
  // the combo showed a specific month while the list fetched everything.
  var seedMonth=S.tx.filters.month===undefined?S.month:(S.tx.filters.month===''?'(all months)':S.tx.filters.month);
  var fMonth=comboEl([{value:'(all months)',label:'(all months)'}].concat(monthOptions()), seedMonth);
  var cats=Object.keys((S.boot.categories)||{}).sort();
  var fCat=comboEl(['(all categories)'].concat(cats), S.tx.filters.category||'(all categories)');
  var fAcc=comboEl([{value:'(all accounts)',label:'(all accounts)'}].concat(acctOptions()), S.tx.filters.account||'(all accounts)');
  var fSearch=el('input','search'); fSearch.placeholder='Search…'; fSearch.value=S.tx.filters.search||'';
  [fMonth,fCat,fAcc].forEach(function(s){s.onchange=applyFilters;});
  var st; fSearch.oninput=function(){clearTimeout(st);st=setTimeout(applyFilters,350);};
  f.appendChild(fSearch); f.appendChild(fMonth); f.appendChild(fCat); f.appendChild(fAcc);
  w.appendChild(f);

  function applyFilters(){
    S.tx.filters={
      month: fMonth.value.indexOf('(all')===0?'':fMonth.value,
      category: fCat.value.indexOf('(all')===0?'':fCat.value,
      account: fAcc.value.indexOf('(all')===0?'':fAcc.value,
      search: fSearch.value.trim()
    };
    S.tx.offset=0; loadTx(w);
  }

  var listCard=el('div','card'); listCard.id='txListCard';
  listCard.innerHTML=skRows(7);
  w.appendChild(listCard);
  paint(w);

  // default filter month to selected period on first open
  if (S.tx.filters.month===undefined) S.tx.filters.month=S.month;
  loadTx(w);
}

// silent: skip the full-card spinner (keep optimistic rows on screen until fresh
// server data lands, so an added/deleted row transitions smoothly instead of flashing).
function loadTx(w, silent){
  var st={filters:S.tx.filters, offset:S.tx.offset, limit:S.tx.limit};
  var key='tx|'+JSON.stringify(S.tx.filters||{})+'|'+S.tx.offset+'|'+S.tx.limit;
  var card=$('#txListCard'); if(card && !silent && !S.cache[key]) card.innerHTML=skRows(7);
  return cachedCall(key, function(){return fetchTxPage(st);}, function(res){
    S.tx.total=res.total; S.tx.rows=res.transactions;
    renderTxList();
  }).catch(showErr);
}

// Bucket rows into day groups (display order preserved) with each day's net.
// Shared by the Transactions and Review lists.
function groupByDay(rows){
  var groups=[], byDate={};
  (rows||[]).forEach(function(t){
    var d=fmtDate(t.Date);
    if(!byDate[d]){ byDate[d]={label:d,rows:[],net:0,date:t.Date}; groups.push(byDate[d]); }
    byDate[d].rows.push(t);
    var php=Math.abs(Number(t['Amount (PHP)'])||0);
    if(String(t.Type)==='Expense') byDate[d].net-=php;
    else if(String(t.Type)==='Income') byDate[d].net+=php;
  });
  return groups;
}
function dayHeadEl(g){
  var dt=parseDate(g.date), day=dt?DAYS[dt.getDay()]+' · ':'';
  var net=Math.round(g.net*100)/100;
  return el('div','list-date','<span>'+esc(day+g.label)+'</span>'+
    (net?('<span class="ld-sum '+(net>0?'pos':'')+'">'+(net>0?'+':'−')+money(Math.abs(net),true)+'</span>'):''));
}

/* Optimistic state is shared by BOTH transaction lists: the FAB, the row modal and
 * the Telegram deep link all work from either screen, so a write started on Review
 * must show as "loading" there too. One store, one repaint entry point. */
function repaintTxList(){
  if(S.screen==='transactions') renderTxList();
  else if(S.screen==='review') renderReviewList();
}
function isPendingRow(t){ return !!(t._pending || (t.ID && (S.tx.pendingDeletes[t.ID] || S.tx.pendingEdits[t.ID]))); }
// Show an in-flight edit's NEW values while it's still in the air. Amount is patched as
// a magnitude, so keep the row's sign and its FX ratio (money() renders the signed PHP
// figure); a category change can flip Type, which drives the +/− and the icon.
function withPendingEdit(t){
  var p=t.ID&&S.tx.pendingEdits[t.ID]; if(!p) return t;
  var o=Object.assign({},t,p);
  if(p.Amount!=null){
    var old=Number(t.Amount)||0, php=Number(t['Amount (PHP)']), rate=old?Math.abs(php/old):1;
    o.Amount=(old<0?-1:1)*Math.abs(p.Amount);
    o['Amount (PHP)']=(php<0?-1:1)*Math.abs(p.Amount)*rate;
  }
  var cat=p.Category&&S.boot&&(S.boot.categories||{})[p.Category];
  if(cat&&cat.Type) o.Type=cat.Type;
  return o;
}

// Repaint the transactions list from S.tx.rows plus optimistic state (pending
// creates shown at top, pending deletes shown in-place) — no server round-trip.
function renderTxList(){
  var c=$('#txListCard'); if(!c) return;
  // pending creates only make sense on the first page (they'd be the newest rows)
  var adds=(S.tx.offset<=0)?(S.tx.pendingAdds||[]):[];
  var serverRows=S.tx.rows||[];
  var total=(S.tx.total||0)+adds.length;
  c.innerHTML='';
  var head=el('div','row-between'); head.style.marginBottom='6px';
  head.innerHTML='<div class="card-h" style="margin:0">'+total+' transaction'+(total===1?'':'s')+'</div>';
  c.appendChild(head);
  // group by day: header shows weekday + date + the day's net (income − spend)
  var allRows=adds.concat(serverRows);   // optimistic adds sort ahead within their date
  var l=el('div','list');
  groupByDay(allRows).forEach(function(g){
    l.appendChild(dayHeadEl(g));
    g.rows.forEach(function(t){
      var pending = isPendingRow(t);
      l.appendChild(txRow(withPendingEdit(t),!pending,true,pending));
    });
  });
  if(!allRows.length) l.appendChild(el('div','empty','<span class="empty-ico">⌕</span>No transactions match.'));
  c.appendChild(l);
  // pager (server rows only)
  if(S.tx.total>S.tx.limit){
    var pg=el('div','row-between'); pg.style.marginTop='12px';
    var prev=el('button','btn sm','← Prev'); prev.disabled=S.tx.offset<=0;
    prev.onclick=function(){S.tx.offset=Math.max(0,S.tx.offset-S.tx.limit);loadTx();};
    var next=el('button','btn sm','Next →'); next.disabled=S.tx.offset+S.tx.limit>=S.tx.total;
    next.onclick=function(){S.tx.offset+=S.tx.limit;loadTx();};
    var info=el('div','dim','Showing '+(S.tx.offset+1)+'–'+Math.min(S.tx.offset+S.tx.limit,S.tx.total));
    info.style.fontSize='12px';
    pg.appendChild(prev); pg.appendChild(info); pg.appendChild(next);
    c.appendChild(pg);
  }
}

function txRow(t,clickable,hideDate,pending){  // hideDate: the list already groups rows under date headers; pending: in-flight write (loading state)
  var type=String(t.Type||'');
  var isXfer=type==='Transfer'||(t.ToAccount&&String(t.ToAccount).trim());
  var icCls=isXfer?'xfer':(type==='Expense'?'out':(type==='Income'?'in':''));
  var icCh=isXfer?'⇄':(type==='Expense'?'−':(type==='Income'?'+':'•'));
  var amtPhp=t['Amount (PHP)'];
  var cur=t.Currency||'PHP';
  var isForeign=cur!=='PHP';
  // Foreign-currency tx: show the NATIVE amount in its own symbol; keep the PHP
  // equivalent in the meta line so nothing is lost.
  var mainAmt=isForeign?moneyCur(Math.abs(Number(t.Amount)),cur):money(amtPhp);
  var sign=type==='Expense'?'-':(type==='Income'?'+':'');
  var amtCls=type==='Expense'?'neg':(type==='Income'?'pos':'');
  var fromC=acctColor(t.Account), toC=acctColor(t.ToAccount);
  // Description is optional: with none, the Category headlines the row and drops out
  // of the sub line rather than printing twice under a "(no description)" placeholder.
  var noDesc=!t.Description;
  var sub=dotHTML(fromC)+esc(t.Account||'')+(isXfer?(' → '+dotHTML(toC)+esc(t.ToAccount||'')):'')+(noDesc?'':' · '+esc(t.Category||''));
  var date=fmtDate(t.Date);
  var r=el('div','litem'+(clickable?' click':'')+(pending?' pending':''));
  // a pending row swaps its type glyph for a spinner so it clearly reads as "loading"
  var ic=pending?'<div class="ic"><span class="mini-spin"></span></div>':'<div class="ic '+icCls+'">'+icCh+'</div>';
  r.innerHTML=ic+
    '<div class="grow"><div class="t1">'+esc(noDesc?(t.Category||''):t.Description)+'</div>'+
    '<div class="t2">'+sub+(hideDate?'':' · '+esc(date))+'</div></div>'+
    '<div class="amt '+amtCls+'">'+sign+mainAmt+
    (isForeign?'<span class="amt-sub">'+money(amtPhp)+'</span>':'')+'</div>';
  if(fromC){ r.style.borderLeft='3px solid '+fromC; r.style.paddingLeft='9px'; }
  if(clickable) r.onclick=function(){ openTxModal(t); };
  return r;
}

// Parse a Date or "yyyy-MM-dd" string. ISO date strings are read as a LOCAL date
// (not UTC) so the day never shifts; other inputs fall back to native parsing.
function parseDate(d){
  if(d instanceof Date) return d;
  var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).trim());
  if(m) return new Date(+m[1], +m[2]-1, +m[3]);
  var dt=new Date(d); return isNaN(dt.getTime())?null:dt;
}
// Intuitive display format, e.g. "June 6, 2026".
function fmtDate(d){
  if(!d) return '';
  var dt=parseDate(d);
  if(!dt||isNaN(dt.getTime())) return String(d);
  return MONTHS_FULL[dt.getMonth()]+' '+dt.getDate()+', '+dt.getFullYear();
}

/* ════════════════════════════════════════════════════════════════════════
 *  ACCOUNTS
 * ════════════════════════════════════════════════════════════════════════ */
function renderAccounts(){
  if(!S.cache['accounts']) loading('accounts');
  return cachedCall('accounts', function(){return gs('api_getAccounts');}, function(res){
    var accs=res.accounts||[];
    var w=el('div','screen');
    w.appendChild(el('div','screen-title','Accounts'));

    var assets=0,liab=0;
    accs.forEach(function(a){ if(a.isLiability)liab+=(a.balancePhp||0); else assets+=(a.netWorthPhp||0); });
    var top=el('div','grid grid-2');
    top.appendChild(tile('Total assets', money(assets,true), accs.length+' accounts tracked'));
    top.appendChild(tile('Total liabilities', money(liab,true), 'owed across credit lines'));
    w.appendChild(top);

    // group by type
    var groups={};
    accs.forEach(function(a){var t=a.type||'Other';(groups[t]=groups[t]||[]).push(a);});
    Object.keys(groups).sort().forEach(function(t){
      var card=el('div','card');
      var sum=0; groups[t].forEach(function(a){ sum+=(a.balancePhp||0); });
      var h=el('div','row-between'); h.style.marginBottom='12px';
      var ttl=el('div','card-h',esc(t)+' <span style="opacity:.55">· '+groups[t].length+'</span>'); ttl.style.margin='0'; h.appendChild(ttl);
      h.appendChild(el('div','dim mono',money(sum)));
      card.appendChild(h);
      var l=el('div','list');
      groups[t].forEach(function(a){ l.appendChild(accountRow(a)); });
      card.appendChild(l); w.appendChild(card);
    });
    paint(w);
  }).catch(showErr);
}

/* Native amount is the headline (shares qty / USD), PHP equivalent underneath —
   same main/amt-sub shape as the foreign-currency transaction rows. */
function acctMain(a){
  if(a.isShares) return num(a.balanceNative)+' shares';
  if(a.currency&&a.currency!=='PHP') return moneyCur(a.balanceNative,a.currency);
  return money(a.balancePhp);
}
function acctAmtHtml(a){
  var foreign=a.isShares||(a.currency&&a.currency!=='PHP');
  return '<div class="amt '+(a.isLiability?'neg':'')+'">'+acctMain(a)+
    (foreign?'<span class="amt-sub">'+money(a.balancePhp)+'</span>':'')+'</div>';
}

function accountRow(a){
  var r=el('div','litem click');
  var meta=esc(a.subtype||'');
  var credit = a.creditLimit?(' · '+money(a.availableCredit)+' avail'):'';
  r.innerHTML='<div class="ic">'+(a.isShares?'▲':(a.isLiability?'▼':'■'))+'</div>'+
    '<div class="grow"><div class="t1">'+esc(a.name)+'</div><div class="t2">'+meta+credit+'</div></div>'+
    acctAmtHtml(a);
  if(a.color && /^#[0-9a-fA-F]{6}$/.test(a.color)){
    var ic=$('.ic',r); ic.style.color=a.color; ic.style.background=a.color+'22';
    r.style.borderLeft='3px solid '+a.color; r.style.paddingLeft='9px';
  }
  // credit utilization at a glance for credit accounts
  if(a.isLiability && a.creditLimit>0){
    var u=Math.min(100,Math.round(100*(a.balancePhp||0)/a.creditLimit));
    var b=el('div','bar thin');
    b.innerHTML='<div class="bar-fill '+(u>=90?'over':(u>=60?'warn':''))+'" style="width:'+u+'%"></div>';
    $('.grow',r).appendChild(b);
  }
  r.onclick=function(){ openAccountModal(a); };
  return r;
}

/* ════════════════════════════════════════════════════════════════════════
 *  BUDGETS
 * ════════════════════════════════════════════════════════════════════════ */
function renderBudgets(){
  var key='budgets|'+S.month;
  if(!S.cache[key]) loading('budgets');
  return cachedCall(key,
    function(){ return Promise.all([gs('api_getBudgets',{month:S.month}), gs('api_getRecurring')])
                  .then(function(arr){ return {bg:arr[0], rec:arr[1], version:arr[0].version}; }); },
    function(payload){
    var bg=payload.bg, rec=payload.rec;
    var w=el('div','screen');
    var head=el('div','screen-head');
    head.appendChild(el('div','screen-title','Budgets'));
    head.appendChild(monthPickerEl());
    w.appendChild(head);
    var now=new Date(), daysLeft=(bg.month===monthKey(now))
      ? (new Date(now.getFullYear(),now.getMonth()+1,0).getDate()-now.getDate()) : null;
    w.appendChild(el('div','screen-sub','Planning income '+money(bg.incomePhp,true)+'/mo'+
      (daysLeft!=null?(' · '+daysLeft+' day'+(daysLeft===1?'':'s')+' left'):'')));

    var pace=periodPace('Monthly',bg.month);
    if(bg.essentialsRewards){
      var er=bg.essentialsRewards;
      var card=el('div','card hero');
      card.innerHTML='<div class="card-h">Essentials + Rewards</div>'+
        '<div class="row-between"><div class="stat-value" style="font-size:26px">'+money(er.actualPhp,true)+'</div>'+
        '<div class="dim">of '+money(er.targetPhp,true)+'</div></div>';
      var m=el('div','meter '+(er.isOver?'over':((er.pctUsed||0)>=85?'warn':'')));
      m.innerHTML='<div class="meter-fill" style="width:'+Math.min(100,er.pctUsed||0)+'%"></div>';
      if(pace!=null&&pace>0.02&&pace<0.98){
        var pm=el('div','meter-pace'); pm.style.left='calc('+(pace*100)+'% - 1px)';
        pm.title=Math.round(pace*100)+'% of the month has elapsed';
        m.appendChild(pm);
      }
      card.appendChild(m);
      w.appendChild(card);
    }

    var bc=el('div','card');
    bc.appendChild(el('div','card-h','Segment targets'));
    (bg.budgets||[]).forEach(function(b){ bc.appendChild(meterRow(b, periodPace(b.period,bg.month))); });
    if(!(bg.budgets||[]).length) bc.appendChild(el('div','empty','<span class="empty-ico">◎</span>No budget rows.'));
    w.appendChild(bc);

    // recurring obligations
    var rows=(rec.rows||[]);
    if(rows.length){
      var rcard=el('div','card');
      rcard.appendChild(el('div','card-h','Recurring & installments'));
      var l=el('div','list');
      rows.forEach(function(o){
        var amt=o.Amount, ml=o['Months Left'];
        var r=el('div','litem');
        r.innerHTML='<div class="ic">⟳</div><div class="grow"><div class="t1">'+esc(o.Description||'')+'</div>'+
          '<div class="t2">'+esc(o.Group||'')+(ml!=null&&ml!==''?(' · '+esc(ml)+' mo left'):'')+'</div></div>'+
          '<div class="amt">'+(amt!=null&&amt!==''?money(amt):'—')+'</div>';
        l.appendChild(r);
      });
      rcard.appendChild(l); w.appendChild(rcard);
    }
    paint(w);
  }).catch(showErr);
}

/* ════════════════════════════════════════════════════════════════════════
 *  INVESTMENTS
 * ════════════════════════════════════════════════════════════════════════ */
function renderInvestments(){
  if(!S.cache['investments']) loading('accounts');
  return cachedCall('investments', function(){return gs('api_getInvestments');}, function(inv){
    var w=el('div','screen');
    w.appendChild(el('div','screen-title','Investments'));
    w.appendChild(el('div','screen-sub','Read-only · valued in PHP via the sheet'));

    var hero=el('div','stat hero');
    hero.innerHTML='<div class="stat-label">Portfolio value</div><div class="stat-value">'+money(inv.totalValuePhp,true)+'</div>'+
      '<div class="stat-sub">'+(inv.positions||[]).length+' positions · valued live</div>';
    w.appendChild(hero);

    var card=el('div','card');
    card.appendChild(el('div','card-h','Holdings'));
    var positions=inv.positions||[];
    // Color follows the entity: the account's own color when set, else a stable
    // slot from the validated fallback palette (assigned by name, not by rank).
    var fallback=['#3987e5','#199e70','#c98500','#9085e9','#e66767','#d55181','#d95926','#eb6834'];
    var names=positions.map(function(p){return p.name;}).sort();
    function posColor(p){ return acctColor(p.name)||fallback[names.indexOf(p.name)%fallback.length]; }
    // one stacked allocation bar (part-to-whole), 2px surface gaps between fills
    if(positions.length){
      var stack=el('div'); stack.style.cssText='display:flex;gap:2px;height:14px;margin:2px 0 16px';
      positions.forEach(function(p){
        var seg=el('div'); seg.title=p.name+' · '+pct(p.weightPct);
        seg.style.cssText='flex:'+Math.max(p.weightPct||0,.5)+';background:'+posColor(p)+';border-radius:4px;min-width:5px';
        stack.appendChild(seg);
      });
      card.appendChild(stack);
    }
    var l=el('div','list');
    positions.forEach(function(p){
      var r=el('div','litem');
      var q=p.quantity!=null?(num(p.quantity)+' · '):'';
      var pc=posColor(p);
      r.innerHTML='<div class="ic" style="color:'+pc+';background:'+pc+'22">▲</div>'+
        '<div class="grow"><div class="t1">'+esc(p.name)+'</div>'+
        '<div class="t2">'+esc(p.subtype||'')+' · '+q+pct(p.weightPct)+' of portfolio</div></div>'+
        '<div class="amt">'+money(p.valuePhp)+'</div>';
      l.appendChild(r);
    });
    if(!positions.length) l.appendChild(el('div','empty','<span class="empty-ico">◈</span>No investment positions found.'));
    card.appendChild(l); w.appendChild(card);

    // targets reference
    var tc=el('div','card');
    tc.appendChild(el('div','card-h','Strategy targets (reference)'));
    var seg=inv.segmentTargets||{}, core=inv.coreTargets||{};
    var html='<div class="dim" style="font-size:13px">Core allocation: ';
    html+=Object.keys(core).map(function(k){return esc(core[k])+' '+esc(k)+'%';}).join(' · ');
    html+='</div><div class="dim" style="font-size:13px;margin-top:6px">Segments: ';
    html+=Object.keys(seg).map(function(k){return esc(k)+' '+esc(seg[k])+'%';}).join(' · ');
    html+='</div>';
    tc.innerHTML+=html; w.appendChild(tc);

    paint(w);
  }).catch(showErr);
}

/* ════════════════════════════════════════════════════════════════════════
 *  TAX / BIR (Ledger)
 * ════════════════════════════════════════════════════════════════════════ */
function renderTax(){
  if(!S.cache['tax']) loading('table');
  return cachedCall('tax', function(){return gs('api_getLedger');}, function(res){
    var rows=(res.rows||[]).slice();
    var cols=ledgerCols(res.cols||(rows[0]?Object.keys(rows[0]).filter(function(k){return k!=='__row';}):[]));
    var derived={}; (res.derived||[]).forEach(function(h){derived[h]=true;});
    // Newest payslip first. Dates arrive as yyyy-MM-dd, so a plain string compare
    // orders them; a row whose linked tx is gone has no date and floats to the top,
    // which is where a broken link wants to be.
    var dateCol=cols.filter(isDateCol)[0];
    if(dateCol) rows.sort(function(a,b){
      var x=String(a[dateCol]==null?'':a[dateCol]), y=String(b[dateCol]==null?'':b[dateCol]);
      return x<y?1:(x>y?-1:0);
    });

    var w=el('div','screen');
    var head=el('div','screen-head');
    head.appendChild(el('div','screen-title','Tax · BIR Ledger'));
    var addBtn=el('button','btn sm primary','+ Add row');
    addBtn.onclick=function(){ openLedgerAdd(cols,derived); };
    head.appendChild(addBtn);
    w.appendChild(head);
    w.appendChild(el('div','screen-sub','8% gross-income regime tracker · tap a cell to edit ('+'ƒ'+' = formula, read-only) · '+
      // The BSP reference rate is hand-typed per payslip, so link its source here.
      // target=_blank keeps the SPA's state when you go check the rate.
      '<a class="tx-link" target="_blank" rel="noopener" href="https://www.bsp.gov.ph/statistics/external/day99_data.aspx">BSP daily PHP/USD rate ›</a>'));

    if(!cols.length){ w.appendChild(el('div','empty','Ledger is empty.')); }
    else {
      var card=el('div','card'), wrap=el('div','tbl-wrap'), t=el('table','tbl');
      var thead=el('thead'), htr=el('tr');
      cols.forEach(function(c){ htr.appendChild(el('th',null,esc(c)+(derived[c]?' <span class="faint">ƒ</span>':''))); });
      htr.appendChild(el('th')); // delete column
      thead.appendChild(htr); t.appendChild(thead);

      var tb=el('tbody'), ctx={cols:cols, derived:derived, txIdCol:res.txIdCol};
      rows.forEach(function(r){ tb.appendChild(ledgerRowTr(r, ctx)); });
      t.appendChild(tb); wrap.appendChild(t); card.appendChild(wrap); w.appendChild(card);
    }
    if(res.unlinked&&res.unlinked.length) w.appendChild(unlinkedSalaryCard(res.unlinked,res.txIdCol));
    paint(w);
  }).catch(showErr);
}

/* Salary transactions no ledger row references yet. Adding one writes ONLY the link
 * column — every figure on the row is a sheet formula off that ID, so there is
 * nothing else to type but the BSP rate. */
function unlinkedSalaryCard(list, txIdCol){
  var card=el('div','card');
  card.appendChild(el('div','card-h','Salary not in the ledger ('+list.length+')'));
  var l=el('div','list');
  list.forEach(function(t){
    var r=el('div','litem');
    r.innerHTML='<div class="grow"><div class="t1">'+esc(t.Description||'Salary')+'</div>'+
                '<div class="t2">'+esc(fmtDate(t.Date))+' · '+esc(t.Account||'')+'</div></div>'+
                '<div class="amt">'+esc(moneyCur(t.Amount,t.Currency))+'</div>';
    var add=el('button','btn sm primary','+ Add');
    add.onclick=function(){
      add.disabled=true; add.textContent='Adding…';
      var obj={}; obj[txIdCol]=t.ID;
      gs('api_appendLedgerRow',obj).then(function(){
        toast('Added to ledger','ok'); dropCache(); renderTax();
      }).catch(function(e){ add.disabled=false; add.textContent='+ Add'; toast(e.message||e,'err'); });
    };
    r.appendChild(add); l.appendChild(r);
  });
  card.appendChild(l);
  return card;
}

/* Reading order for the Tax table — the sheet's own column order is the owner's
 * business, so this only reorders the display. Anything not listed (a hand-added
 * Ledger column) keeps its sheet position, after these. */
var LEDGER_COL_ORDER=['Date Received','Reporting Period','Filed?','Wise Amount',
                      'BSP Reference Rate','Total Income','8% Tax','Transaction ID'];
function ledgerCols(cols){
  var rank=function(c){ var i=LEDGER_COL_ORDER.indexOf(c); return i<0?LEDGER_COL_ORDER.length:i; };
  return cols.slice().sort(function(a,b){ return rank(a)-rank(b) || cols.indexOf(a)-cols.indexOf(b); });
}
function isFiledCol(c){ return /^filed/i.test(c); }
/* The current BIR quarter back to 2026-Q1 (the ledger starts there — nothing was
 * filed before), newest first. `keep` is the cell's existing value: an out-of-range
 * quarter (or a legacy TRUE) is prepended rather than silently dropped. */
var LEDGER_FIRST_YEAR=2026;
function quarterOptions(keep){
  var d=new Date(), y=d.getFullYear(), q=Math.floor(d.getMonth()/3)+1, out=[];
  while(y>=LEDGER_FIRST_YEAR){ out.push(y+'-Q'+q); if(--q===0){ q=4; y--; } }
  if(keep && out.indexOf(keep)<0) out.unshift(keep);
  return out;
}
/* Filed? picker — a dozen fixed options, so a native <select>, not the fuzzy combobox. */
function quarterSelect(val, onPick){
  var cur=(val==null?'':String(val)), s=el('select','q-select');
  var blank=el('option',null,'—'); blank.value=''; s.appendChild(blank);
  quarterOptions(cur).forEach(function(q){ var o=el('option',null,esc(q)); o.value=q; s.appendChild(o); });
  s.value=cur;
  if(onPick) s.onchange=function(){ onPick(s.value); };
  return s;
}
/* Date-ish column → native date picker in the add-row modal. su_dateStr_ already
 * hands dates back as yyyy-MM-dd, the same value <input type="date"> produces, and
 * Sheets parses that ISO string straight into a real date on setValue. */
function isDateCol(c){ return /date/i.test(c); }
/* Ledger amounts read as money (2dp); the BSP reference rate keeps its precision.
 * Display only — the inline editor still gets the raw cell value. */
function ledgerText(col,val){
  if(typeof val==='number' && !/rate/i.test(col))
    return val.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
  return val==null?'':String(val);
}
/* A Transaction ID that opens that transaction's edit modal. */
function txLinkEl(id){
  var a=el('a','tx-link',esc(id)); a.href='#'; a.title='Open transaction';
  a.onclick=function(e){ e.preventDefault(); openTxById(id); };
  return a;
}
/* One ledger <tr>. Split out of renderTax so a cell edit repaints just this row —
 * editing several cells in a row used to reload the whole screen each time.
 * ponytail: the row is rebuilt, not diffed, and rows aren't re-sorted after an
 * edit (only an empty Transaction ID can move a row; re-open the screen for that). */
function ledgerRowTr(r, ctx){
  var tr=el('tr');
  ctx.cols.forEach(function(c){
    var td=el('td'), val=r[c];
    // The link column opens the transaction instead of editing the ID; an empty
    // one stays editable so a legacy row can still be linked by hand.
    if(c===ctx.txIdCol && val!=null && val!==''){ td.appendChild(txLinkEl(String(val))); }
    else if(ctx.derived[c]){ td.className='dim'; td.textContent=ledgerText(c,val); }
    else if(isFiledCol(c)){
      td.appendChild(quarterSelect(val, function(v){ ledgerSaveCell(tr, r, ctx, c, v); }));
    }
    else {
      td.className='ed-cell'; td.title='Tap to edit'; td.textContent=ledgerText(c,val);
      td.onclick=function(){ ledgerCellEdit(td, tr, r, ctx, c); };
    }
    tr.appendChild(td);
  });
  var dtd=el('td'), del=el('button','icon-btn','✕'); del.title='Delete row';
  del.onclick=function(){ ledgerDeleteRow(r.__row); };
  dtd.appendChild(del); tr.appendChild(dtd);
  return tr;
}
function ledgerReplaceRow(tr, r, ctx){ tr.parentNode.replaceChild(ledgerRowTr(r,ctx), tr); }

/* Save a single cell, then swap in the row the write handler hands back (its
 * derived cells have already recalculated). Mutating `r` in place keeps the
 * cached rows array in step, so no cache wipe and no screen reload. */
function ledgerSaveCell(tr, r, ctx, header, value){
  return gs('api_updateLedgerCell',{row:r.__row, header:header, value:value}).then(function(res){
    var fresh=res.values;
    if(fresh) Object.keys(fresh).forEach(function(k){ r[k]=fresh[k]; });
    toast('Saved','ok'); ledgerReplaceRow(tr, r, ctx);
  }).catch(function(e){ toast(e.message||e,'err'); ledgerReplaceRow(tr, r, ctx); });
}

/* Inline cell editor: swap the <td> for a text input that fills the cell (the
 * .editing class drops the td padding so the row doesn't jump on edit). */
function ledgerCellEdit(td, tr, r, ctx, header){
  var curVal=r[header];
  var input=el('input','ledger-edit-input'); input.type='text';
  if(curVal!=null) input.value=String(curVal);
  td.classList.add('editing'); td.textContent=''; td.appendChild(input); input.focus(); input.select();
  var done=false;
  function commit(){
    if(done) return; done=true;
    var v=input.value;
    if(v===String(curVal==null?'':curVal)){ ledgerReplaceRow(tr,r,ctx); return; }   // no-op → restore
    ledgerSaveCell(tr, r, ctx, header, v);
  }
  input.onblur=commit;
  input.onkeydown=function(e){
    if(e.key==='Enter'){ e.preventDefault(); commit(); }
    else if(e.key==='Escape'){ done=true; ledgerReplaceRow(tr,r,ctx); }
  };
}

function openLedgerAdd(cols, derived){
  var inputs={}, body=el('div');
  cols.forEach(function(c){
    if(derived[c]) return;                 // formula columns fill themselves
    var inp=isFiledCol(c)?quarterSelect(''):inputEl(isDateCol(c)?'date':'text','');
    inputs[c]=inp;                         // a <select> reads through .value like an input
    body.appendChild(fieldEl(c, inp));
  });
  var save=el('button','btn primary','Add row');
  save.onclick=function(){
    var obj={}, any=false;
    Object.keys(inputs).forEach(function(c){
      var v=inputs[c].value; if(v!==''){ obj[c]=v; any=true; }
    });
    if(!any){ toast('Fill at least one field','err'); return; }
    save.disabled=true; save.textContent='Adding…';
    gs('api_appendLedgerRow',obj).then(function(){
      closeModal(); toast('Row added','ok'); dropCache(); renderTax();
    }).catch(function(e){ save.disabled=false; save.textContent='Add row'; toast(e.message||e,'err'); });
  };
  openModal(modalShell('Add ledger row', body, [save]));
}

function ledgerDeleteRow(row){
  var yes=el('button','btn danger','Delete');
  yes.onclick=function(){
    yes.disabled=true; yes.textContent='Deleting…';
    gs('api_deleteLedgerRow',{row:row}).then(function(){
      closeModal(); toast('Row deleted','ok'); dropCache(); renderTax();
    }).catch(function(e){ yes.disabled=false; yes.textContent='Delete'; toast(e.message||e,'err'); });
  };
  var no=el('button','btn','Cancel'); no.onclick=closeModal;
  openModal(modalShell('Delete this ledger row?', el('div','dim','This permanently removes the row from the Ledger sheet.'), [no,yes]));
}

/* ════════════════════════════════════════════════════════════════════════
 *  EXCHANGE — fair USD↔PHP swap with the other person. Both of you would
 *  otherwise pay a Wise fee — you cashing out USD→PHP, they buying USD with
 *  PHP→USD — and the two routes carry DIFFERENT fees, so we take each as the
 *  actual amount Wise quotes (your fee in USD, theirs in PHP). Wise deducts its
 *  fee from the SOURCE, then converts the remainder at mid-market, so your floor
 *  = (usd − feeYou)×mid and their ceiling = mid + feeBro (the `bro`/`Bro` names
 *  are historical — they mean "the other person"). Trading direct avoids both fees;
 *  the slider splits that pot. At the mid-market rate each of you simply keeps
 *  your own avoided fee (only the 50/50 point when the two fees are equal).
 *  Defaults reproduce a sample Wise quote ($3.68 out, ₱154.83 in; tunable).
 * ════════════════════════════════════════════════════════════════════════ */
function renderExchange(){
  if(needBoot('table', renderExchange)) return;
  var w=el('div','screen');
  w.appendChild(el('div','screen-title','Swap · Fair USD↔PHP'));
  w.appendChild(el('div','screen-sub','Skip Wise fees, split the savings with the other person'));

  var rate0 = (S.boot.fxUsdPhp!=null && S.boot.fxUsdPhp>0) ? Number(S.boot.fxUsdPhp).toFixed(4) : '';
  var card=el('div','card');
  card.innerHTML=
    '<div class="field-row">'+
      '<div class="field"><label>Dollars I\'m giving ($)</label><input id="exAmt" type="number" min="0" step="any" value="1000"></div>'+
      '<div class="field"><label>Mid-market rate (₱ per $1)</label><input id="exRate" type="number" min="0" step="any" value="'+rate0+'">'+
        '<div class="hint">Live rate, editable</div></div>'+
    '</div>'+
    '<div class="field-row">'+
      '<div class="field"><label>Your Wise fee — USD→PHP ($)</label><input id="exFeeYou" type="number" min="0" step="any" value="3.68"></div>'+
      '<div class="field"><label>Their Wise fee — PHP→USD (₱)</label><input id="exFeeBro" type="number" min="0" step="any" value="154.83"></div>'+
    '</div>'+
    '<div class="field"><label>Your share of the saved fee: <span id="exSplitLbl">50%</span></label>'+
      '<input id="exSplit" type="range" min="0" max="100" step="5" value="50" style="width:100%;accent-color:var(--accent)"></div>';
  w.appendChild(card);
  w.appendChild(el('div','',null)).id='exOut';
  paint(w);

  ['exAmt','exRate','exFeeYou','exFeeBro','exSplit'].forEach(function(id){
    $('#'+id).addEventListener('input', exCalc);
  });
  exCalc();
}

function exCalc(){
  var usd=parseFloat($('#exAmt').value)||0, rate=parseFloat($('#exRate').value)||0;
  var feeYouUsd=parseFloat($('#exFeeYou').value)||0, feeBroPhp=parseFloat($('#exFeeBro').value)||0;
  var split=parseFloat($('#exSplit').value)||0;
  $('#exSplitLbl').textContent=split+'%';
  var out=$('#exOut');
  if(!(usd>0)||!(rate>0)){ out.innerHTML='<div class="empty">Enter an amount and a rate.</div>'; return; }

  var midPhp = usd*rate;
  // Wise deducts its fee from the SOURCE, then converts the remainder at mid.
  var wiseNetPhp = midPhp - feeYouUsd*rate;           // ₱ you'd receive cashing out USD→PHP (your floor)
  var broWiseCostPhp = midPhp + feeBroPhp;            // ₱ they'd send to net the USD via PHP→USD (their ceiling)
  var potPhp = broWiseCostPhp - wiseNetPhp;           // total saved by trading direct = both avoided fees
  var dealPhp = wiseNetPhp + split/100*potPhp;        // fair deal: your `split` of the whole pot

  function stat(label,val,sub){return '<div class="stat"><div class="stat-label">'+esc(label)+
    '</div><div class="stat-value">'+val+'</div>'+(sub?'<div class="stat-sub">'+sub+'</div>':'')+'</div>';}

  out.innerHTML=
    '<div class="stat hero" style="margin-bottom:14px"><div class="stat-label">They send you</div>'+
      '<div class="stat-value">'+money(dealPhp)+' <span style="font-size:14px;color:var(--text-dim)">for '+moneyCur(usd,'USD')+'</span></div>'+
      '<div class="stat-sub" style="font-size:15px;font-weight:650;color:var(--text);margin-top:8px">Fair rate ₱'+num(dealPhp/usd)+' per $1</div></div>'+
    '<div class="grid grid-2">'+
      stat('You save vs Wise', '<span class="pos">'+money(dealPhp-wiseNetPhp)+'</span>', 'your '+split+'% of '+money(potPhp)) +
      stat('They save vs Wise', '<span class="pos">'+money(broWiseCostPhp-dealPhp)+'</span>', 'their '+(100-split)+'% of '+money(potPhp)) +
    '</div>'+
    '<div class="hint" style="margin-top:10px">Any rate from '+num(wiseNetPhp/usd)+' to '+num(broWiseCostPhp/usd)+
      ' beats Wise for you both; at mid-market ('+num(rate)+') you each keep your own avoided fee.</div>';
}

/* ════════════════════════════════════════════════════════════════════════
 *  REVIEW — accounts + transactions side-by-side, multi-select bulk edit,
 *  inline single-field edit. Reuses fetchTxPage / comboEl / acctOptions.
 * ════════════════════════════════════════════════════════════════════════ */
function reviewTxKey(){ return 'revtx|'+JSON.stringify(S.review.filters||{})+'|'+S.review.offset+'|'+S.review.limit; }

function renderReview(){
  if(needBoot('list', renderReview)) return;
  if(S.review.filters.month===undefined) S.review.filters.month=S.month;

  var w=el('div','screen');
  w.appendChild(el('div','screen-title','Review'));

  // sticky bulk-action bar (hidden until a selection exists)
  var bar=el('div','bulk-bar'); bar.id='bulkBar'; bar.hidden=true;
  w.appendChild(bar);

  // right-pane filters
  var f=el('div','filters');
  var fMonth=comboEl([{value:'(all months)',label:'(all months)'}].concat(monthOptions()), S.review.filters.month||'(all months)');
  var cats=Object.keys((S.boot.categories)||{}).sort();
  var fCat=comboEl(['(all categories)'].concat(cats), S.review.filters.category||'(all categories)');
  var fSearch=el('input','search'); fSearch.placeholder='Search…'; fSearch.value=S.review.filters.search||'';
  [fMonth,fCat].forEach(function(s){s.onchange=applyRevFilters;});
  var st; fSearch.oninput=function(){clearTimeout(st);st=setTimeout(applyRevFilters,350);};
  f.appendChild(fSearch); f.appendChild(fMonth); f.appendChild(fCat);
  w.appendChild(f);

  function applyRevFilters(){
    S.review.filters.month=fMonth.value.indexOf('(all')===0?'':fMonth.value;
    S.review.filters.category=fCat.value.indexOf('(all')===0?'':fCat.value;
    S.review.filters.search=fSearch.value.trim();
    S.review.offset=0; loadReviewTx();
  }

  var split=el('div','review-split');
  var left=el('div','rev-accts card'); left.id='revAccts';
  left.innerHTML=skRows(6);
  var right=el('div','rev-tx card'); right.id='revTxCard';
  right.innerHTML=skRows(7);
  split.appendChild(left); split.appendChild(right);
  w.appendChild(split);
  paint(w);

  loadReviewAccts();
  loadReviewTx();
  updateBulkBar();
}

function loadReviewAccts(){
  return cachedCall('accounts', function(){return gs('api_getAccounts');}, function(res){
    var host=$('#revAccts'); if(!host) return;
    host.innerHTML='';
    host.appendChild(el('div','card-h','Accounts'));
    var all=el('div','litem click rail'+(!S.review.filters.account?' sel':''));
    all.innerHTML='<div class="grow"><div class="t1">All accounts</div></div>';
    all.onclick=function(){ S.review.filters.account=''; S.review.offset=0; loadReviewAccts(); loadReviewTx(); };
    host.appendChild(all);
    var groups={};
    (res.accounts||[]).forEach(function(a){var t=a.type||'Other';(groups[t]=groups[t]||[]).push(a);});
    Object.keys(groups).sort().forEach(function(t){
      host.appendChild(el('div','rail-grp',esc(t)));
      groups[t].forEach(function(a){ host.appendChild(reviewAcctRow(a)); });
    });
  }).catch(showErr);
}

function reviewAcctRow(a){
  var sel=S.review.filters.account===a.name;
  var r=el('div','litem click rail'+(sel?' sel':''));
  r.innerHTML='<div class="ic">'+(a.isShares?'▲':(a.isLiability?'▼':'■'))+'</div>'+
    '<div class="grow"><div class="t1">'+esc(a.name)+'</div></div>'+
    acctAmtHtml(a);
  if(a.color && /^#[0-9a-fA-F]{6}$/.test(a.color)){
    var ic=$('.ic',r); ic.style.color=a.color; ic.style.background=a.color+'22';
    r.style.borderLeft='3px solid '+a.color; r.style.paddingLeft='9px';
  }
  r.onclick=function(){ S.review.filters.account=a.name; S.review.offset=0; loadReviewAccts(); loadReviewTx(); };
  return r;
}

function loadReviewTx(silent){
  var st={filters:S.review.filters, offset:S.review.offset, limit:S.review.limit};
  var key=reviewTxKey();
  var card=$('#revTxCard'); if(card && !silent && !S.cache[key]) card.innerHTML=skRows(7);
  return cachedCall(key, function(){return fetchTxPage(st);}, function(res){
    S.review.total=res.total; S.review.rows=res.transactions;
    renderReviewList();
  }).catch(showErr);
}

// A pending create only belongs on this list if the rail/filters would have returned
// it — otherwise adding to one account would flash a row under another. Mirrors the
// server-side filter in api_listTransactions.
function matchesReviewFilters(t){
  var f=S.review.filters||{}, d=parseDate(t.Date);
  if(f.account && t.Account!==f.account && t.ToAccount!==f.account) return false;
  if(f.category && t.Category!==f.category) return false;
  if(f.month && (t.Period||(d?monthKey(d):''))!==f.month) return false;
  if(f.search && ((t.Description||'')+' '+(t.Category||'')).toLowerCase()
                   .indexOf(f.search.toLowerCase())<0) return false;
  return true;
}

// Repaint the Review list from S.review.rows plus the same optimistic state the
// Transactions screen uses — no server round-trip, so selection and filter DOM stay put.
function renderReviewList(){
  var c=$('#revTxCard'); if(!c) return;
  var rows=S.review.rows||[];
  var adds=(S.review.offset<=0)?(S.tx.pendingAdds||[]).filter(matchesReviewFilters):[];
  var total=(S.review.total||0)+adds.length;
  c.innerHTML='';
  var head=el('div','row-between'); head.style.marginBottom='6px';
  var lbl=el('label','sel-all');
  var selAll=el('input'); selAll.type='checkbox';
  selAll.checked=rows.length>0 && rows.every(function(t){return S.review.sel[t.ID];});
  selAll.onclick=function(){
    rows.forEach(function(t){ if(selAll.checked)S.review.sel[t.ID]=true; else delete S.review.sel[t.ID]; });
    renderReviewList();
  };
  lbl.appendChild(selAll);
  lbl.appendChild(document.createTextNode(' '+total+' transaction'+(total===1?'':'s')));
  head.appendChild(lbl); c.appendChild(head);

  var l=el('div','list');
  groupByDay(adds.concat(rows)).forEach(function(g){
    l.appendChild(dayHeadEl(g));
    g.rows.forEach(function(t){ l.appendChild(reviewTxRow(withPendingEdit(t), isPendingRow(t))); });
  });
  if(!adds.length && !rows.length) l.appendChild(el('div','empty','<span class="empty-ico">⌕</span>No transactions match.'));
  c.appendChild(l);

  if(S.review.total>S.review.limit){
    var pg=el('div','row-between'); pg.style.marginTop='12px';
    var prev=el('button','btn sm','← Prev'); prev.disabled=S.review.offset<=0;
    prev.onclick=function(){S.review.offset=Math.max(0,S.review.offset-S.review.limit);loadReviewTx();};
    var next=el('button','btn sm','Next →'); next.disabled=S.review.offset+S.review.limit>=S.review.total;
    next.onclick=function(){S.review.offset+=S.review.limit;loadReviewTx();};
    var info=el('div','dim','Showing '+(S.review.offset+1)+'–'+Math.min(S.review.offset+S.review.limit,S.review.total));
    info.style.fontSize='12px';
    pg.appendChild(prev); pg.appendChild(info); pg.appendChild(next);
    c.appendChild(pg);
  }
  updateBulkBar();
}

function reviewTxRow(t,pending){
  var type=String(t.Type||'');
  var isXfer=type==='Transfer'||(t.ToAccount&&String(t.ToAccount).trim());
  var icCls=isXfer?'xfer':(type==='Expense'?'out':(type==='Income'?'in':''));
  var icCh=isXfer?'⇄':(type==='Expense'?'−':(type==='Income'?'+':'•'));
  var amtPhp=t['Amount (PHP)'], cur=t.Currency||'PHP', isForeign=cur!=='PHP';
  var mainAmt=isForeign?moneyCur(Math.abs(Number(t.Amount)),cur):money(amtPhp);
  var sign=type==='Expense'?'-':(type==='Income'?'+':'');
  var amtCls=type==='Expense'?'neg':(type==='Income'?'pos':'');
  var fromC=acctColor(t.Account);

  var r=el('div','litem rev'+(S.review.sel[t.ID]?' sel':'')+(pending?' pending':''));
  // in-flight write: nothing on the row is editable until the server has agreed
  if(pending) r.style.pointerEvents='none';
  var chk=el('input','tx-check'); chk.type='checkbox'; chk.checked=!!S.review.sel[t.ID];
  chk.onclick=function(e){ e.stopPropagation(); toggleSel(t.ID, chk.checked); r.classList.toggle('sel', chk.checked); };
  r.appendChild(chk);
  // icon = open the full modal (date / FX / transfer / delete)
  var ic=pending?el('div','ic','<span class="mini-spin"></span>'):el('div','ic ic-edit '+icCls, icCh);
  ic.title='Open details'; ic.onclick=function(e){ e.stopPropagation(); openTxModal(t); };
  r.appendChild(ic);

  var grow=el('div','grow');
  // description — inline editable
  // empty = no description; the ".t1-edit:empty" CSS supplies the "+ note" affordance
  var t1=el('div','t1 t1-edit', esc(t.Description||''));
  t1.title='Edit description';
  t1.onclick=function(){ inlineInput(t1,'text', t.Description||'', function(v){ commitInline(t,'Description',v); }); };
  grow.appendChild(t1);
  var sub=el('div','t2');
  // account — inline editable
  sub.appendChild(editableSpan(dotHTML(fromC)+esc(t.Account||'(account)'), function(host){
    inlineCombo(host, acctOptions(), t.Account, function(val){ commitInline(t,'Account',val); });
  }));
  if(isXfer){ sub.appendChild(document.createTextNode(' → '+(t.ToAccount||''))); }
  sub.appendChild(document.createTextNode(' · '));
  // category — inline editable
  sub.appendChild(editableSpan(esc(t.Category||'(category)'), function(host){
    inlineCombo(host, catsForShape(isXfer), t.Category, function(val){ commitInline(t,'Category',val); });
  }));
  // date omitted — the list groups rows under date headers
  if(isForeign) sub.appendChild(document.createTextNode(' · '+money(amtPhp)));
  grow.appendChild(sub);
  r.appendChild(grow);

  // amount — inline editable (edits the native Amount magnitude; sign derives from Type)
  var amt=el('div','amt amt-edit '+amtCls, sign+mainAmt);
  amt.title='Edit amount';
  amt.onclick=function(){ inlineInput(amt,'number', Math.abs(Number(t.Amount)), function(v){ commitInline(t,'Amount',v); }); };
  r.appendChild(amt);
  if(fromC){ r.style.borderLeft='3px solid '+fromC; r.style.paddingLeft='9px'; }
  return r;
}

/* —— inline single-field edit (Category / Account / Description / Amount) —— */
// Plain text/number input editor (Description, Amount). Commits on Enter or blur,
// cancels on Escape. The `done` guard stops the blur firing a second commit after
// Enter (which reloads the list and tears the input down).
function inlineInput(host, type, value, onPick){
  host.innerHTML=''; host.onclick=null;
  var inp=el('input','inline-edit-input'); inp.type=type||'text';
  if(type==='number') inp.step='0.01';
  if(value!=null && value!=='') inp.value=value;
  var done=false;
  function commit(){ if(done) return; done=true; onPick(inp.value); }
  inp.onkeydown=function(e){
    if(e.key==='Enter'){ e.preventDefault(); commit(); }
    else if(e.key==='Escape'){ done=true; renderReviewList(); }
  };
  inp.onblur=function(){ commit(); };
  host.appendChild(inp); inp.focus(); inp.select();
}
function editableSpan(html, onEdit){
  var s=el('span','ed'); s.innerHTML=html;
  s.onclick=function(e){ e.stopPropagation(); onEdit(s); };
  return s;
}
function inlineCombo(host, options, value, onPick){
  host.innerHTML=''; host.onclick=null;
  // .t2 clips with overflow:hidden — relax it so the dropdown can escape the row.
  var t2=host.parentNode; if(t2&&t2.classList&&t2.classList.contains('t2')){ t2.style.overflow='visible'; t2.style.whiteSpace='normal'; }
  var combo=comboEl(options, value||'', {placeholder:'…'});
  combo.classList.add('inline-edit');
  combo.onchange=function(){ if(combo.value) onPick(combo.value); };
  host.appendChild(combo);
  var inp=combo.querySelector('.combo-input'); if(inp){ inp.focus(); inp.select(); }
}
function commitInline(t, field, val){
  var patch={ID:t.ID};
  if(field==='Amount'){
    var n=parseFloat(val);
    if(isNaN(n)){ toast('Enter a valid amount','err'); renderReviewList(); return; }
    if(n===Math.abs(Number(t.Amount))){ renderReviewList(); return; }  // no-op
    patch.Amount=n;
  } else {
    var cur=(t[field]==null?'':String(t[field]));
    if(String(val)===cur){ renderReviewList(); return; }           // no-op → restore the row
    patch[field]=val;
  }
  // Optimistic: the row keeps its place showing the NEW value as loading; the reload
  // that reconciles it only runs once the server has agreed.
  S.tx.pendingEdits[t.ID]=patch; renderReviewList();
  gs('api_updateTransaction', patch).then(function(){
    delete S.tx.pendingEdits[t.ID]; toast(field+' updated','ok'); afterReviewMutation();
  }).catch(function(e){
    delete S.tx.pendingEdits[t.ID]; toast(e.message||e,'err'); renderReviewList();
  });
}

/* —— selection + bulk bar —— */
function toggleSel(id,on){ if(on) S.review.sel[id]=true; else delete S.review.sel[id]; updateBulkBar(); }
function selCount(){ return Object.keys(S.review.sel).length; }
function bulkSelectedIds(){ return Object.keys(S.review.sel); }
function clearSel(){ S.review.sel={}; }

function updateBulkBar(){
  var bar=$('#bulkBar'); if(!bar) return;
  var n=selCount();
  if(!n){ bar.hidden=true; bar.innerHTML=''; return; }
  bar.hidden=false; bar.innerHTML='';
  bar.appendChild(el('span','bulk-count',n+' selected'));
  function add(label,cls,fn){ var b=el('button','btn sm '+(cls||''),label); b.onclick=fn; bar.appendChild(b); }
  add('Recategorize','',openBulkRecat);
  add('Reassign','',openBulkReassign);
  add('Set date','',openBulkDate);
  add('Delete','danger',openBulkDelete);
  add('Clear','ghost',function(){ clearSel(); renderReviewList(); });
}

function afterReviewMutation(){
  dropCache();                   // version bumped server-side → drop stale payloads
  loadReviewAccts(); loadReviewTx(true);   // silent: no skeleton flash over a live list
}

function bulkApply(patch){
  var ids=bulkSelectedIds(); if(!ids.length) return;
  // Optimistic: every picked row shows the patched value as loading straight away.
  ids.forEach(function(id){ S.tx.pendingEdits[id]=patch; });
  closeModal(); clearSel(); renderReviewList();
  function done(){ ids.forEach(function(id){ delete S.tx.pendingEdits[id]; }); }
  gs('api_bulkUpdateTransactions',{ids:ids, patch:patch}).then(function(res){
    done();
    toast('Updated '+res.updated+((res.skipped&&res.skipped.length)?(' · '+res.skipped.length+' skipped'):''),'ok');
    afterReviewMutation();
  }).catch(function(e){ done(); toast(e.message||e,'err'); renderReviewList(); });
}
function openBulkRecat(){
  withBoot(function(){
    var picked=(S.review.rows||[]).filter(function(t){return S.review.sel[t.ID];});
    var anyXfer=picked.some(txIsXfer), anyReg=picked.some(function(t){return !txIsXfer(t);});
    if(anyXfer&&anyReg){ // a single category can't be valid for both shapes
      openModal(modalShell('Recategorize '+selCount()+' transactions',
        el('div','dim','Selection mixes transfers and regular transactions — recategorize them separately so a Transfer category never lands on a regular row (or vice versa).'),
        []));
      return;
    }
    var c=comboEl(catsForShape(anyXfer),'',{placeholder:'Select category'});
    var save=el('button','btn primary','Apply to '+selCount());
    save.onclick=function(){ if(!c.value){toast('Pick a category','err');return;} bulkApply({Category:c.value}); };
    openModal(modalShell('Recategorize '+selCount()+' transactions', fieldEl('New category',c), [save]));
  });
}
function openBulkReassign(){
  withBoot(function(){
    var c=comboEl(acctOptions(),'',{placeholder:'Select account'});
    var save=el('button','btn primary','Apply to '+selCount());
    save.onclick=function(){ if(!c.value){toast('Pick an account','err');return;} bulkApply({Account:c.value}); };
    openModal(modalShell('Reassign '+selCount()+' transactions', fieldEl('New account',c), [save]));
  });
}
function openBulkDate(){
  var d=inputEl('date', isoDate(new Date()));
  var save=el('button','btn primary','Apply to '+selCount());
  save.onclick=function(){ if(!d.value){toast('Pick a date','err');return;} bulkApply({Date:d.value}); };
  openModal(modalShell('Set date on '+selCount()+' transactions', fieldEl('New date',d), [save]));
}
function openBulkDelete(){
  var body=el('div','dim','Delete '+selCount()+' transactions permanently? This cannot be undone.');
  var yes=el('button','btn danger','Delete '+selCount());
  yes.onclick=function(){
    // Optimistic: the rows stay on screen as loading until the backend confirms.
    var ids=bulkSelectedIds();
    ids.forEach(function(id){ S.tx.pendingDeletes[id]=true; });
    closeModal(); clearSel(); renderReviewList();
    function done(){ ids.forEach(function(id){ delete S.tx.pendingDeletes[id]; }); }
    gs('api_bulkDeleteTransactions',{ids:ids}).then(function(res){
      done(); toast('Deleted '+res.deleted,'ok'); afterReviewMutation();
    }).catch(function(e){ done(); toast(e.message||e,'err'); renderReviewList(); });
  };
  var no=el('button','btn','Cancel'); no.onclick=closeModal;
  openModal(modalShell('Confirm bulk delete', body, [no,yes]));
}

/* ════════════════════════════════════════════════════════════════════════
 *  MODALS — transaction, transfer, account
 * ════════════════════════════════════════════════════════════════════════ */
// Keep #modalRoot inside the visual viewport (not the full layout viewport) so the iOS
// keyboard doesn't cover the focused field/dropdown — a fixed, centered modal can't scroll otherwise.
function fitModal(){
  var vv=window.visualViewport, root=$('#modalRoot');
  if(!vv||!root||root.hidden) return;
  root.style.top=vv.offsetTop+'px'; root.style.height=vv.height+'px';
}
function openModal(node){
  var root=$('#modalRoot'); var card=$('#modalCard');
  closeModal.onClose=null;
  card.innerHTML=''; card.appendChild(node); root.hidden=false;
  if(window.visualViewport){ visualViewport.addEventListener('resize',fitModal); visualViewport.addEventListener('scroll',fitModal); fitModal(); }
  $('.modal-backdrop',root).onclick=closeModal;
  // Enter in a plain input submits (combos handle Enter themselves to pick an option)
  card.onkeydown=function(e){
    if(e.key==='Enter' && e.target.tagName==='INPUT' && !e.target.classList.contains('combo-input')){
      e.preventDefault();
      var p=$('.modal-f .btn.primary',card); if(p && !p.disabled) p.click();
    }
  };
}
// Escape closes the modal. An open combo dropdown eats the key before it gets here
// (comboEl's keydown stops propagation), so there's nothing to test for at this level.
document.addEventListener('keydown',function(e){
  if(e.key==='Escape' && !$('#modalRoot').hidden) closeModal();
});
function closeModal(){
  var root=$('#modalRoot'); root.hidden=true; root.style.top=''; root.style.height='';
  if(window.visualViewport){ visualViewport.removeEventListener('resize',fitModal); visualViewport.removeEventListener('scroll',fitModal); }
  // Dismiss hook — the login form needs to know it was cancelled by the backdrop or
  // Escape, not just by its own button, or unlock()'s promise never settles and every
  // later 401 awaits a dead one.
  var f=closeModal.onClose; closeModal.onClose=null; if(f) f();
}

function modalShell(title,bodyNode,footerNodes){
  var c=el('div');
  var h=el('div','modal-h'); h.innerHTML='<h3>'+esc(title)+'</h3>';
  var x=el('button','icon-btn','✕'); x.onclick=closeModal; h.appendChild(x);
  var b=el('div','modal-b'); b.appendChild(bodyNode);
  var f=el('div','modal-f'); (footerNodes||[]).forEach(function(n){f.appendChild(n);});
  c.appendChild(h); c.appendChild(b); c.appendChild(f);
  return c;
}

function fieldEl(label,inputNode,hint){
  var f=el('div','field');
  f.appendChild(el('label',null,esc(label)));
  f.appendChild(inputNode);
  if(hint) f.appendChild(el('div','hint',esc(hint)));
  return f;
}
function inputEl(type,value,ph){var i=el('input');i.type=type||'text';if(value!=null)i.value=value;if(ph)i.placeholder=ph;return i;}

/* —— reporting-period override (shared by the tx + transfer modals) ————————
 * Blank = the usual case: Month derives from Date. Setting it books the row into a
 * different month for every month-keyed report (cash flow, budgets, filters) while
 * Date keeps the real cash movement — for salary that lands a day or two early.
 */
function periodEl(t){
  return comboEl([{value:'',label:'(from date)'}].concat(monthOptions()), (t&&t.Period)||'');
}
function periodRowEl(fDate,fPeriod){
  var row=el('div','field-row');
  row.appendChild(fieldEl('Date', fDate));
  row.appendChild(fieldEl('Reports in', fPeriod, "blank = the date's own month"));
  return row;
}

/* —— fuzzy combobox (searchable replacement for <select>) ——————————————————
 * comboEl(options, value, opts) returns a wrapper element that exposes a `.value`
 * (selected option value) and `.onchange` handler — drop-in for selectEl's API.
 * Options are strings or {value,label}. Typing fuzzy-filters; ↑/↓/Enter navigate.
 */
function fuzzyScore(q,s){              // subsequence match → score (≥0), or -1 (no match)
  q=q.toLowerCase(); s=s.toLowerCase();
  if(!q) return 0;
  var si=0, score=0, streak=0;
  for(var qi=0; qi<q.length; qi++){
    var c=q[qi], found=-1;
    for(var k=si;k<s.length;k++){ if(s[k]===c){found=k;break;} }
    if(found===-1) return -1;
    streak=(found===si)?streak+1:0;
    score += 10 + streak*5 - Math.min(found-si,8);  // reward contiguous + early hits
    si=found+1;
  }
  if(s.indexOf(q)===0) score+=30; else if(s.indexOf(q)!==-1) score+=15; // prefix/substring bonus
  return score;
}
function comboEl(options,value,opts){
  opts=opts||{};
  var items=options.map(function(o){return (typeof o==='object')?{value:String(o.value),label:String(o.label),color:o.color}:{value:String(o),label:String(o)};});
  var wrap=el('div','combo');
  var input=el('input','combo-input'); input.type='text'; input.autocomplete='off'; input.spellcheck=false;
  if(opts.placeholder) input.placeholder=opts.placeholder;
  var list=el('div','combo-list'); list.hidden=true;
  wrap.appendChild(input); wrap.appendChild(list);

  var _value='', _label='', _onchange=null, active=-1, filtered=items.slice();

  function setValue(v){
    var it=items.filter(function(i){return i.value===String(v);})[0];
    _value=it?it.value:''; _label=it?it.label:''; input.value=_label;
  }
  function renderList(q){
    list.innerHTML='';
    if(!q){ filtered=items.slice(); }
    else {
      filtered=items.map(function(it){return {it:it,sc:fuzzyScore(q,it.label)};})
        .filter(function(x){return x.sc>=0;}).sort(function(a,b){return b.sc-a.sc;})
        .map(function(x){return x.it;});
    }
    active=filtered.length?0:-1;
    if(!filtered.length){ list.appendChild(el('div','combo-empty','No match')); return; }
    filtered.forEach(function(it,idx){
      var row=el('div','combo-opt'+(idx===active?' active':'')+(it.value===_value?' sel':''));
      if(isHex6(it.color)){ var dot=el('span','acct-dot'); dot.style.background=it.color; row.appendChild(dot); }
      var lab=el('span','combo-lab'); lab.textContent=it.label; row.appendChild(lab);
      row.onmousedown=function(e){ e.preventDefault(); choose(it); };
      row.onmouseenter=function(){ active=idx; highlight(); };
      list.appendChild(row);
    });
  }
  function highlight(){ Array.prototype.forEach.call(list.children,function(c,i){ c.classList.toggle('active', i===active); }); }
  function scrollActive(){ var c=list.children[active]; if(c&&c.scrollIntoView)c.scrollIntoView({block:'nearest'}); }
  function open(){ renderList(''); list.hidden=false; wrap.classList.add('open');
    // Nudge the dropdown into view so a scrollable modal/keyboard doesn't hide the options (mobile).
    setTimeout(function(){ if(!list.hidden&&list.scrollIntoView) list.scrollIntoView({block:'nearest'}); },0); }
  function close(){ list.hidden=true; wrap.classList.remove('open'); }
  function choose(it){ _value=it.value; _label=it.label; input.value=it.label; close(); if(_onchange)_onchange(); }

  input.onfocus=function(){ input.select(); open(); };
  input.oninput=function(){ renderList(input.value.trim()); list.hidden=false; };
  input.onkeydown=function(e){
    if(e.key==='ArrowDown'){ e.preventDefault(); if(list.hidden){open();} else {active=Math.min(filtered.length-1,active+1);highlight();scrollActive();} }
    else if(e.key==='ArrowUp'){ e.preventDefault(); active=Math.max(0,active-1); highlight(); scrollActive(); }
    else if(e.key==='Enter'){ if(!list.hidden&&active>=0&&filtered[active]){ e.preventDefault(); choose(filtered[active]); } }
    // Escape dismisses the dropdown only — swallow it so the document handler below
    // doesn't also close the whole modal. With the list already shut it bubbles as usual.
    else if(e.key==='Escape'){ if(!list.hidden) e.stopPropagation(); close(); input.value=_label; }
  };
  // Strict picker: on blur, snap the text back to the last valid label.
  input.onblur=function(){ setTimeout(function(){ if(input.value!==_label)input.value=_label; close(); },120); };

  Object.defineProperty(wrap,'value',{get:function(){return _value;},set:function(v){setValue(v);},configurable:true});
  Object.defineProperty(wrap,'onchange',{get:function(){return _onchange;},set:function(fn){_onchange=fn;},configurable:true});

  setValue(value==null?'':value);
  return wrap;
}

/* —— remember the last-used account/category so re-entry is a couple of taps ——
 * Most transactions reuse the same handful of accounts; pre-filling the last one
 * (and autofocusing) means a new entry is usually just category + amount. */
function prefGet(k){ try{ return localStorage.getItem('ft.'+k)||''; }catch(e){ return ''; } }
function prefSet(k,v){ try{ if(v) localStorage.setItem('ft.'+k,String(v)); }catch(e){} }
function focusCombo(c){ var i=c&&c.querySelector('.combo-input'); if(i){ i.focus(); i.select(); } }
// Amount for a form field: absolute value, blank when there's nothing usable
// (a carried-over draft may hold '' or a half-typed number).
function amtField(v){ return (v===''||v==null||isNaN(v))?'':Math.abs(v); }

/* —— transaction ⇄ transfer switcher (new rows only) ——————————————————————
 * The FAB is the only add path on most screens, so a transfer shouldn't mean a detour
 * to the Transactions screen: this swaps the modal in place, carrying the shared fields.
 * Edits are excluded — an existing row's shape is fixed. */
function typeToggleEl(mode,onSwitch){
  var seg=function(m,label){ return '<button type="button" aria-pressed="'+(m===mode)+'"'+(m===mode?' class="on"':'')+'>'+label+'</button>'; };
  var w=el('div','seg-toggle', seg('tx','Transaction')+seg('xfer','Transfer'));
  w.children[mode==='tx'?1:0].onclick=onSwitch;   // only the inactive half does anything
  return w;
}

/* Fetch one transaction by ID and open its modal — the ?tx= deep link and the
 * Tax screen's Transaction ID links both land here. */
function openTxById(id){
  return gs('api_listTransactions',{id:id,limit:1}).then(function(r){
    var t=(r.transactions||[])[0];
    if(t) openTxModal(t); else toast('That transaction no longer exists.','err');
  }).catch(function(e){ toast(e.message||e,'err'); });
}

/* —— add / edit a normal transaction —— */
function openTxModal(t){
  if(!S.boot){ withBoot(function(){ openTxModal(t); }); return; }
  var isEdit=!!(t&&t.ID);
  var isXfer = t && (String(t.Type)==='Transfer' || (t.ToAccount&&String(t.ToAccount).trim()));
  if(isXfer){ openTransferModal(t); return; }

  var cats=Object.keys(S.boot.categories||{}).filter(function(c){
    return String((S.boot.categories[c]||{}).Type)!=='Transfer';
  }).sort();
  var accs=acctOptions();
  // default account for any new tx = last one used (if it still exists); a draft carried
  // in from the transfer form may have no account yet, so this backfills that too.
  // Review's account rail is an explicit pick — it beats the last-used default.
  var wantAcc=(S.screen==='review'&&S.review.filters.account)||prefGet('lastAcct');
  var defAcc=isEdit ? '' : (accs.some(function(a){return (a.value||a)===wantAcc;})?wantAcc:'');

  var fDate=inputEl('date', t?isoDate(t.Date):isoDate(new Date()));
  var fPeriod=periodEl(t);
  var fCat=comboEl(cats, t?t.Category:'', {placeholder:'Select category'});
  var fAcc=comboEl(accs, (t&&t.Account)||defAcc, {placeholder:'Select account'});
  var fAmt=inputEl('number', t?amtField(t.Amount):'', '0.00'); fAmt.step='0.01';
  var fDesc=inputEl('text', t?t.Description:'', 'Description');
  var fFx=inputEl('number', t&&t.ExchangeRate?t.ExchangeRate:'', 'auto'); fFx.step='0.0001';
  // A stamped rate belongs to the old account's currency — reassigning to a different
  // currency makes it meaningless, so clear the field back to "auto" (issue #7).
  var origCur=t?(t.Currency||'PHP'):'PHP';
  fAcc.onchange=function(){ if(acctCurrency(fAcc.value)!==origCur) fFx.value=''; };

  var body=el('div');
  // Category is dropped on purpose: transfer categories are a disjoint set.
  if(!isEdit) body.appendChild(typeToggleEl('tx',function(){
    openTransferModal({Date:fDate.value,Period:fPeriod.value,Account:fAcc.value,Amount:fAmt.value,Description:fDesc.value,Category:''});
  }));
  body.appendChild(periodRowEl(fDate, fPeriod));
  body.appendChild(fieldEl('Category', fCat));
  body.appendChild(fieldEl('Account', fAcc));
  var rowAmt=el('div','field-row');
  rowAmt.appendChild(fieldEl('Amount', fAmt));
  rowAmt.appendChild(fieldEl('Exchange rate', fFx, 'PHP per 1 unit; blank = auto'));
  body.appendChild(rowAmt);
  body.appendChild(fieldEl('Description', fDesc));

  var save=el('button','btn primary', isEdit?'Save':'Add');
  save.onclick=function(){
    var payload={
      Date:fDate.value, Category:fCat.value, Account:fAcc.value,
      Amount:parseFloat(fAmt.value), Description:fDesc.value
    };
    if(fPeriod.value||isEdit) payload.Period=fPeriod.value; // on edit, '' clears the override
    if(fFx.value) payload.ExchangeRate=parseFloat(fFx.value);
    else if(isEdit) payload.ExchangeRate=''; // cleared field on edit → re-resolve/clear the stamp (issue #7)
    if(!payload.Category||!payload.Account||isNaN(payload.Amount)){toast('Fill category, account, amount','err');return;}
    if(isEdit){
      // Optimistic, same as a create: close now, the row shows the new values as a
      // loading row until the server confirms; on failure the modal comes back.
      var patch=Object.assign({ID:t.ID},payload);
      S.tx.pendingEdits[t.ID]=patch; prefSet('lastAcct',payload.Account);
      closeModal(); toast('Updated','ok'); repaintTxList();
      gs('api_updateTransaction', patch)
        .then(function(){ delete S.tx.pendingEdits[t.ID]; afterMutation(); })
        .catch(function(e){ delete S.tx.pendingEdits[t.ID]; repaintTxList();
          toast('Update failed — reopening: '+(e.message||e),'err'); openTxModal(Object.assign({},t,payload)); });
      return;
    }
    // New tx: optimistic — close instantly and show the row as "loading" right away
    // so you can start the next entry without waiting on the (slow) Apps Script
    // round-trip. The write runs in the background; when it lands the row becomes a
    // normal entry (afterMutation reloads in place). On failure the placeholder is
    // dropped and the modal reopens with the values intact so nothing is lost.
    prefSet('lastAcct',payload.Account); closeModal(); toast('Added','ok');
    var tmp=pushPendingAdd(payload);
    gs('api_createTransaction', payload)
      // Queued offline: the row stays exactly as it is (it's now backed by the queue,
      // and afterMutation would drop the cache we're about to need to render from).
      .then(function(r){ if(r && r.status==='queued') return; dropPendingAdd(tmp); afterMutation(); })
      .catch(function(e){ dropPendingAdd(tmp); repaintTxList(); toast('Add failed — reopening: '+(e.message||e),'err'); openTxModal(payload); });
  };
  var foot=[save];
  if(isEdit){
    var del=el('button','btn danger','Delete'); del.style.marginRight='auto';
    del.onclick=function(){ confirmDelete(t); };
    foot.unshift(del);
  }
  openModal(modalShell(isEdit?'Edit transaction':'Add transaction', body, foot));
  // Jump straight into Category so you can type/filter without a click — but only when
  // it's empty, which also skips the reopen-after-failure path (that one keeps its value).
  if(!isEdit&&!fCat.value) focusCombo(fCat);
}

/* —— transfer —— */
function openTransferModal(t){
  if(!S.boot){ withBoot(function(){ openTransferModal(t); }); return; }
  var isEdit=!!(t&&t.ID);
  var xferCats=Object.keys(S.boot.categories||{}).filter(function(c){
    return String((S.boot.categories[c]||{}).Type)==='Transfer';
  }).sort();
  var accs=acctOptions();

  var fDate=inputEl('date', t?isoDate(t.Date):isoDate(new Date()));
  var fPeriod=periodEl(t);
  var defCat=xferCats.indexOf('Transfer: Internal')>=0?'Transfer: Internal':'';
  var fCat=comboEl(xferCats.length?xferCats:['(no transfer category)'], (t&&t.Category)||defCat, {placeholder:'Select category'});
  var fFrom=comboEl(accs, t?t.Account:'', {placeholder:'From account'});
  var fTo=comboEl(accs, t?t.ToAccount:'', {placeholder:'To account'});
  var fAmt=inputEl('number', t?amtField(t.Amount):'', '0.00'); fAmt.step='0.01';
  // Prefilled only when it's a real cross-currency override — mirroring Amount back into
  // the field would re-send a stale ToAmount on an amount edit (server mirrors when blank).
  var fToAmt=inputEl('number', (t&&Number(t.ToAmount)!==Number(t.Amount))?amtField(t.ToAmount):'', 'same as amount'); fToAmt.step='0.01';
  var fDesc=inputEl('text', t?t.Description:'', 'Description');

  var body=el('div');
  if(!isEdit) body.appendChild(typeToggleEl('xfer',function(){
    openTxModal({Date:fDate.value,Period:fPeriod.value,Account:fFrom.value,Amount:fAmt.value,Description:fDesc.value,Category:''});
  }));
  body.appendChild(periodRowEl(fDate, fPeriod));
  body.appendChild(fieldEl('Category', fCat));
  var rowAcc=el('div','field-row');
  rowAcc.appendChild(fieldEl('From', fFrom));
  rowAcc.appendChild(fieldEl('To', fTo));
  body.appendChild(rowAcc);
  var rowAmt=el('div','field-row');
  rowAmt.appendChild(fieldEl('Amount', fAmt));
  rowAmt.appendChild(fieldEl('To amount', fToAmt, 'cross-currency only'));
  body.appendChild(rowAmt);
  body.appendChild(fieldEl('Description', fDesc));

  var save=el('button','btn primary', isEdit?'Save':'Add transfer');
  save.onclick=function(){
    if(fFrom.value===fTo.value){toast('From and To must differ','err');return;}
    var amount=parseFloat(fAmt.value);
    if(isNaN(amount)){toast('Enter an amount','err');return;}
    var payload={Date:fDate.value,Category:fCat.value,Account:fFrom.value,
                 ToAccount:fTo.value,Amount:amount,Description:fDesc.value};
    if(fPeriod.value||isEdit) payload.Period=fPeriod.value; // on edit, '' clears the override
    if(fToAmt.value) payload.ToAmount=parseFloat(fToAmt.value);
    if(isEdit){
      var patch=Object.assign({ID:t.ID},payload);              // optimistic — see openTxModal
      S.tx.pendingEdits[t.ID]=patch;
      closeModal(); toast('Updated','ok'); repaintTxList();
      gs('api_updateTransaction', patch)
        .then(function(){ delete S.tx.pendingEdits[t.ID]; afterMutation(); })
        .catch(function(e){ delete S.tx.pendingEdits[t.ID]; repaintTxList();
          toast('Update failed — reopening: '+(e.message||e),'err'); openTransferModal(Object.assign({},t,payload)); });
      return;
    }
    // New transfer: optimistic close + loading row (see openTxModal) — background write, reopen on failure.
    closeModal(); toast('Transfer added','ok');
    var tmp=pushPendingAdd(payload);
    gs('api_createTransfer', payload)
      .then(function(r){ if(r && r.status==='queued') return; dropPendingAdd(tmp); afterMutation(); })
      .catch(function(e){ dropPendingAdd(tmp); repaintTxList(); toast('Transfer failed — reopening: '+(e.message||e),'err'); openTransferModal(payload); });
  };
  var foot=[save];
  if(isEdit){
    var del=el('button','btn danger','Delete'); del.style.marginRight='auto';
    del.onclick=function(){ confirmDelete(t); };
    foot.unshift(del);
  }
  openModal(modalShell(isEdit?'Edit transfer':'Add transfer', body, foot));
  // Category is prefilled (default or carried over) → start at From; only focus Category if it's empty.
  if(!isEdit) focusCombo(fCat.value?fFrom:fCat);
}

function confirmDelete(t){
  var body=el('div','dim','Delete this transaction permanently? This cannot be undone.');
  var yes=el('button','btn danger','Delete');
  yes.onclick=function(){
    // Optimistic: close instantly and show the row as "loading". It's removed from
    // the list only once the backend confirms; on failure it reverts to a normal row.
    S.tx.pendingDeletes[t.ID]=true;
    closeModal();
    repaintTxList();
    gs('api_deleteTransaction',{ID:t.ID}).then(function(){
      delete S.tx.pendingDeletes[t.ID]; toast('Deleted','ok'); afterMutation();
    }).catch(function(e){
      delete S.tx.pendingDeletes[t.ID]; toast(e.message||e,'err');
      if(S.screen==='transactions'||S.screen==='review') repaintTxList(); else render();
    });
  };
  var no=el('button','btn','Cancel'); no.onclick=function(){ openTxModal(t); };
  openModal(modalShell('Confirm delete', body, [no,yes]));
}

/* —— edit account —— */
function openAccountModal(a){
  var body=el('div');
  var info=el('div','card'); info.style.marginBottom='14px';
  info.innerHTML='<div class="row-between"><span class="dim">Balance</span><strong>'+acctMain(a)+
      (acctMain(a)!==money(a.balancePhp)?' <span class="dim">('+money(a.balancePhp)+')</span>':'')+'</strong></div>'+
    '<div class="row-between"><span class="dim">Type</span><span>'+esc(a.type||'—')+' · '+esc(a.subtype||'—')+'</span></div>'+
    (a.currency?'<div class="row-between"><span class="dim">Currency</span><span>'+esc(a.currency)+'</span></div>':'');
  body.appendChild(info);

  var fFreq=comboEl(['','Daily','Weekly','Monthly','Quarterly','Annually','None'], a.interestFrequency||'', {placeholder:'— none —'});
  var fRate=inputEl('number', a.interestRate!=null?a.interestRate:'', 'e.g. 0.04'); fRate.step='0.0001';
  var fLimit=inputEl('number', a.creditLimit!=null?a.creditLimit:'', ''); fLimit.step='0.01';
  var fNotes=el('textarea'); fNotes.rows=2; fNotes.value=a.notes||'';

  // ── color picker ──
  var colorSet = !!(a.color && /^#[0-9a-fA-F]{6}$/i.test(a.color));
  var fColor=el('input'); fColor.type='color'; fColor.value=colorSet?a.color:'#5b8cff';
  fColor.oninput=function(){ colorSet=true; paintSwatches(); };
  var swatchRow=el('div','swatches');
  ['#5b8cff','#3ecf8e','#ff6b6b','#ffb454','#a78bfa','#f472b6','#22d3ee','#e7eaf0'].forEach(function(c){
    var s=el('button','swatch'); s.type='button'; s.style.background=c; s.title=c; s.dataset.hex=c;
    s.onclick=function(){ fColor.value=c; colorSet=true; paintSwatches(); };
    swatchRow.appendChild(s);
  });
  var noneBtn=el('button','swatch none','✕'); noneBtn.type='button'; noneBtn.title='No color';
  noneBtn.onclick=function(){ colorSet=false; paintSwatches(); };
  swatchRow.appendChild(noneBtn);
  function paintSwatches(){
    Array.prototype.forEach.call(swatchRow.children,function(s){
      var isNone=s.classList.contains('none');
      var on=isNone?!colorSet:(colorSet&&(s.dataset.hex||'').toLowerCase()===fColor.value.toLowerCase());
      s.classList.toggle('on', on);
    });
    fColor.style.opacity=colorSet?'1':'.45';
  }
  var colorRow=el('div','color-row'); colorRow.appendChild(fColor); colorRow.appendChild(swatchRow);

  var rowI=el('div','field-row');
  rowI.appendChild(fieldEl('Interest freq.', fFreq));
  rowI.appendChild(fieldEl('Interest rate', fRate));
  body.appendChild(rowI);
  if(a.isLiability||a.creditLimit!=null) body.appendChild(fieldEl('Credit limit', fLimit));
  body.appendChild(fieldEl('Color', colorRow));
  body.appendChild(fieldEl('Notes', fNotes));
  paintSwatches();

  var save=el('button','btn primary','Save');
  save.onclick=function(){
    var payload={Name:a.name};
    if(fFreq.value!==(a.interestFrequency||'')) payload['Interest Frequency']=fFreq.value;
    // Mirror Notes: send whenever the field changed, with '' meaning "clear the cell"
    // (server setValue('') empties it) — otherwise a rate/limit could never be removed.
    var curRate=a.interestRate!=null?String(a.interestRate):'';
    if(fRate.value!==curRate) payload['Interest Rate']=fRate.value===''?'':parseFloat(fRate.value);
    var curLimit=a.creditLimit!=null?String(a.creditLimit):'';
    if(fLimit.value!==curLimit) payload['Credit Limit']=fLimit.value===''?'':parseFloat(fLimit.value);
    if(fNotes.value!==(a.notes||'')) payload['Notes']=fNotes.value;
    var newColor = colorSet ? fColor.value : '';
    if(newColor !== (a.color||'')) payload['Color']=newColor;
    if(Object.keys(payload).length===1){toast('No changes','err');return;}
    save.disabled=true; save.textContent='Saving…';
    gs('api_updateAccount',payload).then(function(){
      closeModal(); toast('Account updated','ok'); dropCache(); renderAccounts();
    }).catch(function(e){ save.disabled=false; save.textContent='Save'; toast(e.message||e,'err'); });
  };
  openModal(modalShell(a.name, body, [save]));
}

/* ── shared ──────────────────────────────────────────────────────────────── */
function isoDate(d){
  if(!d) return '';
  var dt=parseDate(d);
  if(!dt||isNaN(dt.getTime())) return '';
  var m=String(dt.getMonth()+1).padStart(2,'0'), day=String(dt.getDate()).padStart(2,'0');
  return dt.getFullYear()+'-'+m+'-'+day;
}
function afterMutation(){
  // Each screen re-fetches its own fresh balances/budgets; account & category
  // names are unchanged by a tx write, so no need to re-hydrate getBootstrap.
  dropCache();
  // On the transactions screen do a *silent* reload: the optimistic row already
  // on screen stays put until the fresh server page lands, then swaps in place
  // (no spinner flash). Other screens fully re-render.
  if(S.screen==='transactions'){ loadTx(null,true); }
  // Review is a two-pane screen with filters/selection in the DOM — a full render()
  // would rebuild it and flash skeletons on every add. Reload the panes in place.
  else if(S.screen==='review'){ loadReviewAccts(); loadReviewTx(true); }
  else render();
}

// Build a display-shaped row for an in-flight create so it can render immediately.
function optimisticTx(p){
  var cat=p.Category, catType=((S.boot&&S.boot.categories||{})[cat]||{}).Type||'';
  var acc=((S.boot&&S.boot.accounts)||[]).filter(function(x){return x.name===p.Account;})[0]||{};
  var cur=acc.currency||'PHP';
  // best-effort PHP; reconciled on reload. Manual rate wins; else auto-FX for USD
  // (the common case) so the pending row + day-net don't treat USD as PHP.
  var rate=p.ExchangeRate?p.ExchangeRate:(cur==='USD'&&S.boot&&S.boot.fxUsdPhp?S.boot.fxUsdPhp:(cur==='PHP'?1:null));
  var php=rate!=null?p.Amount*rate:p.Amount;
  return { _pending:true, _tmpId:'tmp'+Date.now()+'-'+Math.round(Math.random()*1e6),
    Date:p.Date, Period:p.Period||'', Category:cat, Account:p.Account, ToAccount:p.ToAccount||'',
    Amount:p.Amount, 'Amount (PHP)':php, Currency:cur,
    Type:p.ToAccount?'Transfer':catType, Description:p.Description, ExchangeRate:p.ExchangeRate };
}
function pushPendingAdd(p){ var o=optimisticTx(p); S.tx.pendingAdds.unshift(o); repaintTxList(); return o._tmpId; }
function dropPendingAdd(id){ S.tx.pendingAdds=S.tx.pendingAdds.filter(function(x){return x._tmpId!==id;}); }
function showErr(e){
  $('#main').innerHTML='<div class="empty">'+esc(e&&e.message?e.message:e)+
    '<br><button class="btn" style="margin-top:12px" onclick="render()">Retry</button></div>';
}
