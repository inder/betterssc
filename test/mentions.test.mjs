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
  updateMentionSelections,
  buildCommentBody,
  filterMentionSuggestions,
  mergeMentionSuggestions,
  buildMentionSelection,
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
      replaceEnd: 6,
    });
  });

  it("continues a live mention query across spaces in a display name", () => {
    expect(
      findActiveMentionToken("hello @Jordan Con", 17, { allowSpaces: true })
    ).toEqual({
      query: "Jordan Con",
      start: 6,
      end: 17,
    });
  });

  it("allows a trailing space while the user starts a surname", () => {
    expect(
      findActiveMentionToken("@Jordan ", 8, { allowSpaces: true })
    ).toEqual({ query: "Jordan ", start: 0, end: 8 });
  });
});

describe("display-name suggestion matching", () => {
  const people = [
    { id: 1, name: "Jordan Conner", handle: "marketjordan" },
    { user_id: 2, name: "Jordan Lee", handle: "jl_trades" },
    { userId: 3, name: "Alex Smith", username: "jordanmacro" },
  ];

  it("narrows common first names using the multi-word display name", () => {
    expect(filterMentionSuggestions(people, "jordan con")).toEqual([
      expect.objectContaining({
        user_id: 1,
        name: "Jordan Conner",
        handle: "marketjordan",
      }),
    ]);
  });

  it("keeps all exact duplicate names so the visible handles disambiguate", () => {
    const results = filterMentionSuggestions(
      [
        { user_id: 10, name: "Jordan Conner", handle: "jconner1" },
        { user_id: 11, name: "Jordan Conner", handle: "jconner2" },
      ],
      "Jordan Conner"
    );
    expect(results.map((u) => [u.user_id, u.handle])).toEqual([
      [10, "jconner1"],
      [11, "jconner2"],
    ]);
  });

  it("retains handle matching while prioritizing a display-name match", () => {
    const results = filterMentionSuggestions(people, "jordan");
    expect(results.map((u) => u.user_id)).toEqual([1, 2, 3]);
  });

  it("merges locally known real names with handle-only endpoint rows", () => {
    const results = mergeMentionSuggestions(
      [{ id: 1, name: "Jordan Conner", handle: "marketjordan" }],
      [
        { user_id: 1, handle: "marketjordan", photo_url: "avatar.jpg" },
        { user_id: 4, name: "Remote Person", handle: "remote" },
      ],
      "Jordan Conner"
    );
    expect(results).toEqual([
      expect.objectContaining({
        user_id: 1,
        name: "Jordan Conner",
        handle: "marketjordan",
        photo_url: "avatar.jpg",
      }),
    ]);
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

  it("replaces the whole token when the caret is in its middle", () => {
    const token = findActiveMentionToken("hi @bo", 5);
    expect(replaceMentionToken("hi @bo", token, "Bob")).toEqual({
      text: "hi @Bob ",
      cursor: 8,
    });
  });

  it("replaces a whole known multi-word name from a middle caret", () => {
    const token = findActiveMentionToken("hi @Jordan Conner", 12, {
      allowSpaces: true,
      fullNames: ["Jordan Conner"],
    });
    expect(token.replaceEnd).toBe(17);
    expect(replaceMentionToken("hi @Jordan Conner", token, "Jordan Connor"))
      .toEqual({ text: "hi @Jordan Connor ", cursor: 18 });
  });
});

describe("updateMentionSelections", () => {
  const selected = [
    { start: 3, end: 17, token: "@Jordan Conner", user_id: 1, text: "@jc" },
  ];

  it("shifts a selected mention when text is inserted before it", () => {
    expect(updateMentionSelections("hi @Jordan Conner", "well hi @Jordan Conner", selected))
      .toEqual([
        expect.objectContaining({ start: 8, end: 22, user_id: 1 }),
      ]);
  });

  it("invalidates identity metadata when the visible mention is edited", () => {
    expect(updateMentionSelections("hi @Jordan Conner", "hi @Jordan Connor", selected))
      .toEqual([]);
  });

  it("uses an explicit edit range when identical mention text is prepended", () => {
    const before = "@Jordan Conner";
    const after = "@Jordan Conner @Jordan Conner";
    expect(
      updateMentionSelections(before, after, [
        {
          start: 0,
          end: 14,
          token: "@Jordan Conner",
          user_id: 1,
          text: "@original",
        },
      ], { start: 0, end: 0 })
    ).toEqual([
      expect.objectContaining({ start: 15, end: 29, user_id: 1 }),
    ]);
  });

  it("invalidates identity when identical text is pasted over a mention", () => {
    const text = "@Jordan Conner";
    expect(
      updateMentionSelections(text, text, [
        {
          start: 0,
          end: 14,
          token: "@Jordan Conner",
          user_id: 1,
          text: "@old_identity",
        },
      ], { start: 0, end: 14 })
    ).toEqual([]);
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

  it("shows a multi-word real name but sends the selected handle and id", () => {
    const selected = buildMentionSelection({
      user_id: 8472,
      name: "Jordan Conner",
      handle: "jconner_trades",
    });
    const token = findActiveMentionToken("ping @Jordan Con", 16, {
      allowSpaces: true,
    });
    const inserted = replaceMentionToken(
      "ping @Jordan Con",
      token,
      selected.displayName
    );
    expect(inserted.text).toBe("ping @Jordan Conner ");

    const payload = buildCommentBody(inserted.text, {
      [selected.token]: selected.mention,
    });
    expect(payload).toEqual({
      body: "ping ${0} ",
      mentions: {
        0: { user_id: 8472, text: "@jconner_trades" },
      },
    });
  });

  it("preserves the identity of the selected person among duplicate names", () => {
    const selected = buildMentionSelection({
      id: 11,
      name: "Jordan Conner",
      handle: "jconner2",
    });
    expect(selected).toEqual({
      displayName: "Jordan Conner",
      token: "@Jordan Conner",
      mention: { user_id: 11, text: "@jconner2" },
    });
  });

  it("serializes two exact-name duplicates as distinct selected identities", () => {
    const text = "@Jordan Conner and @Jordan Conner";
    const selections = [
      {
        start: 0,
        end: 14,
        token: "@Jordan Conner",
        user_id: 10,
        text: "@jconner1",
      },
      {
        start: 19,
        end: 33,
        token: "@Jordan Conner",
        user_id: 11,
        text: "@jconner2",
      },
    ];
    expect(buildCommentBody(text, selections)).toEqual({
      body: "${0} and ${1}",
      mentions: {
        0: { user_id: 10, text: "@jconner1" },
        1: { user_id: 11, text: "@jconner2" },
      },
    });
  });

  it("makes a re-selection over the same visible occurrence authoritative", () => {
    const text = "@Jordan Conner ";
    const oldSelection = {
      start: 0,
      end: 14,
      token: "@Jordan Conner",
      user_id: 10,
      text: "@jconner1",
    };
    const replacementStart = 0;
    const replacementEnd = 14;
    const retained = [oldSelection].filter(
      (mention) =>
        mention.end <= replacementStart || mention.start >= replacementEnd
    );
    retained.push({
      start: 0,
      end: 14,
      token: "@Jordan Conner",
      user_id: 11,
      text: "@jconner2",
    });
    expect(buildCommentBody(text, retained)).toEqual({
      body: "${0} ",
      mentions: { 0: { user_id: 11, text: "@jconner2" } },
    });
  });

  it("keeps prefix names tied to their selected occurrence ranges", () => {
    const text = "@Ann Marie and @Ann";
    expect(
      buildCommentBody(text, [
        { start: 0, end: 10, token: "@Ann Marie", user_id: 1, text: "@annm" },
        { start: 15, end: 19, token: "@Ann", user_id: 2, text: "@ann" },
      ])
    ).toEqual({
      body: "${0} and ${1}",
      mentions: {
        0: { user_id: 1, text: "@annm" },
        1: { user_id: 2, text: "@ann" },
      },
    });
  });
});
