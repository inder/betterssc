// Small helpers shared by app.js, render, notify.

// Relative time formatter — uses Intl.RelativeTimeFormat where possible.
// Returns "2m ago", "Tue 3:14 PM", "Apr 12" style strings.
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const formatRelativeTime = (iso) => {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const now = Date.now();
  const diffMs = t - now; // negative for past
  const absSec = Math.round(Math.abs(diffMs) / 1000);
  if (absSec < 60) return rtf.format(Math.round(diffMs / 1000), "second");
  if (absSec < 3600) return rtf.format(Math.round(diffMs / 60000), "minute");
  if (absSec < 86400) return rtf.format(Math.round(diffMs / 3600000), "hour");
  if (absSec < 86400 * 6)
    return new Date(t).toLocaleString("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  return new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });
};

export const formatAbsoluteTime = (iso) => {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
};

// Substack stores message body with `${0}` `${1}` placeholders for mentions
// alongside a `mentions` map. Expand to a list of {type, value} segments.
export const segmentBody = (body, mentions) => {
  if (!body) return [];
  const segments = [];
  const re = /\$\{(\d+)\}/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(body))) {
    if (m.index > lastIdx) {
      segments.push({ type: "text", value: body.slice(lastIdx, m.index) });
    }
    const mention = mentions && mentions[m[1]];
    segments.push({
      type: "mention",
      value: (mention && mention.text) || "@?",
      userId: mention && mention.user_id,
    });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < body.length) {
    segments.push({ type: "text", value: body.slice(lastIdx) });
  }
  return segments;
};

import { KNOWN_TICKERS } from "./tickers.js";

// Auto-link URLs AND ticker symbols ($NASA, $DXYZ, $BRK.B) in plain text.
// Returns array of {type, value} where type is "text", "link", or "ticker".
// Ticker tokens carry an extra `symbol` field (uppercased, no $).
//
// Ticker rules:
//   - $ followed by 1-6 letters (so $NASA, $EURUSD, $BRK match; $5 does not).
//   - Optional .<letter> suffix for share classes ($BRK.B).
//   - Negative lookbehind on letters/digits prevents "email$NASA" matches.
//   - \b on the right keeps trailing punctuation out of the token.
//
// URLs are conservative http(s):// matches with whitespace/quote terminators.
const TOKEN_RE = /(\bhttps?:\/\/[^\s<>"']+)|((?<![A-Za-z0-9])\$[A-Za-z]{1,6}(?:\.[A-Za-z])?\b)/g;

// Bare-ticker matcher — 3-5 uppercase letters at word boundaries. Case-
// sensitive (no `i` flag) so "Meta" / "meta" don't match, only "META".
// The KNOWN_TICKERS Set filters candidates so this is purely "is this
// a real ticker I should link?" rather than "is this all-caps?"
const BARE_TICKER_RE = /\b[A-Z]{3,5}\b/g;

// Walk a plain-text segment and emit a mix of {type:"text"} and
// {type:"ticker"} tokens for any KNOWN_TICKERS match. Preserves the
// surrounding text verbatim so the caller can rebuild the original
// content from the tokens.
const segmentBareTickers = (text) => {
  if (!text) return [{ type: "text", value: text || "" }];
  const out = [];
  let lastIdx = 0;
  let m;
  BARE_TICKER_RE.lastIndex = 0;
  while ((m = BARE_TICKER_RE.exec(text))) {
    const word = m[0];
    if (!KNOWN_TICKERS.has(word)) continue;
    if (m.index > lastIdx) {
      out.push({ type: "text", value: text.slice(lastIdx, m.index) });
    }
    out.push({ type: "ticker", value: word, symbol: word });
    lastIdx = m.index + word.length;
  }
  if (lastIdx < text.length) {
    out.push({ type: "text", value: text.slice(lastIdx) });
  }
  // Empty segments are noise for the caller — strip them.
  return out.filter((p) => !(p.type === "text" && p.value === ""));
};

export const linkifyText = (text) => {
  if (!text) return [{ type: "text", value: "" }];
  const out = [];
  let lastIdx = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    if (m.index > lastIdx) {
      out.push(...segmentBareTickers(text.slice(lastIdx, m.index)));
    }
    const matched = m[0];
    if (matched[0] === "$") {
      out.push({
        type: "ticker",
        value: matched,
        symbol: matched.slice(1).toUpperCase(),
      });
    } else {
      out.push({ type: "link", value: matched });
    }
    lastIdx = m.index + matched.length;
  }
  if (lastIdx < text.length) {
    out.push(...segmentBareTickers(text.slice(lastIdx)));
  }
  // Defensive: if no tokens were produced at all (empty input or
  // pure whitespace), return a single empty text token to preserve
  // the original contract (callers expect a non-empty array).
  if (!out.length) return [{ type: "text", value: text }];
  return out;
};

// Derive a short compact acronym from a chat / publication name. Used as
// a notification-title prefix so a glance tells you which chat fired the
// alert (vs. the full name truncating to "New from Za's Market Term...").
//
// Heuristics, in order:
//   - Expand CamelCase boundaries ("TechBros" → "Tech Bros")
//   - Split on whitespace + punctuation (handles apostrophes, hyphens, etc.)
//   - Drop common articles + connectors ("the", "a", "of", "for", "&", …)
//   - Drop single-letter tokens (the "s" in "Za's", stray punctuation)
//   - Multi-word: first letter of each, uppercased. Short ALL-CAPS words
//     (2-4 chars, already an acronym) are preserved intact so
//     "ETH Discussion" → "ETHD", not "ED".
//   - Single-word: return as-is if ≤10 chars, else truncate to 8.
//   - Empty / pure-punctuation: fall back to first 6 alnum chars or "Chat".
//
// Examples:
//   "Za's Market Terminal" → "ZMT"
//   "The Daily Stock"      → "DS"
//   "ETH Discussion"       → "ETHD"
//   "TechBros"             → "TB"
//   "Bullpen"              → "Bullpen"
//   "ETH"                  → "ETH"
const NAME_SKIP_WORDS = new Set([
  "the", "a", "an", "of", "for", "in", "and", "or", "to", "on",
  "&", "by", "with", "at",
]);

export function chatNameAcronym(name) {
  if (!name || typeof name !== "string") return "Chat";
  // Insert a space at every lower→upper transition so CamelCase tokenizes.
  const expanded = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Split on whitespace + common punctuation.
  const tokens = expanded.split(/[\s'_\-/.,!?:;"]+/);
  // Keep alphanumeric tokens that aren't articles/single letters.
  const words = tokens.filter(
    (w) =>
      w.length >= 2 &&
      /^[A-Za-z0-9]+$/.test(w) &&
      !NAME_SKIP_WORDS.has(w.toLowerCase())
  );
  if (!words.length) {
    const fallback = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
    return fallback || "Chat";
  }
  if (words.length === 1) {
    const w = words[0];
    return w.length <= 10 ? w : w.slice(0, 8);
  }
  const parts = words.map((w) =>
    w.length >= 2 && w.length <= 4 && w === w.toUpperCase()
      ? w
      : w[0].toUpperCase()
  );
  return parts.join("");
}

// Group sequential messages by author for Discord-style rendering. Returns
// array of groups: [{ author, items: [comment, comment, ...] }, ...].
// Splits group if gap > 5 min between consecutive messages from same author.
const GROUP_GAP_MS = 5 * 60 * 1000;

export const groupByAuthor = (comments) => {
  const groups = [];
  for (const c of comments) {
    if (!c) continue;
    // Defensive: synthesize a placeholder author if missing (deleted user,
    // system message, malformed response). Without this, a missing author
    // makes the whole render abort silently.
    const author = c.author || {
      id: "unknown",
      name: "Unknown",
      photo_url: null,
    };
    const last = groups[groups.length - 1];
    const sameAuthor = last && last.author && last.author.id === author.id;
    const tCur = new Date(c.created_at).getTime() || 0;
    const tLast =
      last && last.items.length
        ? new Date(last.items[last.items.length - 1].created_at).getTime() || 0
        : 0;
    if (sameAuthor && tCur - tLast < GROUP_GAP_MS) {
      last.items.push(c);
    } else {
      groups.push({ author, items: [c] });
    }
  }
  return groups;
};

// HTML escape for safety.
export const escapeHtml = (s) => {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

// Crockford-style stable client UUID — for optimistic-update dedup on send.
export const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

// Throttle: leading + trailing.
export const throttle = (fn, ms) => {
  let last = 0;
  let pendingArgs = null;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed >= ms) {
      last = now;
      fn(...args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          if (pendingArgs) {
            fn(...pendingArgs);
            pendingArgs = null;
          }
        }, ms - elapsed);
      }
    }
  };
};

// Debounce: trailing only.
export const debounce = (fn, ms) => {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
};

// Returns true if `text` contains @-mention of `userName` or `userHandle`.
// Case-insensitive, word-boundary-aware.
export const mentionsUser = (text, userName, userHandle) => {
  if (!text) return false;
  const targets = [];
  if (userName) targets.push(userName.toLowerCase());
  if (userHandle) targets.push(userHandle.toLowerCase());
  const t = text.toLowerCase();
  // Mentions in Substack render as `@<name>` in the text after segment
  // expansion. Also include literal handle without @.
  for (const target of targets) {
    if (t.includes("@" + target)) return true;
    if (t.includes(target)) {
      // ensure word boundary so "@Bobby" doesn't match "Bo"
      const re = new RegExp(`\\b${escapeRegex(target)}\\b`, "i");
      if (re.test(text)) return true;
    }
  }
  return false;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Background chat-prefetch pacing knobs. Imported by app.js's
// runChatBgPrefetch orchestrator and tested in isolation here.
//
// PREFETCH_BASE_DELAY_MS is the wait between successful page fetches
// — gentle enough that Substack's REST API hasn't rate-limited us in
// practice. PREFETCH_MAX_BACKOFF_MS caps the 429-retry doubling so we
// don't sleep through the user's session waiting on a server that
// won't yield.
export const PREFETCH_BASE_DELAY_MS = 300;
export const PREFETCH_MAX_BACKOFF_MS = 2400;
// How often runChatBgPrefetch checks for the loadingHistory mutex slot
// to free up. Polled, not promise-based, because the lock is held by a
// completely separate async function. 150ms keeps user-initiated `g`
// keystrokes feeling instant while not pegging the event loop.
export const PREFETCH_SLOT_POLL_MS = 150;
// Completion-toast lifetime: visible window before .is-leaving fades it
// out, then removal from the DOM. Sum is the total time the node sticks
// around — keep it long enough that a user glancing at the screen sees
// the message, short enough that it doesn't compete with the chat.
export const PREFETCH_PILL_VISIBLE_MS = 2500;
export const PREFETCH_PILL_REMOVE_MS = 3500;

// Pure: given the previous attempt's delay (null on the first 429
// after a healthy stretch), return the next delay in ms — doubling
// each retry. Returns null once the next delay would exceed
// PREFETCH_MAX_BACKOFF_MS, which the caller treats as "give up
// silently." Best-effort prefetch: a give-up just means the user
// falls back to the prior page-on-demand `g` behavior.
export function computeRetryDelay(prevDelay) {
  if (prevDelay == null) return 600;
  const next = prevDelay * 2;
  if (next > PREFETCH_MAX_BACKOFF_MS) return null;
  return next;
}
