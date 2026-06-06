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

// Auto-link URLs in plain text. Returns array of {type, value} where type is
// "text" or "link". Conservative URL regex.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

export const linkifyText = (text) => {
  if (!text) return [{ type: "text", value: "" }];
  const out = [];
  let lastIdx = 0;
  let m;
  while ((m = URL_RE.exec(text))) {
    if (m.index > lastIdx) {
      out.push({ type: "text", value: text.slice(lastIdx, m.index) });
    }
    out.push({ type: "link", value: m[0] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    out.push({ type: "text", value: text.slice(lastIdx) });
  }
  return out;
};

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
