import { describe, it, expect } from "vitest";
import {
  escapeTelegramHtml,
  pickImageUrl,
  hasNonImageMedia,
  formatMessageForTelegram,
  formatPhotoCaption,
  shouldForward,
  parseGetUpdates,
  nextOffset,
  mapTelegramReaction,
  textForPostBack,
  sessionBannerText,
  replyTargetId,
  quotePreview,
} from "../lib/telegram.js";

const comment = (over = {}) => ({
  id: "c1",
  body: "hello",
  author: { id: 7, name: "Alice" },
  media_uploads: [],
  ...over,
});

describe("escapeTelegramHtml", () => {
  it("escapes &, <, > and escapes & first (no double-escape)", () => {
    expect(escapeTelegramHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeTelegramHtml("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
  it("coerces null/undefined/number to a string", () => {
    expect(escapeTelegramHtml(null)).toBe("");
    expect(escapeTelegramHtml(undefined)).toBe("");
    expect(escapeTelegramHtml(42)).toBe("42");
  });
});

describe("pickImageUrl / hasNonImageMedia", () => {
  it("picks the first image by content_type", () => {
    expect(
      pickImageUrl(
        comment({
          media_uploads: [
            { content_type: "image/png", url: "https://x/a.png" },
            { content_type: "image/jpeg", url: "https://x/b.jpg" },
          ],
        })
      )
    ).toBe("https://x/a.png");
  });
  it("picks by url extension when content_type missing", () => {
    expect(
      pickImageUrl(comment({ media_uploads: [{ url: "https://x/c.webp?sig=1" }] }))
    ).toBe("https://x/c.webp?sig=1");
  });
  it("returns null when no media", () => {
    expect(pickImageUrl(comment())).toBe(null);
  });
  it("hasNonImageMedia true for a video-only upload", () => {
    const c = comment({ media_uploads: [{ content_type: "video/mp4", url: "https://x/v.mp4" }] });
    expect(pickImageUrl(c)).toBe(null);
    expect(hasNonImageMedia(c)).toBe(true);
  });
  it("hasNonImageMedia false when an image is present", () => {
    expect(hasNonImageMedia(comment({ media_uploads: [{ content_type: "image/png", url: "https://x/a.png" }] }))).toBe(false);
  });
  it("hasNonImageMedia false when no media at all", () => {
    expect(hasNonImageMedia(comment())).toBe(false);
  });
});

describe("formatMessageForTelegram", () => {
  it("bolds the author and appends escaped body", () => {
    const { text, parse_mode } = formatMessageForTelegram(comment({ author: { id: 7, name: "Bob" }, body: "hi there" }));
    expect(text).toBe("<b>Bob</b>\nhi there");
    expect(parse_mode).toBe("HTML");
  });
  it("escapes attacker-controlled author name AND body", () => {
    const { text } = formatMessageForTelegram(comment({ author: { id: 7, name: "<script>" }, body: "a < b & c" }));
    expect(text).toBe("<b>&lt;script&gt;</b>\na &lt; b &amp; c");
  });
  it("falls back to Unknown author and header-only when no body", () => {
    expect(formatMessageForTelegram(comment({ author: {}, body: "" })).text).toBe("<b>Unknown</b>");
  });
  it("appends an attachment marker for non-image media", () => {
    const { text } = formatMessageForTelegram(comment({ body: "look", media_uploads: [{ content_type: "video/mp4", url: "https://x/v.mp4" }] }));
    expect(text).toBe("<b>Alice</b>\nlook\n📎 [attachment]");
  });
});

describe("formatPhotoCaption", () => {
  it("truncates captions over 1024 chars", () => {
    const cap = formatPhotoCaption(comment({ author: { name: "A" }, body: "x".repeat(2000) }));
    expect(cap.length).toBeLessThanOrEqual(1024);
    expect(cap.endsWith("…")).toBe(true);
  });
});

// Adversarial: truncation/concatenation must never emit invalid Telegram HTML.
// A partial entity ("&am" instead of "&amp;") makes Telegram reject the whole
// payload with "400 can't parse entities" — and it fails on exactly the long /
// entity-dense inputs the bridge must handle.
const hasPartialEntity = (s) => /&[a-z]{1,3}(?:…|$)/.test(s.replace(/&(amp|lt|gt);/g, ""));

describe("escaped truncation never splits an HTML entity", () => {
  it("sendMessage caps at 4096 with a 5000-char body", () => {
    const { text } = formatMessageForTelegram(comment({ body: "z".repeat(5000) }));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("…")).toBe(true);
  });
  it("sendMessage keeps entities whole with an all-'&' 5000-char body", () => {
    const { text } = formatMessageForTelegram(comment({ body: "&".repeat(5000) }));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(hasPartialEntity(text)).toBe(false);
    // every '&' that survived must be a complete &amp;
    expect(/&(?!amp;)/.test(text.replace(/…$/, ""))).toBe(false);
  });
  it("caption keeps entities whole when the boundary lands inside one", () => {
    // '<' escapes to '&lt;' (4 chars). A long run forces truncation mid-entity
    // unless we truncate the raw string first.
    const cap = formatPhotoCaption(comment({ author: { name: "A" }, body: "<".repeat(2000) }));
    expect(cap.length).toBeLessThanOrEqual(1024);
    expect(/&(?!lt;)/.test(cap.replace(/…$/, ""))).toBe(false);
  });
  it("a huge author name can't blow the budget or split an entity", () => {
    const { text } = formatMessageForTelegram(comment({ author: { id: 1, name: "&".repeat(4000) }, body: "hi" }));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(hasPartialEntity(text)).toBe(false);
  });
});

describe("shouldForward", () => {
  it("forwards a fresh non-pending comment", () => {
    expect(shouldForward(comment(), new Set())).toBe(true);
  });
  it("skips pending optimistic rows", () => {
    expect(shouldForward(comment({ _pending: true }), new Set())).toBe(false);
  });
  it("skips already-sent ids (idempotency)", () => {
    expect(shouldForward(comment({ id: "c1" }), new Set(["c1"]))).toBe(false);
  });
  it("FORWARDS your own messages — the bridge mirrors the whole feed (no author skip)", () => {
    // Regression guard for the v0.9.0 "no messages from Substack" bug: a solo
    // user posting as themselves must still see their messages in Telegram.
    expect(shouldForward(comment({ author: { id: 7 } }), new Set())).toBe(true);
  });
  it("prevents echo of a Telegram-originated message via sentIds (not author)", () => {
    // A post-back pre-claims its comment id in sentIds before it lands.
    const postedBack = comment({ id: "pb1", author: { id: 7 } });
    expect(shouldForward(postedBack, new Set(["pb1"]))).toBe(false);
  });
  it("rejects malformed comments", () => {
    expect(shouldForward(null, new Set())).toBe(false);
    expect(shouldForward({ body: "x" }, new Set())).toBe(false);
  });
});

describe("parseGetUpdates / nextOffset", () => {
  it("normalizes message updates", () => {
    const evs = parseGetUpdates({
      result: [{ update_id: 10, message: { message_id: 5, text: "hey", date: 1, chat: { id: 555 }, from: { is_bot: false } } }],
    });
    expect(evs).toEqual([{ updateId: 10, type: "message", chatId: 555, messageId: 5, text: "hey", date: 1, fromBot: false }]);
  });
  it("normalizes a message_reaction update and extracts the emoji", () => {
    const evs = parseGetUpdates({
      result: [{ update_id: 11, message_reaction: { message_id: 5, chat: { id: 555 }, new_reaction: [{ type: "emoji", emoji: "🔥" }] } }],
    });
    expect(evs[0]).toEqual({ updateId: 11, type: "reaction", chatId: 555, messageId: 5, emoji: "🔥" });
  });
  it("surfaces unknown update kinds as 'other' (probe visibility)", () => {
    expect(parseGetUpdates({ result: [{ update_id: 12, my_chat_member: {} }] })[0]).toEqual({ updateId: 12, type: "other" });
  });
  it("nextOffset = max update_id + 1, keeps offset on an empty poll", () => {
    expect(nextOffset(parseGetUpdates({ result: [] }), 100)).toBe(100);
    expect(nextOffset([{ updateId: 10 }, { updateId: 12 }, { updateId: 11 }], 0)).toBe(13);
  });
});

describe("replyTargetId", () => {
  it("prefers quote.id, then quote_id, then parent_id", () => {
    expect(replyTargetId(comment({ quote: { id: "q1" }, quote_id: "q2", parent_id: "p3" }))).toBe("q1");
    expect(replyTargetId(comment({ quote_id: "q2", parent_id: "p3" }))).toBe("q2");
    expect(replyTargetId(comment({ parent_id: "p3" }))).toBe("p3");
  });
  it("is null for a non-reply", () => {
    expect(replyTargetId(comment())).toBe(null);
    expect(replyTargetId(null)).toBe(null);
  });
});

describe("quotePreview", () => {
  it("extracts author name + body from comment.quote", () => {
    expect(quotePreview(comment({ quote: { id: "q", body: "the AMZN take", author: { name: "Fiona" } } }))).toEqual({
      author: "Fiona",
      body: "the AMZN take",
    });
  });
  it("falls back to 'Reply' when the quote has no author name", () => {
    expect(quotePreview(comment({ quote: { body: "x" } }))).toEqual({ author: "Reply", body: "x" });
  });
  it("is null when there is no quote", () => {
    expect(quotePreview(comment())).toBe(null);
    expect(quotePreview(comment({ quote: {} }))).toBe(null);
  });
});

describe("formatMessageForTelegram — quote blockquote (includeQuote)", () => {
  const reply = comment({
    author: { id: 9, name: "TDV2020" },
    body: "I am surprised Trendspider missed the rebalance.",
    quote: { id: "fq", body: "AMZN Amazon — record volume.", author: { name: "Fiona" } },
  });
  it("prepends an escaped <blockquote> when includeQuote is true", () => {
    const { text } = formatMessageForTelegram(reply, { includeQuote: true });
    expect(text).toBe(
      "<blockquote><b>Fiona</b>\nAMZN Amazon — record volume.</blockquote>\n<b>TDV2020</b>\nI am surprised Trendspider missed the rebalance."
    );
  });
  it("omits the blockquote when includeQuote is false (native reply will carry it)", () => {
    const { text } = formatMessageForTelegram(reply, { includeQuote: false });
    expect(text).not.toContain("<blockquote>");
    expect(text).toBe("<b>TDV2020</b>\nI am surprised Trendspider missed the rebalance.");
  });
  it("default (no opts) omits the blockquote", () => {
    expect(formatMessageForTelegram(reply).text).not.toContain("<blockquote>");
  });
  it("stays under 4096 and entity-safe with a huge quoted body", () => {
    const big = formatMessageForTelegram(
      comment({ body: "z".repeat(5000), quote: { id: "q", body: "&".repeat(5000), author: { name: "A" } } }),
      { includeQuote: true }
    );
    expect(big.text.length).toBeLessThanOrEqual(4096);
    expect(hasPartialEntity(big.text)).toBe(false);
  });
});

describe("sessionBannerText", () => {
  it("renders a bold dated banner", () => {
    expect(sessionBannerText("June 28, 2026")).toBe("<b>—— Start of Substack chat · June 28, 2026 ——</b>");
  });
  it("escapes the date string defensively", () => {
    expect(sessionBannerText("<b>x</b>")).toBe("<b>—— Start of Substack chat · &lt;b&gt;x&lt;/b&gt; ——</b>");
  });
});

describe("textForPostBack", () => {
  it("returns trimmed text for a normal message", () => {
    expect(textForPostBack("  hello world  ")).toBe("hello world");
  });
  it("skips empty / whitespace-only", () => {
    expect(textForPostBack("")).toBe(null);
    expect(textForPostBack("   ")).toBe(null);
    expect(textForPostBack(null)).toBe(null);
    expect(textForPostBack(undefined)).toBe(null);
  });
  it("skips slash commands (so /start never leaks into the Substack thread)", () => {
    expect(textForPostBack("/start")).toBe(null);
    expect(textForPostBack("  /help me")).toBe(null);
  });
  it("preserves a message that merely contains a slash", () => {
    expect(textForPostBack("see a/b testing")).toBe("see a/b testing");
  });
});

describe("mapTelegramReaction (grounded in REACTION_EMOJI)", () => {
  it("maps common Telegram reactions to real Substack names", () => {
    expect(mapTelegramReaction("👍")).toBe("thumbs_up");
    expect(mapTelegramReaction("🔥")).toBe("fire");
    expect(mapTelegramReaction("🚀")).toBe("rocket");
    expect(mapTelegramReaction("👀")).toBe("eyes");
  });
  it("matches a heart with or without the variation selector", () => {
    expect(mapTelegramReaction("❤️")).toBe("red_heart");
    expect(mapTelegramReaction("❤")).toBe("red_heart");
  });
  it("returns null for an unmapped emoji (fail safe — caller skips)", () => {
    expect(mapTelegramReaction("notanemoji")).toBe(null);
    expect(mapTelegramReaction("")).toBe(null);
    expect(mapTelegramReaction(null)).toBe(null);
  });
});
