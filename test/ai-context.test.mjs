// Unit tests for lib/ai-context.js — pure formatting helpers that turn a
// filtered slice of chat comments into an LLM-friendly context string
// plus the system + user prompts for the one-click "AI Insights" preview.

import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  formatMessagesForLLM,
  buildSystemPrompt,
  buildPreviewUserMessage,
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

  it("uses 'trading' lens by default", () => {
    const prompt = buildSystemPrompt(ctx);
    // Trading lens hint is specific and unmistakable.
    expect(prompt).toContain(
      "financial / markets / trading group chat"
    );
  });

  it("produces a different prompt when lens is overridden", () => {
    const trading = buildSystemPrompt(ctx, { lens: "trading" });
    const neutral = buildSystemPrompt(ctx, { lens: "neutral" });
    expect(neutral).not.toBe(trading);
    expect(neutral).toContain("Read the conversation neutrally");
    expect(neutral).not.toContain(
      "financial / markets / trading group chat"
    );
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
});
