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
    expect(shouldForward(comment(), new Set(), 99)).toBe(true);
  });
  it("skips pending optimistic rows", () => {
    expect(shouldForward(comment({ _pending: true }), new Set(), 99)).toBe(false);
  });
  it("skips already-sent ids (idempotency)", () => {
    expect(shouldForward(comment({ id: "c1" }), new Set(["c1"]), 99)).toBe(false);
  });
  it("skips own messages when self id is known", () => {
    expect(shouldForward(comment({ author: { id: 7 } }), new Set(), 7)).toBe(false);
    expect(shouldForward(comment({ author: { id: 7 } }), new Set(), "7")).toBe(false);
  });
  it("does NOT skip on authorship when self id is unknown (fail toward forwarding)", () => {
    expect(shouldForward(comment({ author: { id: 7 } }), new Set(), null)).toBe(true);
    expect(shouldForward(comment({ author: { id: 7 } }), new Set(), undefined)).toBe(true);
  });
  it("rejects malformed comments", () => {
    expect(shouldForward(null, new Set(), 1)).toBe(false);
    expect(shouldForward({ body: "x" }, new Set(), 1)).toBe(false);
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
