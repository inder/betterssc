// lib/trade-alerts.js — Telegram BUY/SELL alerts (slice 3 of the trade ticker
// arc). Pure: no DOM, no state, no fetch. app.js owns the persisted dedupe
// set and the bridge; this module only decides WHAT to send and formats it.
//
// Entry contract (arc invariant 1): the caller passes ONLY comments that are
// new at ingest time — the 12s poll's new-this-poll set and the user's own
// reconciled send — never the initial load, history backfill, background
// prefetch, reaction refresh or a reload. Dedupe keys are composite
// (`<commentId>|<action>|<qualifier>|<sorted tickers>`), pre-claimed by the
// caller before the send, and persisted per ET day so a reload cannot
// re-alert a message alerted by the previous session.
//
// Delivery unit: ONE Telegram message per comment, listing every distinct
// trade in it ("sold NVDA, bought AMD" → two lines, one notification). A
// trade whose ticker came from a lowercase word (confidence "low") is sent
// WITH a visible "unconfirmed ticker" marker rather than dropped — in a
// follow-the-trades channel a missed alert costs more than a marked guess,
// and the raw body is right there to judge it.
//
// Known limits, on purpose (START review, slice 3):
//   - An EDIT never alerts: the poll is created_at-based, so a message
//     edited from "thinking about CBRS" into "bought CBRS" re-renders in the
//     strip but never re-arrives here (slice-1 item 13 asymmetry).
//   - A composer RETRY that mints a new comment id would alert the same
//     economic trade twice; invariant 5 forbids skipping own-author messages,
//     so this is documented, not guarded.
//   - The WS live-push path (off by default, protocol never decoded) does not
//     feed this module, exactly as it does not feed the mirror.
//   - The bridge drops a 429'd send; no retry.

import { parseTradeMessage, etDateKey } from "./trades.js";
import { tradeBadge } from "./trades-strip.js";
import { escapeTelegramHtml, escapedTruncate, MAX_MESSAGE_LEN } from "./telegram.js";

export const ALERT_BODY_MAX = 280;
export const UNCONFIRMED_MARKER = "⁉️ unconfirmed ticker";

const authorIdOf = (c) => {
  const a = c && c.author;
  if (a && a.id != null) return a.id;
  if (a && a.user_id != null) return a.user_id;
  if (c && c.user_id != null) return c.user_id;
  return null;
};
const authorNameOf = (c) => (c && c.author && (c.author.name || c.author.handle)) || null;

export function tradeKey(commentId, t) {
  const tickers = Array.isArray(t.tickers) ? [...t.tickers].sort() : [];
  return `${commentId}|${t.action}|${t.qualifier || ""}|${tickers.join("+")}`;
}

/**
 * Decide which alerts to send for a batch of NEW comments.
 * @returns {{ dayKey: string|null, rollover: boolean, messages: Array<{
 *   commentId, postUuid, keys: string[], trades: Array<{action, qualifier, tickers, confidence}>,
 *   authorId, authorName, raw, createdAt }> }}
 *   `rollover` is true when the ET day differs from `dayKey` — the caller
 *   must reset its persisted key set (this plan already treats it as empty).
 */
export function planTradeAlerts({ comments, now, pinnedOnly = false, pinnedIds, sentKeys, dayKey } = {}) {
  const todayKey = etDateKey(now instanceof Date ? now : new Date()); // ONE clock read, hoisted
  // A failed clock read is NOT a new day — reporting rollover there would
  // make the caller wipe the day's dedupe set and persist day:null.
  const rollover = !!todayKey && todayKey !== dayKey;
  const out = { dayKey: todayKey, rollover, messages: [] };
  if (!todayKey) return out;
  const sent = rollover ? new Set() : sentKeys instanceof Set ? sentKeys : new Set(sentKeys || []);
  const pinned = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds || []);

  for (const c of comments || []) {
    if (!c || c._pending || c._failed) continue;
    if (c.id == null || typeof c.body !== "string" || !c.body) continue;
    const createdAt = c.created_at || c.date;
    // Same ET-day bucket as the strip. A comment posted at 23:59:58 ET and
    // polled at 00:00:04 is "yesterday" and never alerts — intended, matches
    // the strip; not a bug to re-litigate during dogfood.
    if (etDateKey(createdAt) !== todayKey) continue;
    const authorId = authorIdOf(c);
    if (pinnedOnly && !(authorId != null && pinned.has(authorId))) continue;
    const trades = parseTradeMessage(c.body); // c.body ONLY — never quote text (invariant 2)
    if (!trades.length) continue;
    const seen = new Set();
    const keys = [];
    const picked = [];
    for (const t of trades) {
      const k = tradeKey(c.id, t);
      if (seen.has(k) || sent.has(k)) continue; // collapses "bought CBRS and added CBRS"
      seen.add(k);
      keys.push(k);
      picked.push({ action: t.action, qualifier: t.qualifier, tickers: t.tickers.slice(), confidence: t.confidence });
    }
    if (!picked.length) continue;
    out.messages.push({
      commentId: c.id,
      postUuid: c.post_id || null,
      keys,
      trades: picked,
      authorId,
      authorName: authorNameOf(c),
      raw: c.body,
      createdAt,
    });
  }
  return out;
}

/**
 * One Telegram message per planned comment.
 *   single trade:  "🟢 <b>BUY CBRS</b> — Za: Bought: CBRS at 12.40\n<link>"
 *   several:       "🔴 <b>SELL NVDA</b>\n🟢 <b>BUY AMD</b>\n— Za: sold NVDA, bought AMD\n<link>"
 * The emoji sits OUTSIDE the bold run so a malformed tag can't swallow it.
 * Body is entity-safe truncated via escapedTruncate (never a split &amp;).
 */
export function formatTradeAlert(message, { link } = {}) {
  const lines = (message.trades || []).map((t) => {
    // tradeBadge's label/emoji are a fixed internal catalog (BUY / SELL·closed
    // / SELL·partial / SELL) — the ONLY unescaped interpolation here, and
    // safe only while that stays true. Tickers, author and body are escaped.
    const b = tradeBadge(t.action, t.qualifier);
    const sym = escapeTelegramHtml(t.tickers.join(" "));
    return `${b.emoji} <b>${b.label} ${sym}</b>${t.confidence === "low" ? ` ${UNCONFIRMED_MARKER}` : ""}`;
  });
  const who = escapeTelegramHtml(message.authorName || "Someone");
  const body = escapedTruncate(String(message.raw || "").replace(/\s+/g, " ").trim(), ALERT_BODY_MAX);
  let text = lines.length === 1 ? `${lines[0]} — ${who}: ${body}` : `${lines.join("\n")}\n— ${who}: ${body}`;
  const linkLine = link ? `\n${escapeTelegramHtml(String(link))}` : "";
  // The body is capped, the trade lines are not (one per distinct trade), so
  // clamp the whole message under Telegram's limit while keeping the link:
  // a 400 would lose the alert for good (keys are claimed before the send).
  const budget = MAX_MESSAGE_LEN - linkLine.length;
  if (text.length > budget) {
    let cut = text.slice(0, Math.max(0, budget - 1));
    cut = cut.replace(/&[a-z#0-9]{0,8}$/i, "").replace(/<[^>]*$/, ""); // never end mid-entity / mid-tag
    text = `${cut}…`;
  }
  text += linkLine;
  return { text, parse_mode: "HTML", disable_web_page_preview: true };
}
