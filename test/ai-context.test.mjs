// Unit tests for lib/ai-context.js — pure formatting helpers that turn a
// filtered slice of chat comments into an LLM-friendly context string
// plus the system + user prompts for the one-click "AI Insights" preview.

import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  formatMessagesForLLM,
  buildSystemPrompt,
  buildPreviewUserMessage,
  buildAskSystemPrompt,
  buildAskUserMessage,
  parseAskSections,
  ASK_DEFAULT_BUDGET_CHARS,
  ASK_FORMAT_INSTRUCTIONS,
  DEFAULT_LENS_HINT,
  DEFAULT_FORMAT_TEMPLATE,
} from "../lib/ai-context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a Date and assert the local HH:MM string we expect formatTimestamp
// to emit. We anchor on local time because formatTimestamp uses
// d.getHours()/getMinutes() (i.e. host-local), and CI / dev machines may
// run in different zones.
function localHHMM(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function makeComment(id, isoOrOffsetMs, body, author) {
  return {
    id,
    author: author === undefined ? { name: "Alice" } : author,
    body,
    created_at:
      typeof isoOrOffsetMs === "number"
        ? new Date(isoOrOffsetMs).toISOString()
        : isoOrOffsetMs,
  };
}

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe("formatTimestamp", () => {
  it("formats HH:MM by default", () => {
    const iso = "2026-06-06T12:34:00Z";
    const out = formatTimestamp(iso);
    expect(out).toMatch(/^\d{2}:\d{2}$/);
    expect(out).toBe(localHHMM(iso));
  });

  it("formats with date prefix when showDate: true", () => {
    const iso = "2026-06-05T09:00:00Z";
    const out = formatTimestamp(iso, { showDate: true });
    // "MMM D HH:MM" — month short name, day, then HH:MM. We assert the
    // shape and the HH:MM tail, not the exact month/day, because both
    // depend on the host's local timezone.
    expect(out).toMatch(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}$/
    );
    expect(out.endsWith(localHHMM(iso))).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(formatTimestamp("")).toBe("");
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp(undefined)).toBe("");
  });

  it("returns raw input when parsing fails", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatTimestamp("garbage-xyz")).toBe("garbage-xyz");
  });
});

// ---------------------------------------------------------------------------
// formatMessagesForLLM — happy path
// ---------------------------------------------------------------------------

describe("formatMessagesForLLM happy path", () => {
  it("returns 'no messages' marker for empty input", () => {
    const a = formatMessagesForLLM([]);
    expect(a).toEqual({
      context: "(no messages in current view)",
      included: 0,
      dropped: 0,
    });
    const b = formatMessagesForLLM(null);
    expect(b.context).toBe("(no messages in current view)");
    expect(b.included).toBe(0);
    expect(b.dropped).toBe(0);
  });

  it("formats single-day messages without date prefix", () => {
    const t0 = "2026-06-06T12:00:00Z";
    const t1 = "2026-06-06T12:01:00Z";
    const t2 = "2026-06-06T12:02:00Z";
    const comments = [
      makeComment("a", t0, "first", { name: "Alice" }),
      makeComment("b", t1, "second", { name: "Bob" }),
      makeComment("c", t2, "third", { name: "Carol" }),
    ];
    const out = formatMessagesForLLM(comments);
    expect(out.included).toBe(3);
    expect(out.dropped).toBe(0);
    const lines = out.context.split("\n");
    expect(lines).toHaveLength(3);
    // Each line: "[HH:MM] Name: body" — no date prefix.
    expect(lines[0]).toBe(`[${localHHMM(t0)}] Alice: first`);
    expect(lines[1]).toBe(`[${localHHMM(t1)}] Bob: second`);
    expect(lines[2]).toBe(`[${localHHMM(t2)}] Carol: third`);
    // Sanity: no comma-month tokens leaked into single-day output.
    expect(out.context).not.toMatch(
      /\[(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /
    );
  });

  it("formats multi-day messages with date prefix", () => {
    const t0 = "2026-06-05T09:00:00Z";
    const t1 = "2026-06-06T10:00:00Z";
    const comments = [
      makeComment("a", t0, "yesterday", { name: "Alice" }),
      makeComment("b", t1, "today", { name: "Bob" }),
    ];
    const out = formatMessagesForLLM(comments);
    expect(out.included).toBe(2);
    expect(out.dropped).toBe(0);
    const lines = out.context.split("\n");
    expect(lines).toHaveLength(2);
    // Each line starts with "[Mmm D HH:MM] Author: body".
    const datePrefix =
      /^\[(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}\] /;
    expect(lines[0]).toMatch(datePrefix);
    expect(lines[1]).toMatch(datePrefix);
    expect(lines[0]).toContain(" Alice: yesterday");
    expect(lines[1]).toContain(" Bob: today");
  });

  it("collapses newlines in body to ' · '", () => {
    const t0 = "2026-06-06T12:00:00Z";
    const out = formatMessagesForLLM([
      makeComment("a", t0, "line one\nline two", { name: "Alice" }),
    ]);
    expect(out.context).toBe(`[${localHHMM(t0)}] Alice: line one · line two`);
  });

  it("returns included count matching input length", () => {
    const base = Date.UTC(2026, 5, 6, 12, 0, 0);
    const comments = Array.from({ length: 5 }, (_, i) =>
      makeComment(`m${i}`, base + i * 60_000, `body ${i}`, { name: "Alice" })
    );
    const out = formatMessagesForLLM(comments);
    expect(out.included).toBe(comments.length);
    expect(out.dropped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatMessagesForLLM — truncation
// ---------------------------------------------------------------------------

describe("formatMessagesForLLM truncation", () => {
  it("drops oldest when total exceeds budget", () => {
    const base = Date.UTC(2026, 5, 6, 12, 0, 0);
    // 10 messages, each body ~200 chars. With the "[HH:MM] Alice: " prefix
    // each line is well over 200 chars; total >> 800 char budget.
    const bigBody = "x".repeat(200);
    const comments = Array.from({ length: 10 }, (_, i) =>
      makeComment(`m${i}`, base + i * 60_000, `${i}-${bigBody}`, {
        name: "Alice",
      })
    );
    const out = formatMessagesForLLM(comments, { budget: 800 });
    expect(out.dropped).toBeGreaterThan(0);
    expect(out.included).toBe(comments.length - out.dropped);
    expect(out.context.startsWith(
      "[earlier messages omitted to fit the context window]"
    )).toBe(true);
    // Result should fit the budget OR be a single line we couldn't shrink
    // further (the loop stops at length 1).
    if (out.included > 1) {
      expect(out.context.length).toBeLessThanOrEqual(800);
    }
  });

  it("preserves at least one line even at very tight budget", () => {
    const base = Date.UTC(2026, 5, 6, 12, 0, 0);
    const bigBody = "y".repeat(500);
    const comments = Array.from({ length: 6 }, (_, i) =>
      makeComment(`m${i}`, base + i * 60_000, `${i}-${bigBody}`, {
        name: "Alice",
      })
    );
    // Budget far smaller than even one line — loop must stop before
    // emptying the buffer.
    const out = formatMessagesForLLM(comments, { budget: 10 });
    expect(out.included).toBeGreaterThanOrEqual(1);
    expect(out.dropped).toBe(comments.length - out.included);
    // Truncation marker must still be present since something was dropped.
    expect(out.context).toContain(
      "[earlier messages omitted to fit the context window]"
    );
  });

  it("returns dropped: 0 when within budget", () => {
    const base = Date.UTC(2026, 5, 6, 12, 0, 0);
    const comments = Array.from({ length: 3 }, (_, i) =>
      makeComment(`m${i}`, base + i * 60_000, "short", { name: "Alice" })
    );
    const out = formatMessagesForLLM(comments, { budget: 10_000 });
    expect(out.dropped).toBe(0);
    expect(out.included).toBe(3);
    expect(out.context).not.toContain(
      "[earlier messages omitted to fit the context window]"
    );
  });
});

// ---------------------------------------------------------------------------
// Author fallback
// ---------------------------------------------------------------------------

describe("formatMessagesForLLM author fallback", () => {
  const t0 = "2026-06-06T12:00:00Z";

  it("uses author.name when present", () => {
    const out = formatMessagesForLLM([
      makeComment("a", t0, "hi", { name: "Alice", handle: "alice-h" }),
    ]);
    expect(out.context).toBe(`[${localHHMM(t0)}] Alice: hi`);
  });

  it("falls back to author.handle when name absent", () => {
    const out = formatMessagesForLLM([
      makeComment("a", t0, "hi", { handle: "alice-h" }),
    ]);
    expect(out.context).toBe(`[${localHHMM(t0)}] alice-h: hi`);
  });

  it("uses 'Unknown' when author is null or missing", () => {
    const outNull = formatMessagesForLLM([
      makeComment("a", t0, "hi", null),
    ]);
    expect(outNull.context).toBe(`[${localHHMM(t0)}] Unknown: hi`);

    // author key entirely absent on the object.
    const bareComment = { id: "b", body: "hi", created_at: t0 };
    const outMissing = formatMessagesForLLM([bareComment]);
    expect(outMissing.context).toBe(`[${localHHMM(t0)}] Unknown: hi`);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  const ctx = "[12:00] Alice: hello world";

  it("includes the context string", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain(ctx);
  });

  it("uses the trading-flavored lens hint by default", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain(DEFAULT_LENS_HINT);
    expect(prompt).toContain(
      "financial / markets / trading group chat"
    );
  });

  it("produces a different prompt when lensHint is overridden", () => {
    const defaultPrompt = buildSystemPrompt(ctx);
    const custom = buildSystemPrompt(ctx, {
      lensHint: "This is a book club discussing 19th-century Russian novels.",
    });
    expect(custom).not.toBe(defaultPrompt);
    expect(custom).toContain("19th-century Russian novels");
    expect(custom).not.toContain(
      "financial / markets / trading group chat"
    );
  });

  it("uses the default format template by default", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain(DEFAULT_FORMAT_TEMPLATE);
  });

  it("produces a different prompt when formatTemplate is overridden", () => {
    const custom = buildSystemPrompt(ctx, {
      formatTemplate:
        "Reply in a single haiku. Nothing else. No preamble, no analysis.",
    });
    expect(custom).toContain("single haiku");
    expect(custom).not.toContain("Themes");
    expect(custom).not.toContain("Notable trades");
  });

  it("falls back to defaults when lensHint or formatTemplate is empty / whitespace", () => {
    const a = buildSystemPrompt(ctx, { lensHint: "   ", formatTemplate: "" });
    const b = buildSystemPrompt(ctx);
    expect(a).toBe(b);
  });

  it("focused-author perspective hint is independent of lensHint", () => {
    const prompt = buildSystemPrompt(ctx, {
      lensHint: "Book club chat about Tolstoy.",
      focusedAuthor: "Anna",
    });
    expect(prompt).toContain("Book club");
    expect(prompt).toContain("third person");
    expect(prompt).toMatch(/anna/i);
  });

  it("includes the focused-author perspective hint when focusedAuthor is set", () => {
    const prompt = buildSystemPrompt(ctx, { focusedAuthor: "Jordan" });
    // Case-insensitive: prompt should reference Jordan's viewpoint via
    // one of the canonical phrasings.
    expect(prompt).toMatch(/in jordan's view|jordan thinks/i);
    // And it should explicitly call out the third-person framing.
    expect(prompt).toContain("third person");
  });

  it("omits the perspective hint when focusedAuthor is missing", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("third person");
  });

  it("trims focusedAuthor and treats empty string as missing", () => {
    const prompt = buildSystemPrompt(ctx, { focusedAuthor: "   " });
    expect(prompt).not.toContain("third person");
  });
});

// ---------------------------------------------------------------------------
// buildPreviewUserMessage
// ---------------------------------------------------------------------------

describe("buildPreviewUserMessage", () => {
  it("returns a non-empty string", () => {
    const msg = buildPreviewUserMessage();
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });
  it("defaults to the base prompt with no variant suffix", () => {
    const msg = buildPreviewUserMessage();
    expect(msg).toBe("Give me the insights summary for this conversation.");
  });
  it("concise variant appends a tightness instruction", () => {
    const msg = buildPreviewUserMessage({ variant: "concise" });
    expect(msg).toMatch(/insights summary/i);
    expect(msg.toLowerCase()).toMatch(/tight|bullet|headline/);
    expect(msg.length).toBeGreaterThan(60);
  });
  it("elaborate variant appends a depth instruction", () => {
    const msg = buildPreviewUserMessage({ variant: "elaborate" });
    expect(msg).toMatch(/insights summary/i);
    expect(msg.toLowerCase()).toMatch(/thorough|quote|caveat/);
    expect(msg.length).toBeGreaterThan(80);
  });
  it("unknown variant falls back to the base prompt", () => {
    const msg = buildPreviewUserMessage({ variant: "garbage" });
    expect(msg).toBe("Give me the insights summary for this conversation.");
  });
  it("concise and elaborate produce distinct strings", () => {
    const a = buildPreviewUserMessage({ variant: "concise" });
    const b = buildPreviewUserMessage({ variant: "elaborate" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Reply / quote linkage — the attribution fix
// ---------------------------------------------------------------------------

describe("formatMessagesForLLM — reply/quote linkage", () => {
  it("annotates a quote-reply with the quoted author + snippet", () => {
    const comments = [
      {
        id: 1, author: { name: "Bsmalls72" },
        body: "The one that's shocking to me is Pltr. New highs before summer.",
        created_at: "2026-06-08T12:00:00Z",
      },
      {
        id: 2, author: { name: "Za" },
        body: "I'll be out if it hits my cost. Very disappointing action",
        created_at: "2026-06-08T12:01:00Z",
        quote: {
          id: 1, author: { name: "Bsmalls72" },
          body: "The one that's shocking to me is Pltr. New highs before summer.",
        },
      },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).toContain(
      'Za (replying to Bsmalls72: "The one that\'s shocking to me is Pltr'
    );
    expect(context).toContain("I'll be out if it hits my cost");
  });

  it("resolves a threaded reply (parent_id) against the slice when no inline quote", () => {
    const comments = [
      { id: "a", author: { name: "Bsmalls72" }, body: "Pltr new highs before summer", created_at: "2026-06-08T12:00:00Z" },
      { id: "b", author: { name: "Za" }, body: "I'll be out if it hits my cost", created_at: "2026-06-08T12:01:00Z", parent_id: "a" },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).toContain('Za (replying to Bsmalls72: "Pltr new highs before summer")');
  });

  it("names the quoted author even with no quote body, no empty quotes", () => {
    const comments = [
      { id: 2, author: { name: "Za" }, body: "agreed", created_at: "2026-06-08T12:01:00Z", quote: { author: { name: "Bsmalls72" } } },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).toContain("Za (replying to Bsmalls72):");
    expect(context).not.toContain('replying to Bsmalls72: ""');
  });

  it("caps the quoted snippet at 120 chars with an ellipsis", () => {
    const longBody = "x".repeat(200);
    const comments = [
      { id: 2, author: { name: "Za" }, body: "ok", created_at: "2026-06-08T12:00:00Z", quote: { author: { name: "P" }, body: longBody } },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).toContain("x".repeat(120) + "…");
    expect(context).not.toContain("x".repeat(121));
  });

  it("leaves a non-reply message as plain [time] Author: body (backward compatible)", () => {
    const comments = [
      { id: 1, author: { name: "Za" }, body: "This is big for RDDT", created_at: "2026-06-08T12:00:00Z" },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).toMatch(/^\[\d{2}:\d{2}\] Za: This is big for RDDT$/);
    expect(context).not.toContain("replying to");
  });
});

// ---------------------------------------------------------------------------
// Reaction signal
// ---------------------------------------------------------------------------

describe("formatMessagesForLLM — reaction summary", () => {
  it("appends a compact reaction tag (REST numeric shape)", () => {
    const comments = [
      { id: 1, author: { name: "Za" }, body: "mega bear flipping bullish", created_at: "2026-06-08T12:00:00Z", reactions: { thumbs_up: 2, red_heart: 1 } },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).toContain("[reactions: 👍×2 ❤️×1]");
  });

  it("reads the WS {count} shape and skips zero counts", () => {
    const comments = [
      { id: 1, author: { name: "Za" }, body: "x", created_at: "2026-06-08T12:00:00Z", reactions: { fire: { count: 3 }, skull: { count: 0 } } },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).toContain("[reactions: 🔥×3]");
    expect(context).not.toContain("skull");
  });

  it("emits no reaction tag when there are none", () => {
    const comments = [
      { id: 1, author: { name: "Za" }, body: "x", created_at: "2026-06-08T12:00:00Z", reactions: {} },
    ];
    const { context } = formatMessagesForLLM(comments);
    expect(context).not.toContain("[reactions:");
  });
});

// ---------------------------------------------------------------------------
// Regression — the NVTS/PLTR misattribution (real captured transcript)
// ---------------------------------------------------------------------------

describe("regression — Za's PLTR exit must not read as RDDT", () => {
  it("links the exit comment to Bsmalls72's PLTR message, not Za's earlier RDDT message", () => {
    const comments = [
      { id: 1, author: { name: "Za" }, body: "This is big for RDDT. Cleveland research became very negative on Reddit near the top at 280.", created_at: "2026-06-08T08:00:00Z" },
      { id: 2, author: { name: "Za" }, body: "Mega bear flipping bullish. Think that's why the reaction is so strong", created_at: "2026-06-08T08:01:00Z", reactions: { thumbs_up: 1 } },
      { id: 3, author: { name: "Bsmalls72" }, body: "The one that's shocking to me is Pltr. I got in it before that move to $160. New highs before end of summer", created_at: "2026-06-08T08:02:00Z" },
      { id: 4, author: { name: "Za" }, body: "I'll be out if it hits my cost. Very disappointing action", created_at: "2026-06-08T08:03:00Z",
        quote: { id: 3, author: { name: "Bsmalls72" }, body: "The one that's shocking to me is Pltr. I got in it before that move to $160. New highs before end of summer" } },
    ];
    const { context } = formatMessagesForLLM(comments);
    const exitLine = context.split("\n").find((l) => l.includes("I'll be out if it hits my cost"));
    expect(exitLine).toBeTruthy();
    // The disambiguating signal the model needs is now present in the line.
    expect(exitLine).toContain("replying to Bsmalls72");
    expect(exitLine).toContain("Pltr");
    // ...and the pre-fix failure mode is gone: the exit line must NOT carry
    // Za's earlier, unrelated RDDT topic that the model used to latch onto.
    expect(exitLine).not.toContain("RDDT");
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt — anti-misattribution guidance
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — reading guidance", () => {
  it("includes the reply-attribution rule", () => {
    const p = buildSystemPrompt("[12:00] A: hi");
    expect(p).toContain("replying to X");
    expect(p).toContain("NOT to the speaker's own earlier messages");
  });
  it("warns against carrying a ticker from an earlier unrelated message", () => {
    const p = buildSystemPrompt("[12:00] A: hi");
    expect(p).toContain("Never carry a ticker over from an earlier, unrelated message");
  });
});

// ---------------------------------------------------------------------------
// buildAskSystemPrompt — free-form Q&A grounded in the chat
// ---------------------------------------------------------------------------

describe("buildAskSystemPrompt", () => {
  it("embeds the chat context between fence markers", () => {
    const p = buildAskSystemPrompt("[12:00] A: hello");
    expect(p).toContain("CHAT CONTEXT (oldest → newest):");
    expect(p).toContain("[12:00] A: hello");
  });

  it("includes the 3-section format instructions", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi");
    expect(p).toContain("**From the chat**");
    expect(p).toContain("**From the web**");
    expect(p).toContain("**Synthesis**");
  });

  it("embeds the same instruction block exported as ASK_FORMAT_INSTRUCTIONS", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi");
    expect(p).toContain(ASK_FORMAT_INSTRUCTIONS);
  });

  it("with webSearchEnabled:true tells the model it has a web_search tool", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi", { webSearchEnabled: true });
    expect(p).toContain("web_search tool");
    expect(p).toContain("ONLY when the chat alone cannot answer");
    // Should NOT instruct it to refuse web lookups.
    expect(p).not.toMatch(/do NOT have access to web search/);
  });

  it("with webSearchEnabled:false tells the model to stay strictly in-chat", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi", { webSearchEnabled: false });
    expect(p).toContain("do NOT have access to web search");
    expect(p).toContain("do NOT invent facts from your training data");
  });

  it("defaults to the trading lens hint when lensHint omitted", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi");
    expect(p).toContain(DEFAULT_LENS_HINT);
  });

  it("uses a custom lens hint when provided", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi", {
      lensHint: "This is a Substack writers' room. Focus on craft and editorial decisions.",
    });
    expect(p).toContain("Substack writers' room");
    expect(p).not.toContain(DEFAULT_LENS_HINT);
  });

  it("preserves the same reply-attribution rule used in summary mode", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi");
    expect(p).toContain("replying to X");
    expect(p).toContain("NOT to the speaker's own earlier messages");
  });

  it("tells the model to say so when the chat can't answer (no fabricating)", () => {
    const p = buildAskSystemPrompt("[12:00] A: hi");
    expect(p).toContain("don't fabricate");
  });
});

describe("buildAskUserMessage", () => {
  it("returns the trimmed question", () => {
    expect(buildAskUserMessage("  what's the thesis on CRWV?  ")).toBe(
      "what's the thesis on CRWV?"
    );
  });
  it("returns empty string for nullish input (caller catches before submit)", () => {
    expect(buildAskUserMessage(null)).toBe("");
    expect(buildAskUserMessage(undefined)).toBe("");
    expect(buildAskUserMessage("")).toBe("");
  });
});

describe("ASK_DEFAULT_BUDGET_CHARS", () => {
  it("is generous enough that Anthropic 200K fits whole chat", () => {
    // 200K tokens ≈ 800K chars at 4 chars/token. Budget at 750K leaves
    // ~50K char headroom for the system prompt + response. Tight lower
    // bound at 700K guards against an accidental reduction landing the
    // budget below OpenAI's 128K (512K chars) cliff and reading as "fits."
    expect(ASK_DEFAULT_BUDGET_CHARS).toBeGreaterThan(700_000);
    expect(ASK_DEFAULT_BUDGET_CHARS).toBeLessThan(900_000);
  });
});

// ---------------------------------------------------------------------------
// parseAskSections — extract the model's 3-section response
// ---------------------------------------------------------------------------

describe("parseAskSections", () => {
  it("extracts all three sections from a well-formatted response", () => {
    const text = `**From the chat**
Za said CRWV looks strong above 220.

**From the web**
Per Reuters, CRWV closed at 224 yesterday.

**Synthesis**
Both sources align: above 220 is the bull case.`;
    const r = parseAskSections(text);
    expect(r.fromChat).toBe("Za said CRWV looks strong above 220.");
    expect(r.fromWeb).toBe("Per Reuters, CRWV closed at 224 yesterday.");
    expect(r.synthesis).toBe("Both sources align: above 220 is the bull case.");
    expect(r.preamble).toBe("");
  });

  it("tolerates a trailing colon after the section header", () => {
    const text = `**From the chat**:
Za said CRWV looks strong.

**Synthesis**:
Watch 220.`;
    const r = parseAskSections(text);
    expect(r.fromChat).toBe("Za said CRWV looks strong.");
    expect(r.synthesis).toBe("Watch 220.");
  });

  it("tolerates an em-dash after the section header", () => {
    const text = `**From the chat** — Za said CRWV looks strong.\n\n**Synthesis** — Watch 220.`;
    const r = parseAskSections(text);
    expect(r.fromChat).toBe("Za said CRWV looks strong.");
    expect(r.synthesis).toBe("Watch 220.");
  });

  it("is case-insensitive on the header text", () => {
    const text = `**FROM THE CHAT**\nZa said.\n\n**synthesis**\nBuy.`;
    const r = parseAskSections(text);
    expect(r.fromChat).toBe("Za said.");
    expect(r.synthesis).toBe("Buy.");
  });

  it("returns empty strings for sections the model omitted", () => {
    const text = `**From the chat**\nZa said CRWV looks strong.`;
    const r = parseAskSections(text);
    expect(r.fromChat).toBe("Za said CRWV looks strong.");
    expect(r.fromWeb).toBe("");
    expect(r.synthesis).toBe("");
  });

  it("captures a preamble before the first section header", () => {
    const text = `Quick take on your question:\n\n**From the chat**\nZa said yes.`;
    const r = parseAskSections(text);
    expect(r.preamble).toBe("Quick take on your question:");
    expect(r.fromChat).toBe("Za said yes.");
  });

  it("treats an entirely format-less response as a preamble", () => {
    const text = `The chat doesn't have enough information to answer that question.`;
    const r = parseAskSections(text);
    expect(r.preamble).toBe(text);
    expect(r.fromChat).toBe("");
    expect(r.fromWeb).toBe("");
    expect(r.synthesis).toBe("");
  });

  it("returns an all-empty result for null / empty input", () => {
    expect(parseAskSections(null)).toEqual({
      preamble: "", fromChat: "", fromWeb: "", synthesis: "",
    });
    expect(parseAskSections("")).toEqual({
      preamble: "", fromChat: "", fromWeb: "", synthesis: "",
    });
    expect(parseAskSections(undefined)).toEqual({
      preamble: "", fromChat: "", fromWeb: "", synthesis: "",
    });
  });

  it("preserves markdown inside section bodies (bullets, bold)", () => {
    const text = `**From the chat**
- **Za** said CRWV looks strong
- **Mike** is bearish below 215

**Synthesis**
Range is 215-225.`;
    const r = parseAskSections(text);
    expect(r.fromChat).toContain("- **Za** said CRWV looks strong");
    expect(r.fromChat).toContain("- **Mike** is bearish below 215");
    expect(r.synthesis).toBe("Range is 215-225.");
  });

  it("handles a response where the model only used Synthesis", () => {
    const text = `**Synthesis**\nNo chat coverage of this; treat as out-of-scope.`;
    const r = parseAskSections(text);
    expect(r.synthesis).toBe("No chat coverage of this; treat as out-of-scope.");
    expect(r.fromChat).toBe("");
    expect(r.fromWeb).toBe("");
  });
});
