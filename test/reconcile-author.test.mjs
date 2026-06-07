// Regression for the "Unknown author" bug seen in v0.2-A live test.
// When the POST response (or polling) brings back a comment whose
// `author` field is missing but user_id is set, the reconcile path
// must preserve the pending row's author info instead of letting the
// merged row render as "Unknown".

import { describe, it, expect } from "vitest";
import {
  buildPendingComment,
  reconcilePending,
} from "../lib/compose.js";

function makeStore() {
  return { comments: new Map(), order: [] };
}

describe("reconcilePending preserves author when incoming lacks it", () => {
  it("Path 1 (id match) keeps pending.author when incoming.author is missing", () => {
    const store = makeStore();
    const me = { id: 9024475, name: "Inder Sabharwal", handle: "inderstocks" };
    const pending = buildPendingComment("client-1", me, "hello", {});
    store.comments.set(pending.id, pending);
    store.order.push(pending.id);

    // Simulates Substack's POST response shape that lost author/user
    // during a partial unwrap.
    const incoming = {
      id: "client-1",
      body: "hello",
      user_id: 9024475,
      created_at: "2026-06-06T18:00:00Z",
    };
    const result = reconcilePending(store, incoming);
    expect(result).toBe("replaced");
    const final = store.comments.get("client-1");
    expect(final._pending).toBe(false);
    expect(final.author).toBeDefined();
    expect(final.author.name).toBe("Inder Sabharwal");
    expect(final.author.id).toBe(9024475);
  });

  it("Path 2 (body fallback) keeps pending.author when incoming has flat user_id only", () => {
    const store = makeStore();
    const me = { id: 9024475, name: "Inder Sabharwal" };
    const pending = buildPendingComment("client-2", me, "yes!", {});
    store.comments.set(pending.id, pending);
    store.order.push(pending.id);

    const incoming = {
      id: "server-id-99",  // server reassigned the id
      body: "yes!",
      user_id: 9024475,    // matches pending.author.id
      created_at: "2026-06-06T18:00:00Z",
    };
    const result = reconcilePending(store, incoming);
    expect(result).toBe("replaced");
    const final = store.comments.get("server-id-99");
    expect(final.author.name).toBe("Inder Sabharwal");
  });

  it("incoming's author wins when both pending and incoming have one", () => {
    const store = makeStore();
    const me = { id: 9024475, name: "Inder Sabharwal" };
    const pending = buildPendingComment("client-3", me, "hi", {});
    store.comments.set(pending.id, pending);
    store.order.push(pending.id);

    const incoming = {
      id: "client-3",
      body: "hi",
      user_id: 9024475,
      author: {
        id: 9024475,
        name: "Inder Sabharwal",
        handle: "inderstocks",
        photo_url: "https://example.com/avatar.png",
      },
      created_at: "2026-06-06T18:00:00Z",
    };
    const result = reconcilePending(store, incoming);
    expect(result).toBe("replaced");
    const final = store.comments.get("client-3");
    expect(final.author.photo_url).toBe("https://example.com/avatar.png");
  });
});
