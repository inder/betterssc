// Optimistic UI reconciliation tests (commit 3 of v0.2 write side).
//
// The spec: given a pending=true comment with id X already in the store and
// a new comment with id X arrives via poll, the pending one is replaced
// (not duplicated). Plus failure-path coverage: markPendingFailed flips
// _pending to _failed in-place.

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildPendingComment,
  reconcilePending,
  markPendingFailed,
} from "../lib/compose.js";

const makeStore = () => ({ comments: new Map(), order: [] });
const seedPending = (store, c) => {
  store.comments.set(c.id, c);
  store.order.push(c.id);
};

describe("buildPendingComment", () => {
  it("includes _pending: true and a self-author with current user's id", () => {
    const user = { id: 9024475, name: "Inder", handle: "indersabharwal" };
    const p = buildPendingComment("client-uuid-1", user, "hello", {});
    expect(p._pending).toBe(true);
    expect(p.id).toBe("client-uuid-1");
    expect(p.body).toBe("hello");
    expect(p.author.id).toBe(9024475);
    expect(p.author.name).toBe("Inder");
    expect(p.reactions).toEqual({});
    // created_at should parse to a real date so it can sort to the end.
    expect(isNaN(new Date(p.created_at).getTime())).toBe(false);
  });

  it("falls back to a synthetic 'You' author when user is null", () => {
    const p = buildPendingComment("cid", null, "body", {});
    expect(p.author.name).toBe("You");
    expect(p.author.id).toBe("self");
  });
});

describe("reconcilePending — id match", () => {
  it("replaces a pending row in-place when the real comment with same id arrives", () => {
    const store = makeStore();
    const pending = buildPendingComment(
      "X",
      { id: 1, name: "Me" },
      "hello",
      {}
    );
    seedPending(store, pending);
    // The real comment arrives with the same id (Substack honored our client uuid).
    const real = {
      id: "X",
      body: "hello",
      author: { id: 1, name: "Me" },
      created_at: new Date().toISOString(),
      reactions: {},
    };
    const action = reconcilePending(store, real);
    expect(action).toBe("replaced");
    // No duplicate.
    expect(store.comments.size).toBe(1);
    expect(store.order.length).toBe(1);
    // Pending flag is cleared on the replacement.
    expect(store.comments.get("X")._pending).toBe(false);
    expect(store.comments.get("X").body).toBe("hello");
  });

  it("returns 'noop' when no matching pending row exists", () => {
    const store = makeStore();
    const real = {
      id: "Y",
      body: "hi",
      author: { id: 1 },
      created_at: new Date().toISOString(),
    };
    expect(reconcilePending(store, real)).toBe("noop");
    // Reconciler does not insert — that's ingestComment's job.
    expect(store.comments.size).toBe(0);
  });

  it("returns 'noop' for a non-pending row (don't clobber a real comment)", () => {
    const store = makeStore();
    const existing = {
      id: "X",
      body: "old",
      author: { id: 1 },
      created_at: new Date().toISOString(),
    };
    store.comments.set("X", existing);
    store.order.push("X");
    const real = {
      id: "X",
      body: "new",
      author: { id: 1 },
      created_at: new Date().toISOString(),
    };
    expect(reconcilePending(store, real)).toBe("noop");
    // Original survives.
    expect(store.comments.get("X").body).toBe("old");
  });
});

describe("reconcilePending — body fallback (server reassigned id)", () => {
  it("matches by body+author when ids differ but the pending body matches", () => {
    const store = makeStore();
    const pending = buildPendingComment(
      "client-X",
      { id: 1, name: "Me" },
      "hello",
      {}
    );
    seedPending(store, pending);
    const real = {
      id: "server-Y",
      body: "hello",
      author: { id: 1, name: "Me" },
      created_at: new Date().toISOString(),
    };
    const action = reconcilePending(store, real);
    expect(action).toBe("replaced");
    // The pending row's slot in `order` is taken over by the real id.
    expect(store.comments.has("client-X")).toBe(false);
    expect(store.comments.has("server-Y")).toBe(true);
    expect(store.order).toEqual(["server-Y"]);
    expect(store.comments.get("server-Y")._pending).toBe(false);
  });

  it("does NOT body-match across different authors", () => {
    const store = makeStore();
    const pending = buildPendingComment(
      "client-X",
      { id: 1, name: "Me" },
      "hello",
      {}
    );
    seedPending(store, pending);
    const real = {
      id: "server-Y",
      body: "hello",
      author: { id: 2, name: "SomeoneElse" },
      created_at: new Date().toISOString(),
    };
    expect(reconcilePending(store, real)).toBe("noop");
    // Pending is preserved (it was someone else's identical-body message).
    expect(store.comments.get("client-X")._pending).toBe(true);
  });
});

describe("reconcilePending — guards", () => {
  it("returns 'noop' when store is null", () => {
    expect(reconcilePending(null, { id: "X" })).toBe("noop");
  });
  it("returns 'noop' when incoming is null", () => {
    expect(reconcilePending(makeStore(), null)).toBe("noop");
  });
  it("returns 'noop' when incoming has no id", () => {
    expect(reconcilePending(makeStore(), { body: "x" })).toBe("noop");
  });
});

describe("reconcilePending — media_uploads carry-forward (attachments)", () => {
  it("carries forward media_uploads when the server echo omits them", () => {
    // Scenario: optimistic pending row has the staged-attachment blob
    // preview. Server's poll-fallback echo lacks media_uploads. The
    // reconciled row should NOT lose the visible image.
    const store = makeStore();
    const pending = buildPendingComment("X", { id: 1 }, "hi", {});
    pending.media_uploads = [
      {
        id: "X",
        type: "image",
        content_type: "image/gif",
        url: "blob:chrome-extension://x/abc",
        _localPreview: true,
        _stagedFile: { name: "test.gif", type: "image/gif", size: 100 },
      },
    ];
    seedPending(store, pending);
    // Server echo with no media_uploads.
    reconcilePending(store, {
      id: "X",
      body: "hi",
      author: { id: 1 },
      created_at: new Date().toISOString(),
    });
    const c = store.comments.get("X");
    expect(c._pending).toBe(false);
    expect(c.media_uploads).toHaveLength(1);
    expect(c.media_uploads[0].url).toBe("blob:chrome-extension://x/abc");
    // Internal flags MUST be stripped on carry-forward so we don't
    // accidentally re-trigger retry-as-upload on a reconciled row.
    expect(c.media_uploads[0]._localPreview).toBeUndefined();
    expect(c.media_uploads[0]._stagedFile).toBeUndefined();
  });

  it("does NOT overwrite server-provided media_uploads with the pending preview", () => {
    // Scenario: server echo DOES include the real CDN URL. The pending
    // blob preview should be replaced, not preserved.
    const store = makeStore();
    const pending = buildPendingComment("X", { id: 1 }, "hi", {});
    pending.media_uploads = [
      {
        id: "X",
        type: "image",
        content_type: "image/gif",
        url: "blob:chrome-extension://x/abc",
        _localPreview: true,
      },
    ];
    seedPending(store, pending);
    reconcilePending(store, {
      id: "X",
      body: "hi",
      author: { id: 1 },
      created_at: new Date().toISOString(),
      media_uploads: [
        {
          id: "real-server-id",
          type: "image",
          content_type: "image/gif",
          url: "https://substack-post-media.s3.amazonaws.com/.../real.gif",
        },
      ],
    });
    const c = store.comments.get("X");
    expect(c.media_uploads).toHaveLength(1);
    expect(c.media_uploads[0].url).toMatch(/^https:\/\//);
    expect(c.media_uploads[0].id).toBe("real-server-id");
  });

  it("leaves media_uploads alone when neither pending nor server has them", () => {
    const store = makeStore();
    const pending = buildPendingComment("X", { id: 1 }, "no attachment", {});
    seedPending(store, pending);
    reconcilePending(store, {
      id: "X",
      body: "no attachment",
      author: { id: 1 },
      created_at: new Date().toISOString(),
    });
    const c = store.comments.get("X");
    expect(c.media_uploads).toBeUndefined();
  });
});

describe("markPendingFailed", () => {
  it("flips _pending to _failed in place and records the error", () => {
    const store = makeStore();
    const pending = buildPendingComment("X", { id: 1 }, "hello", {});
    seedPending(store, pending);
    const ok = markPendingFailed(store, "X", "network down");
    expect(ok).toBe(true);
    const c = store.comments.get("X");
    expect(c._pending).toBe(false);
    expect(c._failed).toBe(true);
    expect(c._error).toBe("network down");
  });
  it("returns false when the id is not pending", () => {
    const store = makeStore();
    store.comments.set("X", { id: "X", body: "real" });
    expect(markPendingFailed(store, "X", "x")).toBe(false);
  });
  it("returns false when store is null", () => {
    expect(markPendingFailed(null, "X", "x")).toBe(false);
  });
});
