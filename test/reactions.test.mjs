// Reaction tests (commit 5 of v0.2 write side).
//
// Covers:
//   - updateReactionCount pure reducer (optimistic +1 and rollback -1)
//   - pickSuggestedReactions surfaces top-N from library OR falls back to
//     the default suggested set when nothing usable is returned.

import { describe, it, expect } from "vitest";
import {
  updateReactionCount,
  pickSuggestedReactions,
  DEFAULT_SUGGESTED_REACTIONS,
} from "../lib/compose.js";

describe("updateReactionCount — REST shape (numeric count)", () => {
  it("adds a new reaction with count 1 on first +1", () => {
    const next = updateReactionCount(null, "thumbs_up", +1);
    expect(next).toEqual({ thumbs_up: 1 });
  });

  it("bumps an existing numeric count by +1", () => {
    const next = updateReactionCount({ thumbs_up: 4 }, "thumbs_up", +1);
    expect(next).toEqual({ thumbs_up: 5 });
  });

  it("rolls back a numeric count by -1 (count > 0)", () => {
    const next = updateReactionCount({ thumbs_up: 5 }, "thumbs_up", -1);
    expect(next).toEqual({ thumbs_up: 4 });
  });

  it("drops the reaction entry when rollback hits 0", () => {
    const next = updateReactionCount({ thumbs_up: 1 }, "thumbs_up", -1);
    expect(next).toEqual({});
  });

  it("does not throw and drops entry when rollback goes below 0", () => {
    // Defensive: shouldn't happen in practice, but the reducer should
    // never leave negative counts in the store.
    const next = updateReactionCount({}, "rocket", -1);
    expect(next).toEqual({});
  });

  it("leaves other reactions untouched", () => {
    const next = updateReactionCount(
      { thumbs_up: 2, fire: 5 },
      "thumbs_up",
      +1
    );
    expect(next).toEqual({ thumbs_up: 3, fire: 5 });
  });
});

describe("updateReactionCount — WS shape ({count, has_reacted})", () => {
  it("bumps an object-shaped reaction and preserves richer keys", () => {
    const next = updateReactionCount(
      { fire: { count: 3, has_reacted: false } },
      "fire",
      +1
    );
    expect(next.fire.count).toBe(4);
    expect(next.fire.has_reacted).toBe(true);
  });

  it("rolls back an object-shaped reaction and flips has_reacted", () => {
    const next = updateReactionCount(
      { fire: { count: 4, has_reacted: true } },
      "fire",
      -1
    );
    expect(next.fire.count).toBe(3);
    expect(next.fire.has_reacted).toBe(false);
  });

  it("does not mutate the input object (returns a fresh object)", () => {
    const input = { fire: 3 };
    const next = updateReactionCount(input, "fire", +1);
    expect(input).toEqual({ fire: 3 });
    expect(next).not.toBe(input);
  });
});

describe("pickSuggestedReactions", () => {
  it("falls back to DEFAULT_SUGGESTED_REACTIONS when given null", () => {
    expect(pickSuggestedReactions(null)).toEqual(
      DEFAULT_SUGGESTED_REACTIONS.slice(0, 6)
    );
  });

  it("falls back to defaults when the library object has nothing useful", () => {
    expect(pickSuggestedReactions({ unrelated: "junk" })).toEqual(
      DEFAULT_SUGGESTED_REACTIONS.slice(0, 6)
    );
  });

  it("picks suggestedReactionTypes when present (string list)", () => {
    const lib = {
      suggestedReactionTypes: ["pile_of_poo", "skull", "fire"],
    };
    expect(pickSuggestedReactions(lib)).toEqual([
      "pile_of_poo",
      "skull",
      "fire",
    ]);
  });

  it("picks suggested types from object-list shapes", () => {
    const lib = {
      suggestedReactionTypes: [
        { name: "pile_of_poo" },
        { type: "skull" },
        { name: "fire" },
      ],
    };
    expect(pickSuggestedReactions(lib)).toEqual([
      "pile_of_poo",
      "skull",
      "fire",
    ]);
  });

  it("falls back to frequently_used if suggestedReactionTypes is empty", () => {
    const lib = { suggestedReactionTypes: [], frequently_used: ["rocket"] };
    expect(pickSuggestedReactions(lib)).toEqual(["rocket"]);
  });

  it("caps the result at N", () => {
    const lib = {
      suggestedReactionTypes: ["a", "b", "c", "d", "e", "f", "g", "h"],
    };
    expect(pickSuggestedReactions(lib, 3)).toEqual(["a", "b", "c"]);
  });

  it("DEFAULT_SUGGESTED_REACTIONS has 6 entries (top-6 fits the picker)", () => {
    expect(DEFAULT_SUGGESTED_REACTIONS.length).toBe(6);
  });
});

describe("rollback flow — optimistic then failure", () => {
  // Simulates the sendReaction code path: bump the count, then on error
  // restore the previous reactions object verbatim.
  it("a +1 then -1 returns to the original state", () => {
    const original = { thumbs_up: 3, fire: 1 };
    const optimistic = updateReactionCount(original, "thumbs_up", +1);
    expect(optimistic).toEqual({ thumbs_up: 4, fire: 1 });
    // On failure, the app code restores `comment.reactions = prevReactions`
    // — that's just the reference, no reducer call required. So the only
    // requirement of the reducer is that the +1 produced a NEW object so
    // the original reference is still intact for rollback.
    expect(original).toEqual({ thumbs_up: 3, fire: 1 });
  });

  it("two clicks in flight produce two +1s; one rollback leaves +1 net", () => {
    let r = { fire: 0 };
    // Click 1 — optimistic +1
    r = updateReactionCount(r, "fire", +1);
    // Click 2 — optimistic +1
    r = updateReactionCount(r, "fire", +1);
    expect(r).toEqual({ fire: 2 });
    // Click 1 fails — rollback -1
    r = updateReactionCount(r, "fire", -1);
    expect(r).toEqual({ fire: 1 });
  });
});
