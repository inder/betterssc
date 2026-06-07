// buildCommentBody — focused unit tests for commit 2 (Send message).
//
// Covers: plain text, single mention, multiple mentions, mention with no
// surrounding text, repeated mention of same user, mention map entries that
// don't appear in text (dropped), empty/null inputs.

import { describe, it, expect } from "vitest";
import { buildCommentBody } from "../lib/compose.js";

describe("buildCommentBody — plain text", () => {
  it("passes plain text through unchanged with empty mentions", () => {
    expect(buildCommentBody("just text", {})).toEqual({
      body: "just text",
      mentions: {},
    });
  });

  it("treats null mentions like empty", () => {
    expect(buildCommentBody("hi", null)).toEqual({ body: "hi", mentions: {} });
  });

  it("returns empty string body when text is null", () => {
    expect(buildCommentBody(null, null)).toEqual({ body: "", mentions: {} });
  });

  it("preserves whitespace and newlines verbatim", () => {
    expect(buildCommentBody("line one\nline two", {})).toEqual({
      body: "line one\nline two",
      mentions: {},
    });
  });
});

describe("buildCommentBody — single mention", () => {
  it("expands a single @mention into a ${0} slot", () => {
    const out = buildCommentBody("@Boz that's a good article. thanks for sharing.", {
      "@Boz": { user_id: 2921680 },
    });
    expect(out.body).toBe(
      "${0} that's a good article. thanks for sharing."
    );
    expect(out.mentions).toEqual({
      "0": { user_id: 2921680, text: "@Boz" },
    });
  });

  it("uses the explicit `text` field on the mention entry when present", () => {
    const out = buildCommentBody("hello @bo", {
      "@bo": { user_id: 99, text: "@Boz" },
    });
    expect(out.body).toBe("hello ${0}");
    expect(out.mentions["0"]).toEqual({ user_id: 99, text: "@Boz" });
  });

  it("handles a mention with no surrounding text", () => {
    const out = buildCommentBody("@Boz", { "@Boz": { user_id: 1 } });
    expect(out.body).toBe("${0}");
    expect(out.mentions).toEqual({ "0": { user_id: 1, text: "@Boz" } });
  });

  it("supports userId field as well as user_id", () => {
    const out = buildCommentBody("@bo", { "@bo": { userId: 42 } });
    expect(out.mentions["0"]).toEqual({ user_id: 42, text: "@bo" });
  });
});

describe("buildCommentBody — multiple mentions", () => {
  it("renumbers mentions left-to-right by first occurrence", () => {
    // @Alice appears first, @Bob second — slots 0 and 1 in that order.
    const out = buildCommentBody("hey @Alice and @Bob, look", {
      "@Bob": { user_id: 200 },
      "@Alice": { user_id: 100 },
    });
    expect(out.body).toBe("hey ${0} and ${1}, look");
    expect(out.mentions["0"]).toEqual({ user_id: 100, text: "@Alice" });
    expect(out.mentions["1"]).toEqual({ user_id: 200, text: "@Bob" });
  });

  it("collapses repeated references to the same user into one slot", () => {
    const out = buildCommentBody("@Boz again @Boz", {
      "@Boz": { user_id: 7 },
    });
    expect(out.body).toBe("${0} again ${0}");
    expect(out.mentions).toEqual({ "0": { user_id: 7, text: "@Boz" } });
  });

  it("drops mention map entries that don't appear in the text", () => {
    const out = buildCommentBody("hi @Alice", {
      "@Alice": { user_id: 1 },
      "@Stale": { user_id: 999 },
    });
    expect(out.body).toBe("hi ${0}");
    expect(out.mentions).toEqual({ "0": { user_id: 1, text: "@Alice" } });
  });
});

describe("buildCommentBody — edge cases", () => {
  it("does not match malformed mention map keys (no leading @)", () => {
    const out = buildCommentBody("hi bo", { "bo": { user_id: 1 } });
    expect(out).toEqual({ body: "hi bo", mentions: {} });
  });

  it("does not match entries with no user_id", () => {
    const out = buildCommentBody("hi @bo", { "@bo": { name: "Bo" } });
    expect(out).toEqual({ body: "hi @bo", mentions: {} });
  });

  it("matches at the very start of the buffer", () => {
    const out = buildCommentBody("@Boz hello", { "@Boz": { user_id: 1 } });
    expect(out.body).toBe("${0} hello");
  });

  it("matches at the very end of the buffer", () => {
    const out = buildCommentBody("hello @Boz", { "@Boz": { user_id: 1 } });
    expect(out.body).toBe("hello ${0}");
  });

  it("escapes regex metacharacters in the mention token", () => {
    // @bo.z+ has regex metacharacters; if we didn't escape it would match
    // 'bo' + any char + 'z' + one-or-more 'z's. The literal-only match
    // means @bo.z+ in the body matches, but @bocz or @boozz does NOT.
    const out = buildCommentBody("hi @bo.z+ and @bocz", {
      "@bo.z+": { user_id: 1 },
    });
    expect(out.body).toBe("hi ${0} and @bocz");
    expect(out.mentions["0"]).toEqual({ user_id: 1, text: "@bo.z+" });
  });
});
