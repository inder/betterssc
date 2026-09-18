// lib/trades-strip.js — pure derivation for the trades strip (slice 2 of the
// trade ticker arc). No DOM, no state, no fetch. app.js renders whatever this
// returns; nothing here writes back into the comment store (arc invariant 3:
// the strip is a DERIVATION of state.comments, never a second owner of it).
//
// Inputs are read-only snapshots the caller hands in:
//   comments        iterable of comment objects from state.comments.values()
//   rootPost        state.post (the current thread's communityPost) or null
//   channelThreads  state.channelThreads ([{ communityPost, user }]) or []
//   now             Date — ONE clock reading per derive; the ET day key is
//                   computed once here, not per row
//   pinnedOnly      boolean
//   pinnedIds       Set of author ids (state.pinnedUserIds)
//   memo            Map (owned by the render layer, module-private there) —
//                   id → { body, trades }. Keyed by id AND body so the 20s
//                   reaction poll's wholesale replacement of comment objects
//                   still hits, and an edit (body changed) misses and re-parses.
//                   The ET-today filter runs BEFORE the memo, so it holds at
//                   most one day of rows (START review, slice 2, miss 11).
//
// CALLER CONTRACT (arc invariant 2): only `c.body` is parsed. A quoted parent
// is a separate `c.quote` object and is never concatenated — the test file
// pins that with a body:"nice" + quote.body:"Bought: CBRS" row.

import { parseTradeMessage, etDateKey, isTodayET } from "./trades.js";

const authorIdOf = (c) => {
  const a = c && c.author;
  if (a && a.id != null) return a.id;
  if (a && a.user_id != null) return a.user_id;
  if (c && c.user_id != null) return c.user_id;
  return null;
};
const authorNameOf = (c) => (c && c.author && (c.author.name || c.author.handle)) || null;

function tradesFor(id, body, memo) {
  if (memo) {
    const hit = memo.get(id);
    if (hit && hit.body === body) return hit.trades;
  }
  const trades = parseTradeMessage(body);
  if (memo) memo.set(id, { body, trades });
  return trades;
}

/**
 * @returns rows newest-first: { id, kind:"comment"|"root", postUuid, action,
 *   qualifier, tickers, confidence, authorId, authorName, createdAt, raw }.
 *   One row per Trade — a message with two verbs yields two rows; a trade
 *   naming two tickers is ONE row listing both.
 */
export function deriveTradeRows({ comments, rootPost, channelThreads, now, pinnedOnly = false, pinnedIds, memo } = {}) {
  const todayKey = etDateKey(now instanceof Date ? now : new Date());
  if (!todayKey) return [];
  const pinned = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds || []);
  const rows = [];
  const seenRoot = new Set();

  const push = (kind, id, postUuid, body, createdAt, authorId, authorName) => {
    if (id == null || typeof body !== "string" || !body) return;
    if (etDateKey(createdAt) !== todayKey) return; // today (ET) first — cheap, and bounds the memo
    if (pinnedOnly && !(authorId != null && pinned.has(authorId))) return;
    for (const t of tradesFor(id, body, memo)) {
      rows.push({
        id,
        kind,
        postUuid,
        action: t.action,
        qualifier: t.qualifier,
        tickers: t.tickers.slice(),
        confidence: t.confidence,
        authorId,
        authorName,
        createdAt,
        raw: body,
      });
    }
  };

  // Thread roots: the current thread's post plus the channel's page-1 roots,
  // deduped by post id. The publication author's own trades live here
  // ("Bought: CBRS …" is a root post, not a comment).
  const addRoot = (post, user) => {
    if (!post || post.id == null || seenRoot.has(post.id)) return;
    seenRoot.add(post.id);
    const u = user || post.user || post.author || null;
    const authorId = (u && u.id != null) ? u.id : (post.user_id != null ? post.user_id : null);
    push("root", post.id, post.id, post.body, post.created_at || post.date, authorId, (u && u.name) || null);
  };
  addRoot(rootPost, rootPost && (rootPost.user || rootPost.author));
  for (const t of channelThreads || []) addRoot(t && t.communityPost, t && t.user);

  for (const c of comments || []) {
    if (!c || c._pending || c._failed) continue; // optimistic/failed rows have no stable id and no DOM target
    push("comment", c.id, c.post_id || null, c.body, c.created_at || c.date, authorIdOf(c), authorNameOf(c));
  }

  rows.sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });
  return rows;
}

// "8:47 ET" — the row's time in America/New_York, matching the "today in ET"
// bucket for any viewer (a 00:30 ET trade would otherwise show as 21:30 the
// previous evening for a Pacific viewer while sitting under "Trades today").
const ET_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
export function formatTradeTimeET(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${ET_TIME_FMT.format(d).replace(/\s?[AP]M$/i, "")} ET`;
}

// Badge text + CSS modifier for a row's action/qualifier.
export function tradeBadge(action, qualifier) {
  if (action === "BUY") return { label: "BUY", cls: "buy", emoji: "🟢" };
  if (qualifier === "closed") return { label: "SELL·closed", cls: "sell-closed", emoji: "🔴" };
  if (qualifier === "partial") return { label: "SELL·partial", cls: "sell-partial", emoji: "🟠" };
  return { label: "SELL", cls: "sell", emoji: "🔴" };
}
