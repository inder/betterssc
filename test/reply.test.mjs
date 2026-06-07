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
  // v0.2-write live test revealed that ANY reply metadata on the wire
  // (parent_id and/or quote) either gets rejected silently by Substack or
  // is stored in a way that doesn't render in native chat. The native
  // client capture we have for a quote-reply shows the wire as just
  // {id, body, mentions} — no reply metadata at all. So buildReplyFields
  // now always returns {} regardless of replyingTo state. The composer's
  // optimistic pending row still carries pending.quote so the quoted
  // block renders locally in BetterSSC; reconcilePending preserves it
  // through polling.
  it("returns empty object when no reply target", () => {
    expect(buildReplyFields({ replyingTo: null })).toEqual({});
  });

  it("returns empty object EVEN when a reply target is set (v0.2-write)", () => {
    const composer = makeComposer();
    setReplyTarget(composer, {
      id: 42,
      body: "the original",
      author: { id: 7, name: "Boz" },
    });
    expect(buildReplyFields(composer)).toEqual({});
  });

  it("returns empty object when composer is null (guard)", () => {
    expect(buildReplyFields(null)).toEqual({});
  });
});

describe("end-to-end — set reply, build send payload, clear", () => {
  it("mirrors the submitComposer flow: set reply → build (empty wire) → clear", () => {
    const composer = { replyingTo: null };
    // 1. User clicks Reply on a message.
    setReplyTarget(composer, {
      id: 100,
      body: "what do you think?",
      author: { id: 9, name: "Carol" },
    });
    expect(composer.replyingTo.authorName).toBe("Carol");

    // 2. Wire fields stay empty — the optimistic pending carries quote
    //    locally; the server gets just {id, body, mentions}.
    expect(buildReplyFields(composer)).toEqual({});

    // 3. After send, the composer clears the reply target.
    clearReplyTarget(composer);
    expect(composer.replyingTo).toBeNull();
    expect(buildReplyFields(composer)).toEqual({});
  });
});
