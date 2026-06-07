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
