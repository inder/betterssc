// Focus mode filtering — the ancestor-walk engine.
//
// Covers: direct term/people/mention match, union of terms, the
// reply-tree ancestor walk (the "$SPCX reply with no $SPCX text still
// passes" behavior), negatives, and the correctness boundaries that bite
// tree-walkers: cycles, missing ancestors, case-insensitivity, memo
// equivalence.

import { describe, it, expect } from "vitest";
import {
  commentMatchesFocus,
  commentDirectlyMatchesFocus,
  buildFocusFilter,
  isFocusEmpty,
  splitTerms,
} from "../lib/focus.js";

// Build a tiny comment store. Each spec = { id, body?, user_id?, author?,
// parent_id?, quote_id?, mentions? }.
function makeStore(comments) {
  const map = new Map(comments.map((c) => [c.id, c]));
  return {
    get: (id) => map.get(id),
    comment: (id) => map.get(id),
  };
}

const focus = (comment, filter, store, memo) =>
  commentMatchesFocus(comment, filter, store.get, memo);

describe("isFocusEmpty", () => {
  it("treats null / empty arrays as empty (show all)", () => {
    expect(isFocusEmpty(null)).toBe(true);
    expect(isFocusEmpty({ terms: [], userIds: [] })).toBe(true);
    expect(isFocusEmpty({ terms: ["x"], userIds: [] })).toBe(false);
    expect(isFocusEmpty({ terms: [], userIds: ["7"] })).toBe(false);
  });
});

describe("commentDirectlyMatchesFocus", () => {
  it("matches a term as a case-insensitive substring of the body", () => {
    const f = { terms: ["SPCX"], userIds: [] };
    expect(commentDirectlyMatchesFocus({ body: "buying $spcx now" }, f)).toBe(
      true
    );
    expect(commentDirectlyMatchesFocus({ body: "nothing here" }, f)).toBe(
      false
    );
  });

  it("unions multiple terms (any term matches — OR, not AND)", () => {
    const f = { terms: ["spcx", "nvda"], userIds: [] };
    // Matches on the SECOND term alone — proves OR, not AND.
    expect(commentDirectlyMatchesFocus({ body: "load up on NVDA" }, f)).toBe(
      true
    );
    // Matches on the FIRST term alone.
    expect(commentDirectlyMatchesFocus({ body: "$SPCX only here" }, f)).toBe(
      true
    );
    // Matches NEITHER → false (sanity that it's not always-true).
    expect(commentDirectlyMatchesFocus({ body: "talking pizza" }, f)).toBe(
      false
    );
  });

  it("matches when the author is a focused person (number vs string id)", () => {
    const f = { terms: [], userIds: ["42"] };
    expect(commentDirectlyMatchesFocus({ user_id: 42, body: "hi" }, f)).toBe(
      true
    );
    expect(
      commentDirectlyMatchesFocus({ author: { id: 42 }, body: "hi" }, f)
    ).toBe(true);
    expect(commentDirectlyMatchesFocus({ user_id: 99, body: "hi" }, f)).toBe(
      false
    );
  });

  it("matches when a focused person is @mentioned", () => {
    const f = { terms: [], userIds: ["7"] };
    const c = { body: "hey @al", mentions: { al: { user_id: 7 } } };
    expect(commentDirectlyMatchesFocus(c, f)).toBe(true);
  });
});

describe("commentMatchesFocus — ancestor walk", () => {
  it("passes a reply whose PARENT matches the term, even with no term in the reply", () => {
    const store = makeStore([
      { id: "a", body: "$SPCX to the moon", user_id: 1 },
      { id: "b", body: "agreed, huge", user_id: 2, parent_id: "a" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    expect(focus(store.get("b"), f, store)).toBe(true);
  });

  it("passes a reply via quote_id (quote reply edge), not just parent_id", () => {
    const store = makeStore([
      { id: "a", body: "$SPCX earnings tonight", user_id: 1 },
      { id: "b", body: "+1", user_id: 2, quote_id: "a" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    expect(focus(store.get("b"), f, store)).toBe(true);
  });

  it("passes a reply to a FOCUSED PERSON's message (people focus walks too)", () => {
    const store = makeStore([
      { id: "a", body: "random thought", user_id: 50 },
      { id: "b", body: "tell me more", user_id: 2, parent_id: "a" },
    ]);
    const f = { terms: [], userIds: ["50"] };
    expect(focus(store.get("b"), f, store)).toBe(true);
  });

  it("walks 3 levels deep (only the root matches, leaf still passes)", () => {
    const store = makeStore([
      { id: "root", body: "$SPCX thesis", user_id: 1 },
      { id: "mid", body: "interesting", user_id: 2, parent_id: "root" },
      { id: "leaf", body: "ok", user_id: 3, parent_id: "mid" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    expect(focus(store.get("leaf"), f, store)).toBe(true);
  });

  it("HIDES a message with no match and no matching ancestor", () => {
    const store = makeStore([
      { id: "a", body: "talking about pizza", user_id: 1 },
      { id: "b", body: "yeah pepperoni", user_id: 2, parent_id: "a" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    expect(focus(store.get("b"), f, store)).toBe(false);
  });

  it("empty filter passes everything (no-op)", () => {
    const store = makeStore([{ id: "a", body: "whatever", user_id: 1 }]);
    expect(focus(store.get("a"), { terms: [], userIds: [] }, store)).toBe(true);
    expect(focus(store.get("a"), null, store)).toBe(true);
  });
});

describe("commentMatchesFocus — correctness boundaries", () => {
  it("terminates on a malformed cycle (A->B->A) instead of infinite-looping", () => {
    const store = makeStore([
      { id: "a", body: "no match", user_id: 1, parent_id: "b" },
      { id: "b", body: "no match", user_id: 2, parent_id: "a" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    // Must return (not hang) and be false — nothing in the cycle matches.
    expect(focus(store.get("a"), f, store)).toBe(false);
  });

  it("a cycle where one node matches still resolves true", () => {
    const store = makeStore([
      { id: "a", body: "no", user_id: 1, parent_id: "b" },
      { id: "b", body: "$SPCX", user_id: 2, parent_id: "a" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    expect(focus(store.get("a"), f, store)).toBe(true);
  });

  it("does not throw when an ancestor isn't loaded (dangling parent_id)", () => {
    const store = makeStore([
      { id: "b", body: "reply", user_id: 2, parent_id: "missing" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    expect(() => focus(store.get("b"), f, store)).not.toThrow();
    expect(focus(store.get("b"), f, store)).toBe(false);
  });

  it("a stale memo hides a row whose ancestor was backfilled — so callers MUST drop the memo when the store changes", () => {
    // Reproduces the history-backfill Critical: a reply 'b' is evaluated
    // BEFORE its parent 'a' is loaded → false (dangling parent). Later 'a'
    // backfills via loadOlder. A REUSED memo keeps the stale false; a fresh
    // memo (what applySearch does every pass) returns the correct true.
    const f = { terms: ["spcx"], userIds: [] };
    const loaded = new Map([["b", { id: "b", body: "agreed", parent_id: "a" }]]);
    const get = (id) => loaded.get(id);
    const memo = new Map();

    // Pass 1: parent not loaded yet.
    expect(commentMatchesFocus(loaded.get("b"), f, get, memo)).toBe(false);

    // Backfill the matching ancestor.
    loaded.set("a", { id: "a", body: "$SPCX thesis" });

    // Reusing the SAME memo → stale false (the bug).
    expect(commentMatchesFocus(loaded.get("b"), f, get, memo)).toBe(false);
    // A fresh memo → correct true (the fix: applySearch clears _focusMemo).
    expect(commentMatchesFocus(loaded.get("b"), f, get, new Map())).toBe(true);
  });

  it("memo yields the same verdict as a cold run, and shares ancestor work", () => {
    const store = makeStore([
      { id: "root", body: "$SPCX", user_id: 1 },
      { id: "mid", body: "x", user_id: 2, parent_id: "root" },
      { id: "leaf", body: "y", user_id: 3, parent_id: "mid" },
    ]);
    const f = { terms: ["spcx"], userIds: [] };
    const cold = focus(store.get("leaf"), f, store);
    const memo = new Map();
    const warm1 = commentMatchesFocus(store.get("leaf"), f, store.get, memo);
    const warm2 = commentMatchesFocus(store.get("mid"), f, store.get, memo);
    expect(cold).toBe(true);
    expect(warm1).toBe(true);
    expect(warm2).toBe(true);
    expect(memo.get("root")).toBe(true);
  });
});

describe("splitTerms", () => {
  it("splits multi-word input into separate OR'd terms on whitespace + commas", () => {
    expect(splitTerms("$SPCX earnings TSLA")).toEqual([
      "$SPCX",
      "earnings",
      "TSLA",
    ]);
    expect(splitTerms("$SPCX, earnings,  TSLA")).toEqual([
      "$SPCX",
      "earnings",
      "TSLA",
    ]);
    expect(splitTerms("  spaced   out  ")).toEqual(["spaced", "out"]);
  });

  it("returns an empty array for blank/whitespace/undefined/comma-only input", () => {
    expect(splitTerms("")).toEqual([]);
    expect(splitTerms("   ")).toEqual([]);
    expect(splitTerms(undefined)).toEqual([]);
    // A bare comma (or run of commas/spaces) yields no chips — no empty chip.
    expect(splitTerms(",")).toEqual([]);
    expect(splitTerms(" , , ")).toEqual([]);
  });

  it("a $TICKER with a dot stays one term ($BRK.B is not split)", () => {
    expect(splitTerms("$BRK.B")).toEqual(["$BRK.B"]);
  });

  it("split terms feed an OR'd filter end to end", () => {
    const filter = buildFocusFilter(splitTerms("spcx nvda"), []);
    expect(filter.terms).toEqual(["spcx", "nvda"]);
    // A message matching only one of the two terms passes.
    expect(commentDirectlyMatchesFocus({ body: "just NVDA today" }, filter)).toBe(
      true
    );
  });
});

describe("buildFocusFilter", () => {
  it("trims, dedupes, and returns null when nothing meaningful is provided", () => {
    expect(buildFocusFilter([], [])).toBe(null);
    expect(buildFocusFilter(["  ", ""], [""])).toBe(null);
    expect(buildFocusFilter([" spcx ", "spcx", "nvda"], [7, "7", 8])).toEqual({
      terms: ["spcx", "nvda"],
      userIds: ["7", "8"],
    });
  });
});
