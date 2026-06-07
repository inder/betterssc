// Reply / quote tests (commit 6 of v0.2 write side).
//
// Verifies the composer state correctly attaches parent on send, the × bar
// clears it, and buildReplyFields produces the right wire shape.

import { describe, it, expect } from "vitest";
import {
  setReplyTarget,
  clearReplyTarget,
  buildReplyFields,
} from "../lib/compose.js";

const makeComposer = () => ({ replyingTo: null });

describe("setReplyTarget", () => {
  it("records a target with id, authorName, body, and author shape", () => {
    const composer = makeComposer();
    setReplyTarget(composer, {
      id: 42,
      body: "the original",
      author: { id: 7, name: "Boz", handle: "boz" },
    });
    expect(composer.replyingTo).toEqual({
      id: 42,
      authorName: "Boz",
      body: "the original",
      author: { id: 7, name: "Boz", handle: "boz" },
    });
  });

  it("falls back to handle then 'someone' when name is missing", () => {
    const composer = makeComposer();
    setReplyTarget(composer, { id: 1, body: "x", author: { handle: "boz" } });
    expect(composer.replyingTo.authorName).toBe("boz");
    setReplyTarget(composer, { id: 2, body: "y", author: {} });
    expect(composer.replyingTo.authorName).toBe("someone");
  });

  it("truncates very long bodies to 200 chars for the preview", () => {
    const composer = makeComposer();
    const long = "a".repeat(500);
    setReplyTarget(composer, { id: 1, body: long, author: { name: "x" } });
    expect(composer.replyingTo.body.length).toBe(200);
  });

  it("treats a falsy target as clearing the state", () => {
    const composer = { replyingTo: { id: 99, authorName: "x", body: "" } };
    setReplyTarget(composer, null);
    expect(composer.replyingTo).toBeNull();
  });

  it("treats a target without an id as clearing the state", () => {
    const composer = { replyingTo: { id: 99, authorName: "x", body: "" } };
    setReplyTarget(composer, { body: "x" });
    expect(composer.replyingTo).toBeNull();
  });

  it("is a no-op on null composer (guard)", () => {
    expect(() => setReplyTarget(null, { id: 1 })).not.toThrow();
  });
});

describe("clearReplyTarget", () => {
  it("clears a previously-set reply target", () => {
    const composer = makeComposer();
    setReplyTarget(composer, {
      id: 5,
      body: "x",
      author: { name: "Alice" },
    });
    expect(composer.replyingTo).not.toBeNull();
    clearReplyTarget(composer);
    expect(composer.replyingTo).toBeNull();
  });
  it("is a no-op when nothing is set", () => {
    const composer = makeComposer();
    clearReplyTarget(composer);
    expect(composer.replyingTo).toBeNull();
  });
});

describe("buildReplyFields", () => {
  it("returns empty object when no reply target", () => {
    expect(buildReplyFields({ replyingTo: null })).toEqual({});
  });

  it("attaches parentId AND quote with nested comment shape", () => {
    const composer = makeComposer();
    setReplyTarget(composer, {
      id: 42,
      body: "the original",
      author: { id: 7, name: "Boz" },
    });
    const fields = buildReplyFields(composer);
    expect(fields.parentId).toBe(42);
    expect(fields.quote).toBeTruthy();
    expect(fields.quote.comment.id).toBe(42);
    expect(fields.quote.comment.body).toBe("the original");
    expect(fields.quote.comment.author).toEqual({ id: 7, name: "Boz" });
  });

  it("preserves an empty body in the quote (don't omit field on empty)", () => {
    const composer = makeComposer();
    setReplyTarget(composer, { id: 5, body: "", author: { name: "Alice" } });
    const fields = buildReplyFields(composer);
    expect(fields.quote.comment.body).toBe("");
  });

  it("returns empty object when composer is null (guard)", () => {
    expect(buildReplyFields(null)).toEqual({});
  });
});

describe("end-to-end — set reply, build send payload, clear", () => {
  it("mirrors the submitComposer flow: set reply → build → clear", () => {
    const composer = { replyingTo: null };
    // 1. User clicks Reply on a message.
    setReplyTarget(composer, {
      id: 100,
      body: "what do you think?",
      author: { id: 9, name: "Carol" },
    });
    expect(composer.replyingTo.authorName).toBe("Carol");

    // 2. Composer assembles the wire fields when the user hits Send.
    const fields = buildReplyFields(composer);
    expect(fields).toEqual({
      parentId: 100,
      quote: {
        comment: {
          id: 100,
          body: "what do you think?",
          author: { id: 9, name: "Carol" },
        },
      },
    });

    // 3. After send, the composer clears the reply target.
    clearReplyTarget(composer);
    expect(composer.replyingTo).toBeNull();
    expect(buildReplyFields(composer)).toEqual({});
  });
});
