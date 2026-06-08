// Emoji-picker helper tests (v0.2 reactions picker).
//
// Covers three pure helpers behind the picker UI:
//   - topReactionsInChat — tally reaction counts across the loaded chat and
//     return the top-N reaction NAMES, deduped by rendered glyph, padded from
//     the default set so the "Frequently used" row is never empty.
//   - filterReactionsByQuery — free-text filter over REACTION_EMOJI names.
//   - groupedReactions — bucket REACTION_EMOJI into ordered labeled sections.

import { describe, it, expect } from "vitest";
import {
  topReactionsInChat,
  DEFAULT_SUGGESTED_REACTIONS,
} from "../lib/compose.js";
import {
  filterReactionsByQuery,
  groupedReactions,
  REACTION_EMOJI,
} from "../lib/emojis.js";

describe("topReactionsInChat — tallying", () => {
  it("sums counts across multiple comments and returns sorted desc", () => {
    const comments = [
      { reactions: { thumbs_up: 1, fire: 5 } },
      { reactions: { thumbs_up: 3, rocket: 2 } },
    ];
    // thumbs_up=4, fire=5, rocket=2 → fire, thumbs_up, rocket. n=3 so the
    // default-padding doesn't append extras past the three used reactions.
    expect(topReactionsInChat(comments, 3)).toEqual([
      "fire",
      "thumbs_up",
      "rocket",
    ]);
  });

  it("reads the REST numeric shape ({name: count})", () => {
    const comments = [{ reactions: { fire: 7 } }];
    expect(topReactionsInChat(comments, 1)).toEqual(["fire"]);
  });

  it("reads the WS object shape ({name: {count, has_reacted}})", () => {
    const comments = [
      { reactions: { fire: { count: 4, has_reacted: true } } },
    ];
    expect(topReactionsInChat(comments, 1)).toEqual(["fire"]);
  });

  it("sums mixed REST + WS shapes across comments", () => {
    const comments = [
      { reactions: { fire: 2 } },
      { reactions: { fire: { count: 3, has_reacted: false } } },
      { reactions: { rocket: { count: 10, has_reacted: true } } },
    ];
    // rocket=10, fire=5 → rocket, fire. n=2 so defaults don't pad past them.
    expect(topReactionsInChat(comments, 2)).toEqual(["rocket", "fire"]);
  });

  it("ignores zero, negative, and missing counts", () => {
    const comments = [
      { reactions: { fire: 0, rocket: -3, thumbs_up: 2 } },
      { reactions: { skull: { count: 0, has_reacted: false } } },
    ];
    // Only thumbs_up has a usable count; everything else padded from defaults.
    expect(topReactionsInChat(comments, 1)).toEqual(["thumbs_up"]);
  });

  it("skips comments with no reactions field", () => {
    const comments = [
      { body: "hi" },
      { reactions: null },
      { reactions: { fire: 4 } },
    ];
    expect(topReactionsInChat(comments, 1)).toEqual(["fire"]);
  });

  it("consumes a Map iterator (the real call-site shape)", () => {
    // app.js passes state.comments.values() — a live MapIterator, not an
    // array. Confirm for...of tallies its values (not [key, value] pairs).
    const comments = new Map([
      ["c1", { reactions: { fire: 2 } }],
      ["c2", { reactions: { fire: 3, rocket: 1 } }],
    ]);
    expect(topReactionsInChat(comments.values(), 2)).toEqual([
      "fire",
      "rocket",
    ]);
  });
});

describe("topReactionsInChat — fallback & dedupe", () => {
  it("falls back to DEFAULT_SUGGESTED_REACTIONS for a null comments array", () => {
    expect(topReactionsInChat(null)).toEqual(DEFAULT_SUGGESTED_REACTIONS);
  });

  it("falls back to DEFAULT_SUGGESTED_REACTIONS for an empty comments array", () => {
    expect(topReactionsInChat([])).toEqual(DEFAULT_SUGGESTED_REACTIONS);
  });

  it("dedupes by glyph so two names mapping to one emoji take one slot", () => {
    const glyphOf = (name) =>
      name === "thumbs_up" || name === "upvote" ? "👍" : name;
    const comments = [
      { reactions: { thumbs_up: 5, upvote: 3 } },
    ];
    const result = topReactionsInChat(comments, 8, glyphOf);
    // thumbs_up outranks upvote (5 > 3) and wins the single 👍 slot. The
    // remaining slots are padded from defaults, also deduped by glyph.
    expect(result.includes("thumbs_up")).toBe(true);
    expect(result.includes("upvote")).toBe(false);
    // No two output names share a glyph.
    const glyphs = result.map(glyphOf);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("pads from defaults without introducing duplicate glyphs when n exceeds available", () => {
    const comments = [{ reactions: { fire: 4 } }];
    const result = topReactionsInChat(comments, 8);
    expect(result[0]).toBe("fire");
    // fire is also a default — it must appear exactly once.
    expect(result.filter((r) => r === "fire").length).toBe(1);
    // Padded out to the full default set (which includes fire once).
    expect(result.length).toBe(DEFAULT_SUGGESTED_REACTIONS.length);
  });

  it("truncates to n when more reactions are available than requested", () => {
    const comments = [
      { reactions: { fire: 9, rocket: 8, thumbs_up: 7, skull: 6 } },
    ];
    expect(topReactionsInChat(comments, 2)).toEqual(["fire", "rocket"]);
  });

  it("never returns more than n entries", () => {
    const comments = [
      { reactions: { fire: 5, rocket: 4, thumbs_up: 3 } },
    ];
    for (const n of [1, 2, 3, 5]) {
      expect(topReactionsInChat(comments, n).length).toBeLessThanOrEqual(n);
    }
  });
});

describe("filterReactionsByQuery", () => {
  it("returns the full catalog for an empty query", () => {
    expect(filterReactionsByQuery("").length).toBe(
      Object.keys(REACTION_EMOJI).length
    );
  });

  it("returns the full catalog for a blank/whitespace query", () => {
    expect(filterReactionsByQuery("   ").length).toBe(
      Object.keys(REACTION_EMOJI).length
    );
  });

  it("filters by a substring term against the name", () => {
    const result = filterReactionsByQuery("fire");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(([name]) => name.includes("fire"))).toBe(true);
    expect(result.map(([name]) => name)).toContain("fire");
  });

  it("is case-insensitive", () => {
    expect(filterReactionsByQuery("FIRE")).toEqual(
      filterReactionsByQuery("fire")
    );
  });

  it("requires ALL whitespace-separated terms to match", () => {
    const names = filterReactionsByQuery("tears joy").map(([name]) => name);
    expect(names).toContain("face_with_tears_of_joy");
  });

  it("treats underscores and spaces as equivalent", () => {
    expect(filterReactionsByQuery("tears_joy")).toEqual(
      filterReactionsByQuery("tears joy")
    );
  });

  it("returns [] for a nonsense query", () => {
    expect(filterReactionsByQuery("zzzznotarealemoji")).toEqual([]);
  });

  it("returns 2-element [name, glyph] pairs", () => {
    const result = filterReactionsByQuery("fire");
    for (const item of result) {
      expect(Array.isArray(item)).toBe(true);
      expect(item.length).toBe(2);
      expect(typeof item[0]).toBe("string");
      expect(typeof item[1]).toBe("string");
    }
  });
});

describe("groupedReactions", () => {
  it("returns a non-empty array of groups", () => {
    const groups = groupedReactions();
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });

  it("gives every group a non-empty label and non-empty entries", () => {
    for (const g of groupedReactions()) {
      expect(typeof g.label).toBe("string");
      expect(g.label.length).toBeGreaterThan(0);
      expect(Array.isArray(g.entries)).toBe(true);
      expect(g.entries.length).toBeGreaterThan(0);
    }
  });

  it("preserves every emoji exactly once across all groups", () => {
    const total = groupedReactions().reduce(
      (sum, g) => sum + g.entries.length,
      0
    );
    expect(total).toBe(Object.keys(REACTION_EMOJI).length);
  });

  it("starts with the 'Smileys & Emotion' group", () => {
    expect(groupedReactions()[0].label).toBe("Smileys & Emotion");
  });

  it("has unique group labels", () => {
    const labels = groupedReactions().map((g) => g.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
