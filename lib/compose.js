// Composer helpers for v0.2 write side.
//
// Two responsibilities:
//   1) buildCommentBody(text, mentionsMap) — convert composer state into the
//      `{body, mentions}` payload Substack's POST /comments expects.
//   2) Pure DOM-level utility functions (autoGrow, etc.) the composer wires
//      up. Keeping them here means the test file can exercise them with
//      happy-dom and we never have to import all of app.js.
//
// Substack body shape, for reference (captured by reverse-engineering the
// native client in v0.0.4):
//
//   {
//     "id": "<client uuid>",         // used for dedup on the server side
//     "body": "${0} that's a good article. thanks for sharing.",
//     "mentions": { "0": {"user_id": 2921680, "text": "@Boz"} }
//   }
//
// `text` is the user-visible string in the composer (mentions appear inline
// as `@<name>`). `mentionsMap` is keyed by the same `@<name>` literal and
// stores the user_id. buildCommentBody rewrites mentions to `${N}` slots,
// renumbering left-to-right by first occurrence so the payload mentions map
// is dense (0, 1, 2, ...).

// Build the {body, mentions} payload from composer state.
//
//   text          — composer text (mentions show as `@name`)
//   mentionsMap   — { "@name": { user_id, text? }, ... }
//
// Returns { body, mentions } where `body` has `${N}` placeholders and
// `mentions` is { "N": { user_id, text } }. If no mentions are present (or
// the map is empty), returns { body: text, mentions: {} }.
//
// Tolerates: empty text, empty mentions map, multiple occurrences of the
// same @name, mention tokens with no surrounding text, mention map entries
// that aren't referenced in the text (those are dropped — server would
// reject them as orphan slots).
export const buildCommentBody = (text, mentionsMap) => {
  const safeText = text == null ? "" : String(text);
  if (Array.isArray(mentionsMap)) {
    const selected = mentionsMap
      .filter(
        (m) =>
          m &&
          Number.isInteger(m.start) &&
          Number.isInteger(m.end) &&
          m.start >= 0 &&
          m.end > m.start &&
          (m.user_id != null || m.userId != null) &&
          safeText.slice(m.start, m.end) === m.token
      )
      .sort((a, b) => a.start - b.start || a.end - b.end);
    if (!selected.length) return { body: safeText, mentions: {} };

    let body = "";
    let cursor = 0;
    let nextSlot = 0;
    const slotsByIdentity = new Map();
    const mentions = {};
    for (const item of selected) {
      if (item.start < cursor) continue;
      body += safeText.slice(cursor, item.start);
      const userId = item.user_id ?? item.userId;
      const displayText = item.text || item.token;
      const identityKey = String(userId) + "\u0000" + displayText;
      let slot = slotsByIdentity.get(identityKey);
      if (slot == null) {
        slot = nextSlot++;
        slotsByIdentity.set(identityKey, slot);
        mentions[String(slot)] = { user_id: userId, text: displayText };
      }
      body += "${" + slot + "}";
      cursor = item.end;
    }
    body += safeText.slice(cursor);
    return { body, mentions };
  }
  if (!mentionsMap || typeof mentionsMap !== "object") {
    return { body: safeText, mentions: {} };
  }
  const entries = Object.entries(mentionsMap).filter(
    ([k, v]) =>
      k && k.startsWith("@") && v && (v.user_id != null || v.userId != null)
  );
  if (!entries.length) {
    return { body: safeText, mentions: {} };
  }
  // Compatibility path for older snapshots/tests that still use a token-keyed
  // map. Scan once, longest token first at each position, and create slots only
  // for tokens actually replaced. This avoids prefix corruption and orphan
  // mention entries without the old uppercase-following-prose heuristic.
  const candidates = entries
    .map(([token, val]) => ({
      token,
      userId: val.user_id != null ? val.user_id : val.userId,
      displayText: val.text || token,
    }))
    .sort((a, b) => b.token.length - a.token.length);
  let body = "";
  const mentions = {};
  const slotsByToken = new Map();
  let i = 0;
  while (i < safeText.length) {
    const match = candidates.find((candidate) => {
      if (!safeText.startsWith(candidate.token, i)) return false;
      const before = i > 0 ? safeText[i - 1] : "";
      const after = safeText[i + candidate.token.length] || "";
      return (!before || !/[\p{L}\p{N}_]/u.test(before)) &&
        (!after || !/[\p{L}\p{N}_]/u.test(after));
    });
    if (!match) {
      body += safeText[i++];
      continue;
    }
    let slot = slotsByToken.get(match.token);
    if (slot == null) {
      slot = slotsByToken.size;
      slotsByToken.set(match.token, slot);
      mentions[String(slot)] = {
        user_id: match.userId,
        text: match.displayText,
      };
    }
    body += "${" + slot + "}";
    i += match.token.length;
  }
  if (!slotsByToken.size) return { body: safeText, mentions: {} };
  return { body, mentions };
};

// Auto-grow a textarea up to maxRows visible lines. Returns the new height
// in px. The caller is responsible for setting initial style; this just
// adjusts `el.style.height` on each call.
//
// happy-dom exposes scrollHeight=0 in tests, so we compute by counting
// "\n" + 1 and clamping to [1, maxRows]. Real Chromium uses scrollHeight.
export const autoGrowTextarea = (el, opts = {}) => {
  if (!el) return 0;
  const lineHeight = opts.lineHeight || 22;
  const maxRows = opts.maxRows || 4;
  const text = el.value || "";
  const newlineCount = (text.match(/\n/g) || []).length + 1;
  // Reset height so scrollHeight reflects the actual content (no carry-over).
  el.style.height = "auto";
  let h = lineHeight * Math.min(newlineCount, maxRows);
  if (typeof el.scrollHeight === "number" && el.scrollHeight > 0) {
    // Real browser path. Trust scrollHeight, clamp to maxRows.
    h = Math.min(el.scrollHeight, lineHeight * maxRows);
    h = Math.max(h, lineHeight);
  }
  el.style.height = h + "px";
  return h;
};

// Given the textarea value and cursor position, find the active @-token (if
// the cursor is inside one). Returns { query, start, end } or null.
//
//   - Token starts at the most recent `@` before the cursor that is at
//     start-of-string OR preceded by whitespace.
//   - Token ends at the cursor (or first whitespace before the cursor).
//   - Empty query (just typed `@`) returns { query: "", start, end }, which
//     the caller can use to surface the "type to search" hint.
//   - Returns null if no active mention token.
export const findActiveMentionToken = (text, cursorPos, opts = {}) => {
  if (text == null) return null;
  const pos = Math.max(0, Math.min(cursorPos | 0, text.length));
  const allowSpaces = opts.allowSpaces === true;
  // Walk back from cursor looking for '@'.
  let start = -1;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      // Must be at start of string or preceded by whitespace.
      if (i === 0 || /\s/.test(text[i - 1])) {
        start = i;
      }
      break;
    }
    // A live autocomplete session may span spaces so people can type a full
    // display name ("@Jordan Conner"). Newlines always terminate it. Callers
    // should only opt into allowSpaces while their dropdown is already open;
    // that prevents an earlier, completed mention from re-opening as the user
    // continues writing ordinary prose after it.
    if (/\r|\n/.test(ch)) return null;
    if (!allowSpaces && /\s/.test(ch)) return null;
  }
  if (start === -1) return null;
  const query = text.slice(start + 1, pos);
  if (!allowSpaces && /\s/.test(query)) return null;
  let replaceEnd = pos;
  if (allowSpaces && Array.isArray(opts.fullNames)) {
    const tail = text.slice(start + 1).toLocaleLowerCase();
    for (const candidate of opts.fullNames) {
      const name = String(candidate || "");
      if (
        name &&
        tail.startsWith(name.toLocaleLowerCase()) &&
        pos <= start + 1 + name.length
      ) {
        replaceEnd = Math.max(replaceEnd, start + 1 + name.length);
      }
    }
  } else if (!allowSpaces) {
    while (replaceEnd < text.length && !/\s/.test(text[replaceEnd])) {
      replaceEnd++;
    }
  }
  return replaceEnd === pos
    ? { query, start, end: pos }
    : { query, start, end: pos, replaceEnd };
};

// Replace the active mention token in `text` with `@displayName ` and return
// the new text + new cursor position.
export const replaceMentionToken = (text, token, displayName) => {
  const before = text.slice(0, token.start);
  const after = text.slice(token.replaceEnd ?? token.end);
  const insertion = "@" + displayName + " ";
  return {
    text: before + insertion + after,
    cursor: before.length + insertion.length,
  };
};

// Keep positional mention selections aligned with ordinary textarea edits.
// Browser input events can be represented as one replaced range: the shared
// prefix/suffix stay put, selections after it shift, and a selection touched
// by the edit is invalidated instead of ever being sent to the wrong person.
export const updateMentionSelections = (
  previousText,
  nextText,
  selections,
  explicitEdit = null
) => {
  if (!Array.isArray(selections) || !selections.length) return [];
  const before = String(previousText || "");
  const after = String(nextText || "");
  const hasValidExplicitEdit =
    explicitEdit &&
    Number.isInteger(explicitEdit.start) &&
    Number.isInteger(explicitEdit.end) &&
    explicitEdit.start >= 0 &&
    explicitEdit.end >= explicitEdit.start &&
    explicitEdit.end <= before.length;
  if (
    hasValidExplicitEdit &&
    (before !== after || explicitEdit.end > explicitEdit.start)
  ) {
    const delta = after.length - before.length;
    return selections.flatMap((item) => {
      if (item.end <= explicitEdit.start) return [{ ...item }];
      if (item.start >= explicitEdit.end) {
        return [{ ...item, start: item.start + delta, end: item.end + delta }];
      }
      return [];
    });
  }
  if (before === after) return selections.map((item) => ({ ...item }));

  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const delta = newEnd - oldEnd;

  return selections.flatMap((item) => {
    if (item.end <= prefix) return [{ ...item }];
    if (item.start >= oldEnd) {
      return [{ ...item, start: item.start + delta, end: item.end + delta }];
    }
    return [];
  });
};

const normalizeMentionText = (value) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

const normalizedMentionUser = (candidate) => {
  if (!candidate || typeof candidate !== "object") return null;
  const userId = candidate.user_id ?? candidate.id ?? candidate.userId;
  if (userId == null) return null;
  const name =
    candidate.name ||
    candidate.display_name ||
    candidate.displayName ||
    candidate.handle ||
    `User ${userId}`;
  const rawHandle = candidate.handle || candidate.username || "";
  return {
    ...candidate,
    user_id: userId,
    name,
    handle: String(rawHandle).replace(/^@/, "") || null,
  };
};

// Client-side matching is intentionally authoritative for display names.
// Substack's endpoint is useful for discovery but has historically behaved
// like a handle search. BetterSSC already knows the people seen in the loaded
// chat, so callers merge those profiles with the response and filter both
// fields here. Results are ranked by display name before handle.
export const filterMentionSuggestions = (candidates, query, limit = 50) => {
  const q = normalizeMentionText(query).replace(/^@/, "");
  const unique = new Map();
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const user = normalizedMentionUser(raw);
    if (!user) continue;
    const key = String(user.user_id);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, user);
      continue;
    }
    const merged = { ...previous, ...user };
    // A handle-only API row must not erase the real name learned from chat.
    if (!(raw.name || raw.display_name || raw.displayName) && previous.name) {
      merged.name = previous.name;
    }
    if (!user.handle && previous.handle) merged.handle = previous.handle;
    unique.set(key, merged);
  }

  const scored = [];
  for (const user of unique.values()) {
    const name = normalizeMentionText(user.name);
    const handle = normalizeMentionText(user.handle).replace(/^@/, "");
    let score = 0;
    if (q) {
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.split(" ").some((word) => word.startsWith(q))) score = 2;
      else if (name.includes(q)) score = 3;
      else if (handle === q) score = 4;
      else if (handle.startsWith(q)) score = 5;
      else if (handle.includes(q)) score = 6;
      else continue;
    }
    scored.push({ user, score, name });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.name.localeCompare(b.name) ||
      String(a.user.user_id).localeCompare(String(b.user.user_id))
  );
  return scored.slice(0, Math.max(0, limit | 0)).map((entry) => entry.user);
};

export const mergeMentionSuggestions = (
  localCandidates,
  remoteCandidates,
  query,
  limit = 50
) =>
  filterMentionSuggestions(
    [...(localCandidates || []), ...(remoteCandidates || [])],
    query,
    limit
  );

// Keep the visible token and wire identity separate. The composer inserts the
// recognizable display name, while Substack receives the stable user id and
// canonical handle text when one exists.
export const buildMentionSelection = (candidate) => {
  const user = normalizedMentionUser(candidate);
  if (!user) return null;
  const displayToken = "@" + user.name;
  const wireText = "@" + (user.handle || user.name);
  return {
    displayName: user.name,
    token: displayToken,
    mention: { user_id: user.user_id, text: wireText },
  };
};

// ============================================================
// OPTIMISTIC SEND — RECONCILIATION (commit 3)
// ============================================================
//
// When a user hits Send, we insert a pending comment into the message store
// immediately. The real comment then arrives via either:
//   (a) the postComment response itself, or
//   (b) the next pollNewMessages call (12s interval).
//
// Both paths land in `reconcilePending(store, incoming)`. The store is
// {comments: Map, order: Array} — same shape app.js uses. The reconciler
// matches the pending by id-then-body fallback and either replaces or
// removes it.

// Build a synthetic pending comment object that renders like a real one.
//
//   - id            client uuid (used for dedup against the server echo)
//   - author        the current user object (from state.user)
//   - body / mentions   the payload we sent
//   - created_at    now (so it sorts after every other comment)
//   - _pending: true   so the renderer can style it
export const buildPendingComment = (clientId, user, body, mentions) => {
  return {
    id: clientId,
    body: body || "",
    mentions: mentions || {},
    author: user
      ? {
          id: user.id,
          name: user.name || "You",
          handle: user.handle || null,
          photo_url: user.photo_url || null,
        }
      : { id: "self", name: "You", handle: null, photo_url: null },
    created_at: new Date().toISOString(),
    reactions: {},
    _pending: true,
  };
};

// Reconcile the in-memory store after a real comment arrives. Returns one
// of: "replaced" | "appended" | "noop".
//
//   store      { comments: Map<id, comment>, order: Array<id> }
//   incoming   the real comment object (id should match clientId for dedup)
//
// Match rules, in priority order:
//   1) If store has a comment with the same id and `_pending: true`,
//      replace it in place (preserve its slot in `order`).
//   2) If there's any `_pending: true` comment with matching body + author,
//      replace it (handles servers that don't echo our client id).
//   3) Otherwise it's just a new comment from polling; the caller's normal
//      ingest path handles it. Reconciler returns "noop".
export const reconcilePending = (store, incoming) => {
  if (!store || !incoming || incoming.id == null) return "noop";
  // Preserve fields from the pending row that the server's response shape
  // tends to drop. Without this:
  //   - a reply replaces a "You" pending row with an authorless comment
  //     that renders as "Unknown".
  //   - a reply with a local quote block loses the quote on reconcile
  //     because we no longer send parent_id/quote on the wire (Substack
  //     was rejecting that combo), so the server's echo has no quote
  //     to carry back.
  const preservePending = (incoming, pending) => {
    const out = { ...incoming };
    if (!out.author && pending.author) out.author = pending.author;
    if (out.author && pending.author) {
      if (!out.author.name && pending.author.name)
        out.author.name = pending.author.name;
      if (!out.author.handle && pending.author.handle)
        out.author.handle = pending.author.handle;
      if (!out.author.photo_url && pending.author.photo_url)
        out.author.photo_url = pending.author.photo_url;
    }
    if (!out.quote && pending.quote) out.quote = pending.quote;
    if (out.parent_id == null && pending.parent_id != null)
      out.parent_id = pending.parent_id;
    // Carry forward attachment metadata if the server's echo omits it.
    // The slow reconciliation path (poll-fallback when the synchronous
    // POST response doesn't include the fresh comment) sometimes returns
    // a comment object without the media_uploads field; without this
    // carry-forward, the optimistic preview <img> disappears on
    // reconcile and the blob URL is held by an unreachable object.
    // We DROP the _stagedFile + _localPreview internal flags during
    // carry-forward — they were only meaningful while the row was still
    // pending; once reconciled we either have the real CDN URL or we'll
    // re-fetch via the next poll. We DO keep `url` so the visible
    // <img> doesn't blink out.
    if (
      (!out.media_uploads || !out.media_uploads.length) &&
      pending.media_uploads &&
      pending.media_uploads.length
    ) {
      out.media_uploads = pending.media_uploads.map((m) => {
        const { _stagedFile, _localPreview, ...rest } = m;
        return rest;
      });
    }
    return out;
  };

  // Path 1: exact id match.
  const existing = store.comments.get(incoming.id);
  if (existing && existing._pending) {
    const merged = preservePending(incoming, existing);
    store.comments.set(incoming.id, { ...merged, _pending: false });
    return "replaced";
  }
  // Path 2: pending-with-matching-body fallback.
  for (const [pid, p] of store.comments) {
    if (!p._pending) continue;
    if (p.body !== incoming.body) continue;
    // Author match — also require the incoming carries author/user_id we
    // can match against the pending's author.
    const incomingAuthorId =
      (incoming.author && incoming.author.id) ??
      incoming.user_id ??
      incoming.author_id ??
      null;
    const sameAuthor =
      p.author &&
      incomingAuthorId != null &&
      p.author.id === incomingAuthorId;
    if (!sameAuthor) continue;
    const idx = store.order.indexOf(pid);
    store.comments.delete(pid);
    if (idx !== -1) store.order.splice(idx, 1);
    const merged = preservePending(incoming, p);
    store.comments.set(incoming.id, { ...merged, _pending: false });
    if (idx !== -1) {
      store.order.splice(idx, 0, incoming.id);
    } else {
      store.order.push(incoming.id);
    }
    return "replaced";
  }
  return "noop";
};

// Mark the pending comment with the given client id as failed. Returns true
// if it was found, false otherwise.
export const markPendingFailed = (store, clientId, errorMsg) => {
  if (!store) return false;
  const c = store.comments.get(clientId);
  if (!c || !c._pending) return false;
  c._pending = false;
  c._failed = true;
  c._error = errorMsg || "Send failed";
  return true;
};

// ============================================================
// REACTIONS (commit 5)
// ============================================================
//
// Reactions render as `{<name>: <count>}` on the comment (REST shape) or
// `{<name>: {count, has_reacted}}` (WS shape). We always read the count
// defensively. Optimistic UI: bump the count immediately, roll back on
// API failure. The pure helper here keeps the reducer logic testable.

// Default "top 6" emoji set, used until we can fetch the live library.
// These match what Substack surfaces on hover in the native chat client.
export const DEFAULT_SUGGESTED_REACTIONS = [
  "thumbs_up",
  "red_heart",
  "face_with_tears_of_joy",
  "fire",
  "rocket",
  "clapping_hands",
];

// Pure reducer: takes a comment + reaction type + delta and returns a new
// reactions object. Defensive about:
//   - missing `reactions` field
//   - count stored as number OR {count, has_reacted}
//   - negative result after rollback (clamp to 0, drop the key if 0)
//
// Returns a new object (does not mutate input). Caller is responsible for
// reassigning `comment.reactions`.
export const updateReactionCount = (reactions, type, delta) => {
  const out = { ...(reactions || {}) };
  const cur = out[type];
  let count;
  if (typeof cur === "number") count = cur;
  else if (cur && typeof cur === "object") count = cur.count || 0;
  else count = 0;
  count += delta;
  if (count <= 0) {
    delete out[type];
  } else {
    // Preserve the richer shape if it existed.
    if (cur && typeof cur === "object") {
      out[type] = { ...cur, count, has_reacted: delta > 0 };
    } else {
      out[type] = count;
    }
  }
  return out;
};

// ============================================================
// REPLY / QUOTE STATE (commit 6)
// ============================================================
//
// When a user clicks "Reply" on a hovered message, we record the parent
// comment in state.composer.replyingTo. submitComposer then attaches both
// `parent_id` (for the threaded-reply path) and `quote` (so the message
// renders with the quoted block in Substack's UI). On send success the
// reply state clears. The × button on the composer also clears it.
//
// Spec note: api.postComment accepts both `parentId` (→ parent_id on wire)
// and `quote`. Substack's `parent_id` powers threaded replies; `quote`
// renders the inline quoted block. Defaulting to BOTH set maximizes the
// chance the server creates the reply we expect, and the existing
// read-side `c.quote` rendering will pick up the quoted block.

// Set the reply target on the composer state. `target` should look like
// { id, body, author }.
export const setReplyTarget = (composer, target) => {
  if (!composer) return;
  if (!target || !target.id) {
    composer.replyingTo = null;
    return;
  }
  composer.replyingTo = {
    id: target.id,
    authorName:
      (target.author && (target.author.name || target.author.handle)) ||
      "someone",
    body: (target.body || "").slice(0, 200),
    author: target.author || null,
  };
};

// Clear the reply target. Called by the × button + on send success.
export const clearReplyTarget = (composer) => {
  if (!composer) return;
  composer.replyingTo = null;
};

// Build the extra POST-body fields for a reply. v0.2-write live testing
// revealed that sending `parent_id` and/or `quote` either gets rejected by
// the server (silent 200 + no persistence) or stored in a way that
// doesn't render in native Substack. The ONLY native client capture we
// have shows the wire shape as just `{id, body, mentions}` — no reply
// metadata at all. Substack appears to derive quote relationships from
// @mention of the original author, not from a structured field.
//
// Until we capture the actual native reply API, we send replies as plain
// messages and let the optimistic pending row carry the quote block
// LOCALLY ONLY. reconcilePending preserves pending.quote through
// polling so the user still sees the quoted block in BetterSSC.
export const buildReplyFields = (_composer) => {
  return {};
};

// Extract the top-N suggested reaction names from a fetched reactions
// library payload. Substack's `/api/v1/threads/reactions` returns shapes
// like { suggestedReactionTypes: [...] } or { frequently_used: [...] }.
// Falls back to DEFAULT_SUGGESTED_REACTIONS if nothing recognizable.
export const pickSuggestedReactions = (libraryResponse, n = 6) => {
  // Build a deduped list: live library's suggested reactions first (so
  // user's frequently-used appear at the front), then defaults to pad
  // up to N. Without the padding step, a stingy live library that
  // returns only 2-3 frequently_used keys would shrink the picker after
  // the first click — which was the v0.2-A live bug: defaults showed
  // initially, then the picker collapsed to 3 buttons.
  const out = [];
  const seen = new Set();
  const push = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  if (libraryResponse && typeof libraryResponse === "object") {
    const keys = [
      "suggestedReactionTypes",
      "suggested_reaction_types",
      "frequently_used",
      "frequentlyUsed",
    ];
    for (const k of keys) {
      const arr = libraryResponse[k];
      if (!Array.isArray(arr) || !arr.length) continue;
      for (const c of arr) {
        const name = typeof c === "string" ? c : c && (c.name || c.type);
        push(name);
        if (out.length >= n) return out;
      }
    }
  }
  for (const name of DEFAULT_SUGGESTED_REACTIONS) {
    push(name);
    if (out.length >= n) break;
  }
  return out.slice(0, n);
};

// Tally the reactions actually used across the loaded chat and return the
// top-N reaction NAMES, most-used first, for the picker's "Frequently used"
// row. Defensive about reaction count shapes: REST numeric (`{thumbs_up: 3}`)
// and WS object (`{thumbs_up: {count: 3, has_reacted: true}}`). Dedupes by
// rendered glyph via `glyphOf` so aliases mapping to the same emoji
// (thumbs_up + upvote → 👍) don't both occupy a slot. When the chat has no
// reactions yet, pads/falls back to DEFAULT_SUGGESTED_REACTIONS so the row
// is never empty. Pure: pass reactionEmojiFor as glyphOf at the call site.
export const topReactionsInChat = (
  comments,
  n = 8,
  glyphOf = (name) => name
) => {
  const totals = new Map();
  for (const c of comments || []) {
    const reactions = c && c.reactions;
    if (!reactions || typeof reactions !== "object") continue;
    for (const [name, val] of Object.entries(reactions)) {
      let count;
      if (typeof val === "number") count = val;
      else if (val && typeof val === "object") count = val.count || 0;
      else count = 0;
      if (count <= 0) continue;
      totals.set(name, (totals.get(name) || 0) + count);
    }
  }
  // Stable sort by total desc; ties keep first-seen (chat) order so the row
  // is deterministic across renders.
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const out = [];
  const seenGlyphs = new Set();
  const take = (name) => {
    const glyph = glyphOf(name);
    if (seenGlyphs.has(glyph)) return;
    seenGlyphs.add(glyph);
    out.push(name);
  };
  for (const [name] of ranked) {
    take(name);
    if (out.length >= n) return out;
  }
  for (const name of DEFAULT_SUGGESTED_REACTIONS) {
    take(name);
    if (out.length >= n) break;
  }
  return out;
};

// AI moderation debounce/burst-batching (slice 2 of the moderation arc).
// Pure decision logic only — the timer/DOM wiring lives in app.js's
// queueComposerForModeration, which isn't unit-testable without booting
// the whole app.

// Whether a composer send is eligible to be merged into a moderation hold.
// Mentions use positional ${n} placeholder tokens scoped to a SINGLE
// message's body (see buildCommentBody/segmentBody) — merging two
// messages' mention maps would require renumbering tokens across the
// concatenated text, real complexity for a case that isn't the actual ask
// (catching a rapid plain-text "stream of consciousness" burst). A reply
// or attachment is also excluded — each is a deliberate, singular action,
// not a stream-of-consciousness fragment. An ineligible send flushes any
// open hold first (see resolveComposerModerationHold in app.js), then
// sends itself immediately — never merged, never dropped.
export function isComposerSendHoldEligible({ hasMentions, hasReply, hasAttachment }) {
  return !hasMentions && !hasReply && !hasAttachment;
}

// Append text to an existing hold's buffer, or start a new one. Returns a
// NEW hold object ({ texts }) — callers own attaching a timerId.
export function mergeIntoModerationHold(hold, text) {
  return { texts: hold ? [...hold.texts, text] : [text] };
}

// Join a resolved hold's buffered texts into the single message that gets
// sent/reviewed. One per line — preserves each burst message as its own
// line rather than smashing them into one run-on sentence.
export function joinModerationHoldTexts(texts) {
  return texts.join("\n");
}
