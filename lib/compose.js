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

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  // Find first index of each mention in the text. Drop entries that don't
  // occur. Sort by first-occurrence so the resulting mention slots are 0..N
  // in left-to-right order, matching what the native client does.
  const occurrences = entries
    .map(([token, val]) => {
      const idx = safeText.indexOf(token);
      const userId = val.user_id != null ? val.user_id : val.userId;
      const displayText = val.text || token;
      return { token, userId, displayText, firstIdx: idx };
    })
    .filter((o) => o.firstIdx !== -1)
    .sort((a, b) => a.firstIdx - b.firstIdx);

  if (!occurrences.length) {
    return { body: safeText, mentions: {} };
  }

  let body = safeText;
  const mentions = {};
  occurrences.forEach((o, slot) => {
    // Replace ALL occurrences of this mention token with `${slot}`. Native
    // client behavior — one mention slot per distinct @user, regardless of
    // how many times they're referenced.
    const re = new RegExp(escapeRegex(o.token), "g");
    body = body.replace(re, "${" + slot + "}");
    mentions[String(slot)] = {
      user_id: o.userId,
      text: o.displayText,
    };
  });

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
export const findActiveMentionToken = (text, cursorPos) => {
  if (text == null) return null;
  const pos = Math.max(0, Math.min(cursorPos | 0, text.length));
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
    // Any whitespace before finding @ means cursor is not in a mention.
    if (/\s/.test(ch)) return null;
  }
  if (start === -1) return null;
  const query = text.slice(start + 1, pos);
  // Query must not contain whitespace (sanity check — we bailed on
  // whitespace above, so this is belt-and-suspenders).
  if (/\s/.test(query)) return null;
  return { query, start, end: pos };
};

// Replace the active mention token in `text` with `@displayName ` and return
// the new text + new cursor position.
export const replaceMentionToken = (text, token, displayName) => {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const insertion = "@" + displayName + " ";
  return {
    text: before + insertion + after,
    cursor: before.length + insertion.length,
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
  // Path 1: exact id match.
  const existing = store.comments.get(incoming.id);
  if (existing && existing._pending) {
    // Carry over the id slot in `order`.
    store.comments.set(incoming.id, { ...incoming, _pending: false });
    return "replaced";
  }
  // Path 2: pending-with-matching-body fallback.
  for (const [pid, p] of store.comments) {
    if (!p._pending) continue;
    if (p.body !== incoming.body) continue;
    const sameAuthor =
      p.author &&
      incoming.author &&
      (p.author.id === incoming.author.id ||
        p.author.id === incoming.user_id ||
        p.author.id === incoming.author_id);
    if (!sameAuthor) continue;
    // Remove the pending entry and re-insert the real one at the same slot
    // in `order`.
    const idx = store.order.indexOf(pid);
    store.comments.delete(pid);
    if (idx !== -1) store.order.splice(idx, 1);
    store.comments.set(incoming.id, { ...incoming, _pending: false });
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

// Extract the top-N suggested reaction names from a fetched reactions
// library payload. Substack's `/api/v1/threads/reactions` returns shapes
// like { suggestedReactionTypes: [...] } or { frequently_used: [...] }.
// Falls back to DEFAULT_SUGGESTED_REACTIONS if nothing recognizable.
export const pickSuggestedReactions = (libraryResponse, n = 6) => {
  if (libraryResponse && typeof libraryResponse === "object") {
    // Try each candidate field in priority order. We pick the FIRST one
    // that's a non-empty array of usable entries — that way
    // `suggestedReactionTypes: []` doesn't suppress a populated
    // `frequently_used` list.
    const keys = [
      "suggestedReactionTypes",
      "suggested_reaction_types",
      "frequently_used",
      "frequentlyUsed",
    ];
    for (const k of keys) {
      const arr = libraryResponse[k];
      if (!Array.isArray(arr) || !arr.length) continue;
      const names = arr
        .map((c) => (typeof c === "string" ? c : c && (c.name || c.type)))
        .filter(Boolean);
      if (names.length) return names.slice(0, n);
    }
  }
  return DEFAULT_SUGGESTED_REACTIONS.slice(0, n);
};
