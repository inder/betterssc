// Mention autocomplete tests (commit 4 of v0.2 write side).
//
// Covers the two pure helpers — findActiveMentionToken (cursor-aware token
// extraction) and replaceMentionToken (insert + cursor placement) — plus
// end-to-end "select from dropdown → buildCommentBody produces correct
// payload" composition.

import { describe, it, expect } from "vitest";
import {
  findActiveMentionToken,
  replaceMentionToken,
  buildCommentBody,
} from "../lib/compose.js";

describe("findActiveMentionToken — happy path", () => {
  it("finds an @-token when cursor is at the end of it", () => {
    expect(findActiveMentionToken("hello @bo", 9)).toEqual({
      query: "bo",
      start: 6,
      end: 9,
    });
  });

  it("finds an @-token at the very start of the buffer", () => {
    expect(findActiveMentionToken("@al", 3)).toEqual({
      query: "al",
      start: 0,
      end: 3,
    });
  });

  it("returns empty query when only `@` has been typed", () => {
    expect(findActiveMentionToken("hi @", 4)).toEqual({
      query: "",
      start: 3,
      end: 4,
    });
  });

  it("finds the token even when cursor is in the middle of it", () => {
    // cursor between 'b' and 'o' in '@bo'
    expect(findActiveMentionToken("hi @bo", 5)).toEqual({
      query: "b",
      start: 3,
      end: 5,
    });
  });
});

describe("findActiveMentionToken — negative cases", () => {
  it("returns null when there's no @ before the cursor", () => {
    expect(findActiveMentionToken("just text here", 5)).toBeNull();
  });

  it("returns null when whitespace separates @ from cursor", () => {
    // user typed '@bo ' then 'hi' — cursor is past a space, not in a mention.
    expect(findActiveMentionToken("hi @bo there", 10)).toBeNull();
  });

  it("does NOT match an @ embedded in another word (e.g. email)", () => {
    // 'me@example' — the @ is preceded by 'e', not whitespace/start.
    expect(findActiveMentionToken("me@example", 10)).toBeNull();
  });

  it("tolerates out-of-range cursor positions", () => {
    expect(findActiveMentionToken("hi", -3)).toBeNull();
    expect(findActiveMentionToken("hi @b", 999)).toEqual({
      query: "b",
      start: 3,
      end: 5,
    });
  });

  it("returns null for null text", () => {
    expect(findActiveMentionToken(null, 0)).toBeNull();
  });
});

describe("replaceMentionToken", () => {
  it("replaces the @-fragment with @displayName + trailing space", () => {
    const out = replaceMentionToken("hi @bo", { start: 3, end: 6 }, "Boz");
    expect(out.text).toBe("hi @Boz ");
    expect(out.cursor).toBe(8); // just past the trailing space
  });

  it("inserts at start of buffer correctly", () => {
    const out = replaceMentionToken("@a", { start: 0, end: 2 }, "Alice");
    expect(out.text).toBe("@Alice ");
    expect(out.cursor).toBe(7);
  });

  it("preserves text on both sides of the token", () => {
    const out = replaceMentionToken(
      "hey @b how are you",
      { start: 4, end: 6 },
      "Bob"
    );
    expect(out.text).toBe("hey @Bob  how are you");
    expect(out.cursor).toBe(9); // "hey @Bob " ends at index 9
  });
});

describe("dropdown selection → buildCommentBody integration", () => {
  // This simulates the real flow: user types '@b', dropdown shows Boz +
  // Bob, user picks Boz. We then verify the buffer + mention map produce
  // the right payload.
  it("inserts @Boz and produces a correct payload at send time", () => {
    let buffer = "hey @b";
    const token = findActiveMentionToken(buffer, buffer.length);
    expect(token).not.toBeNull();
    const { text, cursor } = replaceMentionToken(buffer, token, "Boz");
    buffer = text;
    // Track the mention exactly as the composer would.
    const mentions = { "@Boz": { user_id: 2921680, text: "@Boz" } };
    // User keeps typing: " thanks"
    buffer += " thanks";
    // Cursor reference is no longer used for the payload — buildCommentBody
    // is a pure transform on (buffer, mentions).
    const payload = buildCommentBody(buffer, mentions);
    expect(payload.body).toBe("hey ${0}  thanks");
    expect(payload.mentions).toEqual({
      "0": { user_id: 2921680, text: "@Boz" },
    });
    void cursor;
  });

  it("two-user pick yields slots 0 and 1 in occurrence order", () => {
    let buffer = "";
    // Pick @Alice first
    buffer = "@";
    let t = findActiveMentionToken(buffer, 1);
    let r = replaceMentionToken(buffer, t, "Alice");
    buffer = r.text;
    const mentions = { "@Alice": { user_id: 100, text: "@Alice" } };
    buffer += "and @";
    t = findActiveMentionToken(buffer, buffer.length);
    r = replaceMentionToken(buffer, t, "Bob");
    buffer = r.text;
    mentions["@Bob"] = { user_id: 200, text: "@Bob" };
    const payload = buildCommentBody(buffer, mentions);
    expect(payload.body).toBe("${0} and ${1} ");
    expect(payload.mentions["0"]).toEqual({ user_id: 100, text: "@Alice" });
    expect(payload.mentions["1"]).toEqual({ user_id: 200, text: "@Bob" });
  });
});
