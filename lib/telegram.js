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

// ── Reply / quote surfacing ─────────────────────────────────────────────────
// The quoted-context preview for a reply ({author, body}), or null when the
// comment has no renderable quote. Sourced from comment.quote, the rich object
// the read-side attaches (unwrapComment → raw.quote.comment).
export const quotePreview = (comment) => {
  const q = comment && comment.quote;
  if (!q || (!q.body && !(q.author && q.author.name))) return null;
  return { author: (q.author && q.author.name) || "Reply", body: q.body || "" };
};

const MAX_QUOTE_BODY = 200; // mirror the read-side's c.quote.body.slice(0, 200)

// A Telegram <blockquote> for the quoted message, or "" when not a quote-reply.
// HTML-escaped + entity-safe truncation, like every other outbound string.
const quoteBlockHtml = (comment) => {
  const qp = quotePreview(comment);
  if (!qp) return "";
  const a = escapedTruncate(qp.author, MAX_NAME_LEN);
  const b = escapedTruncate(qp.body, MAX_QUOTE_BODY);
  const inner = b ? `<b>${a}</b>\n${b}` : `<b>${a}</b>`;
  return `<blockquote>${inner}</blockquote>\n`;
};

// sendMessage payload body. The bot is the nominal sender, so the original
// author is carried as a bold header — the BetterSSC "author attribution" the
// overlay shows in its own chrome. Total text is capped at Telegram's 4096.
// opts.includeQuote prepends an inline <blockquote> of the replied-to message.
// The bridge always passes true (we do NOT use native Telegram replies — the
// bot is the sender, so Telegram would mislabel the quote with the bot's name).
// The false branch exists only for tests of the no-quote shape.
export const formatMessageForTelegram = (comment, opts = {}) => {
  const header = authorHeader(comment);
  const quoteBlock = opts.includeQuote ? quoteBlockHtml(comment) : "";
  const marker = hasNonImageMedia(comment) ? "\n📎 [attachment]" : "";
  const bodyBudget =
    MAX_MESSAGE_LEN - quoteBlock.length - header.length - marker.length - 1;
  const body = escapedTruncate(
    (comment && comment.body) || "",
    Math.max(0, bodyBudget)
  );
  let text = quoteBlock + header;
  if (body) text += `\n${body}`;
  text += marker;
  return { text, parse_mode: "HTML", disable_web_page_preview: false };
};

// sendPhoto caption, capped at Telegram's 1024. opts.includeQuote: same as
// formatMessageForTelegram (bridge always passes true; false is test-only).
export const formatPhotoCaption = (comment, opts = {}) => {
  const header = authorHeader(comment);
  const quoteBlock = opts.includeQuote ? quoteBlockHtml(comment) : "";
  const bodyBudget = MAX_CAPTION_LEN - quoteBlock.length - header.length - 1;
  const body = escapedTruncate(
    (comment && comment.body) || "",
    Math.max(0, bodyBudget)
  );
  let cap = quoteBlock + header;
  if (body) cap += `\n${body}`;
  return cap;
};

// ── Forward decision ────────────────────────────────────────────────────────
// Decide whether a freshly-arrived comment should be forwarded to Telegram.
//   sentIds : Set of comment ids already forwarded OR posted-back (idempotency).
// We forward ALL real, not-yet-sent messages — INCLUDING your own Substack-
// posted ones, because the bridge mirrors the whole feed (a solo user must see
// their own messages in Telegram too). Echo prevention is sentIds-ONLY: a
// message posted FROM Telegram has its comment id pre-claimed in sentIds before
// the post lands (telegram-bridge.routeInbound), so it is never mirrored back.
// (We deliberately do NOT skip by author: that hid own Substack-origin messages
// from the mirror — the v0.9.0 "no messages from Substack" bug.)
export const shouldForward = (comment, sentIds) => {
  if (!comment || comment.id == null) return false;
  if (comment._pending) return false;
  if (sentIds && sentIds.has(comment.id)) return false;
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

// ── Session banner ──────────────────────────────────────────────────────────
// A one-line marker posted to Telegram when streaming starts, so the chat shows
// where a session's stream begins. dateStr is escaped (defensive — it's just a
// date, but it flows into parse_mode:"HTML").
export const sessionBannerText = (dateStr) =>
  `<b>—— Start of Substack chat · ${escapeTelegramHtml(dateStr)} ——</b>`;

// ── Inbound post-back gating (Telegram message → Substack) ──────────────────
// Returns the trimmed text to post to Substack, or null to skip. Skips empty
// messages and any message starting with "/" (a Telegram bot command like
// /start — NOT a chat message; this also prevents "/start" leaking into the
// public Substack thread). Known limitation: a legit chat message that begins
// with "/" is dropped — acceptable for v1.
export const textForPostBack = (text) => {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return null;
  if (t.startsWith("/")) return null;
  return t;
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
