// lib/telegram.js — pure logic for the BetterSSC → Telegram bridge.
//
// No DOM, no network, no chrome.* here — everything in this module is a pure
// function so it can be unit-tested in isolation. All IO (fetch to
// api.telegram.org, chrome.storage, the poll hook) lives in app.js.
//
// Security note: message bodies AND author display names are attacker-
// controllable (any member of the Substack chat can set them). Everything that
// flows into a Telegram parse_mode:"HTML" payload MUST be HTML-escaped here.

import { REACTION_EMOJI } from "./emojis.js";

// ── HTML escaping for Telegram parse_mode:"HTML" ────────────────────────────
// Telegram HTML mode only requires &, <, > to be escaped (quotes are fine
// outside attribute values, and we never build attributes). Escaping & first is
// load-bearing so we don't double-escape the entities we just produced.
export const escapeTelegramHtml = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// ── Media classification ────────────────────────────────────────────────────
const isImageUpload = (u) =>
  !!u &&
  ((typeof u.content_type === "string" && u.content_type.startsWith("image/")) ||
    u.type === "image" ||
    (typeof u.url === "string" && /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u.url)));

// First renderable image URL on a comment, or null.
export const pickImageUrl = (comment) => {
  const ups = (comment && comment.media_uploads) || [];
  for (const u of ups) {
    if (isImageUpload(u) && typeof u.url === "string" && u.url) return u.url;
  }
  return null;
};

// True when the comment carries media but NONE of it is a renderable image
// (e.g. a video or file). Used to append a "[attachment]" marker so a media
// message never silently forwards as if it were plain text.
export const hasNonImageMedia = (comment) => {
  const ups = (comment && comment.media_uploads) || [];
  return ups.length > 0 && !ups.some(isImageUpload);
};

// ── Outbound formatting (Substack comment → Telegram) ───────────────────────
const MAX_MESSAGE_LEN = 4096; // Telegram sendMessage hard limit
const MAX_CAPTION_LEN = 1024; // Telegram sendPhoto caption hard limit
const MAX_NAME_LEN = 256;

// Escape `raw`, truncating the RAW string (never the escaped output) so the
// escaped result fits within maxLen. Truncating raw guarantees we never split
// an HTML entity (e.g. "&amp;" → "&am"), which Telegram rejects with
// "400 can't parse entities". Appends an ellipsis when truncated.
export const escapedTruncate = (raw, maxLen) => {
  const s = String(raw == null ? "" : raw);
  const esc = escapeTelegramHtml(s);
  if (esc.length <= maxLen) return esc;
  if (maxLen <= 1) return "…";
  // Largest raw prefix whose escaped form fits in maxLen-1 (room for "…").
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escapeTelegramHtml(s.slice(0, mid)).length <= maxLen - 1) lo = mid;
    else hi = mid - 1;
  }
  return escapeTelegramHtml(s.slice(0, lo)) + "…";
};

const authorHeader = (comment) =>
  `<b>${escapedTruncate(
    (comment && comment.author && comment.author.name) || "Unknown",
    MAX_NAME_LEN
  )}</b>`;

// sendMessage payload body. The bot is the nominal sender, so the original
// author is carried as a bold header — the BetterSSC "author attribution" the
// overlay shows in its own chrome. Total text is capped at Telegram's 4096.
export const formatMessageForTelegram = (comment) => {
  const header = authorHeader(comment);
  const marker = hasNonImageMedia(comment) ? "\n📎 [attachment]" : "";
  const bodyBudget = MAX_MESSAGE_LEN - header.length - marker.length - 1; // -1: newline
  const body = escapedTruncate(
    (comment && comment.body) || "",
    Math.max(0, bodyBudget)
  );
  let text = header;
  if (body) text += `\n${body}`;
  text += marker;
  return { text, parse_mode: "HTML", disable_web_page_preview: false };
};

// sendPhoto caption, capped at Telegram's 1024.
export const formatPhotoCaption = (comment) => {
  const header = authorHeader(comment);
  const bodyBudget = MAX_CAPTION_LEN - header.length - 1; // -1: newline
  const body = escapedTruncate(
    (comment && comment.body) || "",
    Math.max(0, bodyBudget)
  );
  let cap = header;
  if (body) cap += `\n${body}`;
  return cap;
};

// ── Forward decision ────────────────────────────────────────────────────────
// Decide whether a freshly-arrived comment should be forwarded to Telegram.
//   sentIds : Set of comment ids already forwarded (idempotency — never resend)
//   selfId  : the logged-in Substack user id, or null/undefined if unknown.
// When selfId is unknown we do NOT skip on authorship (fail toward forwarding
// for the read leg — you simply see your own messages echoed). The write-back
// echo-loop is prevented separately by adding posted-back ids to sentIds.
export const shouldForward = (comment, sentIds, selfId) => {
  if (!comment || comment.id == null) return false;
  if (comment._pending) return false;
  if (sentIds && sentIds.has(comment.id)) return false;
  if (
    selfId != null &&
    comment.author &&
    comment.author.id != null &&
    String(comment.author.id) === String(selfId)
  ) {
    return false;
  }
  return true;
};

// ── Inbound parsing (Telegram getUpdates → normalized events) ───────────────
const pickReactionEmoji = (arr) => {
  if (!Array.isArray(arr)) return null;
  for (const r of arr) {
    if (r && r.type === "emoji" && r.emoji) return r.emoji;
  }
  return null;
};

// Normalize a getUpdates JSON response into a flat list of events. Unknown
// update kinds are surfaced as {type:"other"} so the probe harness can report
// exactly what Telegram delivers for a PRIVATE chat (esp. message_reaction).
export const parseGetUpdates = (json) => {
  const out = [];
  const results = (json && json.result) || [];
  for (const u of results) {
    const updateId = u.update_id;
    if (u.message) {
      const m = u.message;
      out.push({
        updateId,
        type: "message",
        chatId: m.chat && m.chat.id,
        messageId: m.message_id,
        text: typeof m.text === "string" ? m.text : "",
        date: m.date,
        fromBot: !!(m.from && m.from.is_bot),
      });
    } else if (u.message_reaction) {
      const r = u.message_reaction;
      out.push({
        updateId,
        type: "reaction",
        chatId: r.chat && r.chat.id,
        messageId: r.message_id,
        emoji: pickReactionEmoji(r.new_reaction),
      });
    } else {
      out.push({ updateId, type: "other" });
    }
  }
  return out;
};

// getUpdates offset to request next = max(update_id) + 1. Returns the unchanged
// currentOffset when there are no events (so a quiet poll doesn't rewind).
export const nextOffset = (events, currentOffset) => {
  let max = -Infinity;
  for (const e of events) {
    if (typeof e.updateId === "number" && e.updateId > max) max = e.updateId;
  }
  if (max === -Infinity) return currentOffset || 0;
  return max + 1;
};

// ── Reaction mapping (Telegram emoji → Substack reaction_name) ──────────────
// Grounded in the real REACTION_EMOJI catalog by reverse-indexing it, rather
// than hand-guessing names. Variation selectors (U+FE0F) are stripped so a
// Telegram "❤" matches the catalog's "❤️". First-wins on collisions.
const stripVariation = (s) => String(s || "").replace(/️/g, "");

const EMOJI_TO_REACTION = (() => {
  const idx = Object.create(null);
  for (const [name, emoji] of Object.entries(REACTION_EMOJI)) {
    const key = stripVariation(emoji);
    if (key && !(key in idx)) idx[key] = name;
  }
  return idx;
})();

// Best-effort Telegram reaction emoji → Substack reaction_name. Returns null
// when there is no match — callers MUST skip on null (invariant 7: fail safe,
// never guess a wrong reaction).
export const mapTelegramReaction = (emoji) => {
  if (!emoji) return null;
  const key = stripVariation(emoji);
  return EMOJI_TO_REACTION[key] || null;
};

// Exposed for tests/inspection.
export const _reactionIndex = EMOJI_TO_REACTION;
