/**
 * telegram.js — the bot, now running in the Worker instead of Apps Script.
 *
 * Telegram already delivers to this Worker's /tg (it always did; the Worker existed
 * because Apps Script answers a POST with a 302 and Telegram rejects a redirecting
 * webhook). The only change is that /tg no longer forwards the update to GAS — it
 * handles it here. So the webhook URL does NOT change and setWebhook does NOT need
 * re-running: no GAS boot, no 302 dance, no waitUntil fire-and-forget guesswork,
 * and replies get faster.
 *
 * Everything the owner touches is unchanged: intents, receipts, the ↻ Undo and
 * ✎ Edit details buttons, ⌕ Email, /undo, /balance, one-message-many-transactions.
 * Undo state moved from the TG_LAST_IDS Script Property to meta.tg_last_ids.
 *
 * Two things that look removable and are not:
 *   * the update_id dedup (tg_seen_). Telegram redelivers until it gets a timely
 *     answer, and one Gemini round trip is slow enough to lose that race. /tg answers
 *     200 immediately and the work runs in waitUntil, but a redelivery would still
 *     start a SECOND parse and a second receipt. The claim is durable (D1 meta), not
 *     cached, because there is no CacheService here.
 *   * the glyph rule. A text variation selector does not stop Telegram emoji-fying a
 *     codepoint, so the buttons use ↻ ⌕ ✎ (outside the emoji set) and never ↩ ✉ ✏.
 *     Guarded by test.js.
 */
import { refs, metaGet, metaSet, manilaToday, parseMonthKey, monthKey } from './db.js';
import { parse, emailText } from './gemini.js';
import { createTransaction, createTransfer, deleteTransaction, listTransactions, getAccounts } from './api.js';

const API = 'https://api.telegram.org/bot';
const HELP = '✦ Just send a transaction in plain language.\n' +
             'Check balances: `how much do I have` / `how much is in maya` (or /balance)\n' +
             "Take it back: `undo` (or /undo) removes the last message's rows.";

// ── entry point (POST /tg) ───────────────────────────────────────────────────
/**
 * Never throws to the caller: a non-2xx tells Telegram to redeliver, and a message we
 * already failed to parse will fail again. Problems are reported in the chat.
 */
export async function handleUpdate(env, update) {
  try {
    if (await seen(env, update && update.update_id)) return;
    await route(env, update);
  } catch (err) {
    console.error('telegram: ' + (err && err.stack ? err.stack : err));
  }
}

/**
 * Claim an update_id, returning true if it was already claimed. Durable (D1) rather
 * than cached — there is no CacheService here, and the claim only has to outlive
 * Telegram's retry window.
 * ponytail: claimed up front, so an execution that dies mid-way is not retried either
 * — you resend the message. Better than the retry storm that not claiming produces.
 */
async function seen(env, updateId) {
  if (!updateId) return false;
  const now = Date.now();
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO seen_updates (update_id, at) VALUES (?, ?) ON CONFLICT(update_id) DO NOTHING')
      .bind(updateId, now),
    env.DB.prepare('DELETE FROM seen_updates WHERE at < ?').bind(now - 86400000)   // sweep, same trip
  ]);
  return !res.meta.changes;
}

async function route(env, update) {
  if (update && update.callback_query) return callback(env, update.callback_query);
  const msg = update && update.message;
  if (!msg || !msg.text) return;                       // ignore photos/stickers/edits
  const chat = msg.chat.id, replyTo = msg.message_id;

  if (String(msg.from && msg.from.id) !== String(env.TELEGRAM_USER_ID)) {
    return send(env, chat, '⛔ *Unauthorized. This bot is private.*');
  }

  const text = String(msg.text).trim();
  if (text.charAt(0) === '/') {
    const cmd = text.slice(1).split(/[\s@]/)[0];
    if (cmd === 'undo') return undo(env, chat, replyTo);
    if (cmd === 'balance') return balance(env, chat, null, replyTo);   // no parse needed
    return send(env, chat, HELP, replyTo);
  }

  const r = await refs(env);
  let parsed;
  try {
    parsed = await parse(env, r, text, msg.date);
  } catch (err) {
    return send(env, chat, '❌ *Failed to add transaction*\n› ' + msgOf(err), replyTo);
  }
  if (parsed.error) return send(env, chat, '❌ *Failed to add transaction*\n› ' + parsed.error, replyTo);

  if (parsed.intent === 'undo') return undo(env, chat, replyTo);
  if (parsed.intent === 'balance') return balance(env, chat, parsed.query, replyTo);
  if (parsed.intent === 'query') {
    try { return send(env, chat, await queryReply(env, parsed.query), replyTo); }
    catch (err) { return send(env, chat, '❌ *Query failed*\n› ' + msgOf(err), replyTo); }
  }

  const items = parsed.items || [];
  if (!items.length) return send(env, chat, '❌ *Failed to add transaction*\n› Nothing to log.', replyTo);
  await logItems(env, chat, 'tg-' + update.update_id, items, replyTo);
}

// ── log (one or many transactions per message) ───────────────────────────────
/**
 * Create every parsed item, reply once, and remember the IDs for undo. A failing item
 * reports itself and the rest still land — a five-line message should not be lost
 * because line three named an account that does not exist.
 *
 * `idPrefix` identifies the source and makes the row IDs idempotent under retries:
 * "tg-<update_id>" for a chat message, "gm-<messageId>" for an ingested email. Row
 * IDs are "<idPrefix>-<i>". `mailId` adds the ⌕ Email button. Returns the IDs that
 * landed — the Gmail courier only trashes the mail when every item made it.
 *
 * ponytail: one service call per item. There is no bulk create, and a message carries
 * a handful of transactions, not hundreds.
 */
export async function logItems(env, chat, idPrefix, items, replyTo, mailId) {
  const out = [], ids = [], idx = [];
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const args = {
      ID: idPrefix + '-' + i,
      Date: p.Date, Category: p.Category, Description: p.Description, Account: p.Account,
      Amount: p.Amount, ExchangeRate: p.ExchangeRate, ToAccount: p.ToAccount, ToAmount: p.ToAmount
    };
    try {
      const res = p.ToAccount ? await createTransfer(args, env) : await createTransaction(args, env);
      out.push(receipt(p, res.status));
      ids.push(args.ID); idx.push(i);
    } catch (err) {
      out.push('❌ *Failed to add transaction*\n› ' + msgOf(err));
    }
  }
  // Only the rows that actually landed, so undo cannot chase a failed item.
  if (ids.length) await metaSet(env, 'tg_last_ids', JSON.stringify(ids));
  await send(env, chat, out.join('\n\n'), replyTo, ids.length ? logKeyboard(env, idPrefix, idx, ids, mailId) : null);
  return ids;
}

// ── the Undo / Edit details buttons under a receipt ──────────────────────────
/**
 * Undo carries its own IDs in callback_data instead of reading meta.tg_last_ids, so
 * the button under an OLDER receipt still undoes that message. Only the indices that
 * landed are encoded — a failed item has no row to delete.
 */
export function undoData(idPrefix, indices) { return 'u:' + idPrefix + ':' + indices.join(','); }

/** Reverse of undoData -> transaction IDs; [] if the payload is not ours. */
export function undoIds(data) {
  const m = /^u:([A-Za-z0-9-]+):(\d+(?:,\d+)*)$/.exec(String(data || ''));
  if (!m) return [];
  // Receipts sent before the prefix carried a source ("u:90210:0") mean Telegram.
  const prefix = /^\d+$/.test(m[1]) ? 'tg-' + m[1] : m[1];
  return m[2].split(',').map((i) => prefix + '-' + i);
}

/**
 * The Worker IS the app origin now, so the "Edit details" link is just the request
 * origin — no WEBHOOK_URL-minus-/tg derivation, no WEB_APP_URL trap.
 */
export function logKeyboard(env, idPrefix, indices, ids, mailId) {
  const row = [];
  const data = undoData(idPrefix, indices);
  // Telegram caps callback_data at 64 bytes; past that, /undo still covers it.
  if (data.length <= 64) row.push({ text: '↻ Undo', callback_data: data });
  const url = env.APP_URL;
  if (url) row.push({ text: '✎ Edit details', url: url + '?screen=transactions' +
                      (ids.length === 1 ? '&tx=' + encodeURIComponent(ids[0]) : '') });
  const rows = row.length ? [row] : [];
  // Its own row: three buttons abreast get squeezed to unreadable on a phone.
  if (mailId) rows.push([{ text: '⌕ Email', callback_data: 'e:' + mailId }]);
  return rows.length ? rows : null;
}

/**
 * A button tap — "u:…" Undo, or "e:<gmail id>" ⌕ Email.
 *
 * Undo rewrites the receipt with the removal summary, which also drops the keyboard,
 * so it cannot be pressed twice against deleted rows. Email replies with the quote the
 * courier stored at ingest time and deliberately LEAVES the keyboard alone: checking
 * the source is a read, and a second look must stay possible.
 */
async function callback(env, cq) {
  const msg = cq.message || {};
  const chat = msg.chat && msg.chat.id;
  if (String(cq.from && cq.from.id) !== String(env.TELEGRAM_USER_ID)) return answer(env, cq, 'Unauthorized.');

  const mail = /^e:([0-9a-zA-Z]{1,64})$/.exec(String(cq.data || ''));
  if (mail) {
    const row = await env.DB.prepare('SELECT quote FROM email_quotes WHERE message_id = ?').bind(mail[1]).first();
    if (!row) return answer(env, cq, 'Email no longer available.');
    await send(env, chat, row.quote, msg.message_id);
    return answer(env, cq, '');
  }

  const ids = undoIds(cq.data);
  if (ids.length) await edit(env, chat, msg.message_id, (await deleteIds(env, ids)).join('\n'));
  return answer(env, cq, ids.length ? 'Removed.' : 'Nothing to undo.');
}

/** Dismiss the button's spinner (an unanswered callback spins for ~30s). */
function answer(env, cq, text) {
  return call(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
}

// ── undo (the last logged message) ───────────────────────────────────────────
async function undo(env, chat, replyTo) {
  let ids = [];
  try { ids = JSON.parse(await metaGet(env, 'tg_last_ids', '[]')); } catch (err) { ids = []; }
  if (!ids.length) return send(env, chat, '✦ *Nothing to undo.*', replyTo);
  return send(env, chat, (await deleteIds(env, ids)).join('\n'), replyTo);
}

/** Delete those rows and describe what went; shared by /undo and the Undo button. */
async function deleteIds(env, ids) {
  const out = ['↻ *Removed*'];
  for (const id of ids) {
    try {
      const t = (await deleteTransaction({ ID: id }, env)).transaction;
      out.push('› _' + t.Category + '_ ' + php(t['Amount (PHP)'] || t.Amount));
    } catch (err) {
      out.push('› ❌ ' + msgOf(err));
    }
  }
  // Cleared either way: the button and /undo point at the same rows, so whichever
  // fires first must stop the other from chasing them.
  await metaSet(env, 'tg_last_ids', '[]');
  return out;
}

// ── query / read-back ────────────────────────────────────────────────────────
async function queryReply(env, query) {
  const args = queryFilters(query);
  const res = await listTransactions(args, env);
  const label = [args.category, args.account, args.search, args.month || 'all time']
    .filter(Boolean).join(' · ');
  return '⌕ *' + label + '*\n' + querySummary(res.transactions, res.total);
}

/** Parsed query object -> listTransactions args. */
export function queryFilters(query) {
  const q = query || {};
  // ponytail: one page. 500 rows is more than any single month; paginate only if an
  // all-time query ever needs a total that big to be exact.
  const args = { limit: 500 };
  if (q.month) args.month = tgMonthKey(q.month);
  if (q.category) args.category = q.category;
  if (q.account) args.account = q.account;
  if (q.search) args.search = q.search;
  return args;
}

/** "2026-08" / "2026-Aug" -> the canonical month key. Falls back to this month. */
export function tgMonthKey(s) {
  const p = parseMonthKey(s) || parseMonthKey(manilaToday().slice(0, 7));
  return monthKey(p.y, p.m);
}

/**
 * Rows -> the reply body: total, count, and the most recent few. Amounts are summed
 * absolute (the ledger signs expenses and income differently, and a filtered query is
 * always "how much moved through this").
 */
export function querySummary(rows, total) {
  rows = rows || [];
  const n = (total === undefined) ? rows.length : total;
  if (!n) return 'No matching transactions.';
  const sum = rows.reduce((s, r) => s + Math.abs(Number(r['Amount (PHP)']) || 0), 0);
  const lines = rows.slice(0, 5).map((r) =>
    '› _' + String(r.Date).slice(0, 10) + '_ ' + r.Category +
    (r.Description ? ' — ' + r.Description : '') + ' `' + php(r['Amount (PHP)']) + '`');
  if (n > lines.length) lines.push('› _…' + (n - lines.length) + ' more_');
  return '*' + php(sum) + '* across ' + n + ' tx\n' + lines.join('\n');
}

// ── balances ─────────────────────────────────────────────────────────────────
async function balance(env, chat, query, replyTo) {
  try {
    const res = await getAccounts({}, env);
    return send(env, chat, balanceText(res.accounts, query && query.account), replyTo);
  } catch (err) {
    return send(env, chat, '❌ *Balance lookup failed*\n› ' + msgOf(err), replyTo);
  }
}

/**
 * Accounts -> the reply. Non-PHP accounts lead with their native amount and carry PHP
 * behind it, matching the web UI. The total is signed net worth: liabilities pull it down.
 */
export function balanceText(accounts, name) {
  const hits = matchAccounts(accounts || [], name);
  if (!hits.length) return '⌕ No account matching *' + name + '*.';
  const lines = hits.map((a) => {
    const ccy = String(a.currency || 'PHP').toUpperCase();
    const native = (ccy !== 'PHP' && a.balanceNative !== null && a.balanceNative !== undefined)
      ? '`' + money(a.balanceNative, ccy) + '` · ' : '';
    return '› _' + a.name + '_ ' + native + '`' + php(a.balancePhp) + '`' + (a.isLiability ? ' owed' : '');
  });
  if (hits.length > 1) {
    const total = hits.reduce((s, a) => s + (Number(a.netWorthPhp) || 0), 0);
    lines.push('*Total* `' + (total < 0 ? '-' : '') + php(total) + '`');
  }
  return '◈ *Balance' + (hits.length > 1 ? 's' : '') + '*\n' + lines.join('\n');
}

/**
 * No name -> every account. Otherwise case-insensitive substring, so a model that
 * echoes "maya" instead of the exact name still resolves (and "maya" legitimately
 * matching two accounts lists both rather than guessing).
 */
export function matchAccounts(accounts, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return accounts;
  return accounts.filter((a) => String(a.name).toLowerCase().indexOf(q) !== -1);
}

/** Absolute amount with its currency's symbol; unknown currencies (SHARES) trail the code. */
export function money(n, ccy) {
  const c = String(ccy || 'PHP').toUpperCase();
  const v = Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (c === 'PHP') return '₱' + v;
  if (c === 'USD') return '$' + v;
  return v + ' ' + c;
}
const php = (n) => money(n, 'PHP');

// ── replies ──────────────────────────────────────────────────────────────────
/** The confirmation message. `status` is "success" or "duplicate" (a retried update). */
export function receipt(p, status) {
  const lines = [status === 'duplicate' ? '✦ *Already logged*' : '✦ *Logged*',
                 '› _' + p.Date + '_', '› _' + p.Category + '_'];
  // A blank Description is normal (the Category/Account already say it) — no empty line.
  if (p.Description) lines.push('› _' + p.Description + '_');
  lines.push('› _' + p.Account + '_', '› `' + p.Amount + '`');
  if (p.ToAccount) lines.push('› To: _' + p.ToAccount + '_');
  if (p.ToAmount) lines.push('› `' + p.ToAmount + '`');
  return lines.join('\n');
}

/**
 * sendMessage. A description containing `_` or `*` makes Telegram reject the whole
 * Markdown message (400), so a rejected send is retried as plain text rather than
 * silently swallowing the only feedback the user gets.
 */
export async function send(env, chatId, text, replyTo, keyboard) {
  const p = { chat_id: chatId, text };
  if (replyTo) p.reply_to_message_id = replyTo;
  if (keyboard) p.reply_markup = { inline_keyboard: keyboard };
  return call(env, 'sendMessage', p);
}

/** Rewrite a message in place (drops its inline keyboard — no reply_markup sent). */
function edit(env, chatId, messageId, text) {
  return call(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text });
}

/** Bot API call with the Markdown -> plain retry above. */
async function call(env, method, payload) {
  const post = (p) => fetch(API + env.TELEGRAM_BOT_TOKEN + '/' + method,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  const res = await post(Object.assign({ parse_mode: 'Markdown' }, payload));
  if (!res.ok) await post(payload);       // markdown rejected -> plain text
}

/** Best-effort owner alert. Cron failures use this — the free plan does not retry them. */
export async function notifyOwner(env, text) {
  try { await send(env, env.TELEGRAM_USER_ID, text); }
  catch (err) { console.error('notifyOwner failed: ' + err); }
}

export const msgOf = (err) => (err && err.message) ? err.message : String(err);

// ── the Gmail courier's endpoint ─────────────────────────────────────────────
/**
 * POST /api?action=ingestEmail, bearer-only. The GAS courier still owns the mailbox
 * (GmailApp is free OAuth to it and has no off-platform equivalent) but no longer
 * parses or writes anything: it posts the email's fields here and trashes the mail
 * only when the response says every item landed.
 *
 * The quote is stored so the receipt's ⌕ Email button still works: the Worker cannot
 * call GmailApp, so the courier ships the same 1200-char excerpt GAS used to build on
 * demand, and the 'e:<messageId>' callback reads it out of D1.
 *
 * `intent` is ignored — an email is never a query or an undo. Only `error` decides
 * whether this was a transaction at all.
 */
export async function ingestEmail(args, env) {
  const messageId = String(args.messageId || '');
  if (!messageId) throw new Error('ingestEmail requires messageId.');
  const r = await refs(env);
  const parsed = await parse(env, r, emailText(args, args.hints), Math.floor(Date.parse(args.date) / 1000) || undefined);
  const items = parsed.error ? [] : (parsed.items || []);
  if (!items.length) return { status: 'success', logged: 0, total: 0, ids: [], skipped: parsed.error || 'no transactions' };

  if (args.quote) {
    await env.DB.prepare('INSERT INTO email_quotes (message_id, quote) VALUES (?, ?) ' +
      'ON CONFLICT(message_id) DO UPDATE SET quote = excluded.quote').bind(messageId, String(args.quote)).run();
  }
  const ids = await logItems(env, env.TELEGRAM_USER_ID, 'gm-' + messageId, items, null, args.quote ? messageId : null);
  return { status: 'success', logged: ids.length, total: items.length, ids };
}
