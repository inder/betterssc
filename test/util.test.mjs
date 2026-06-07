// Sanity tests for lib/util.js — verifies the test runner + happy-dom
// + module imports all work end to end.

import { describe, it, expect } from "vitest";
import {
  segmentBody,
  linkifyText,
  groupByAuthor,
  escapeHtml,
  mentionsUser,
  uuid,
} from "../lib/util.js";

describe("segmentBody", () => {
  it("returns a single text segment when there are no mentions", () => {
    const segs = segmentBody("hello world", null);
    expect(segs).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("expands ${N} placeholders into mention segments", () => {
    const segs = segmentBody("hi ${0} how are you", {
      0: { user_id: 42, text: "@bob" },
    });
    expect(segs).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", value: "@bob", userId: 42 },
      { type: "text", value: " how are you" },
    ]);
  });
});

describe("linkifyText", () => {
  it("returns a single text segment for plain text", () => {
    expect(linkifyText("just text")).toEqual([
      { type: "text", value: "just text" },
    ]);
  });

  it("splits text around URLs", () => {
    const parts = linkifyText("see https://example.com for info");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", value: "see " });
    expect(parts[1]).toEqual({ type: "link", value: "https://example.com" });
    expect(parts[2]).toEqual({ type: "text", value: " for info" });
  });

  it("detects $TICKER symbols and uppercases the symbol field", () => {
    const parts = linkifyText("buying $NASA today");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", value: "buying " });
    expect(parts[1]).toEqual({
      type: "ticker",
      value: "$NASA",
      symbol: "NASA",
    });
    expect(parts[2]).toEqual({ type: "text", value: " today" });
  });

  it("uppercases lowercase ticker writing", () => {
    const parts = linkifyText("watching $dxyz");
    expect(parts[1]).toEqual({
      type: "ticker",
      value: "$dxyz",
      symbol: "DXYZ",
    });
  });

  it("supports share-class tickers like $BRK.B", () => {
    const parts = linkifyText("hold $BRK.B forever");
    expect(parts[1]).toEqual({
      type: "ticker",
      value: "$BRK.B",
      symbol: "BRK.B",
    });
  });

  it("does NOT match dollar amounts like $5 or $100", () => {
    expect(linkifyText("paid $5 today")).toEqual([
      { type: "text", value: "paid $5 today" },
    ]);
    expect(linkifyText("$100k raise")).toEqual([
      { type: "text", value: "$100k raise" },
    ]);
  });

  it("does NOT match tickers preceded by a letter or digit", () => {
    expect(linkifyText("email$NASA bad")).toEqual([
      { type: "text", value: "email$NASA bad" },
    ]);
  });

  it("handles multiple tickers and a URL together", () => {
    const parts = linkifyText(
      "$NASA + $DXYZ chart: https://tradingview.com/chart"
    );
    const types = parts.map((p) => p.type);
    expect(types).toEqual(["ticker", "text", "ticker", "text", "link"]);
    expect(parts[0].symbol).toBe("NASA");
    expect(parts[2].symbol).toBe("DXYZ");
  });

  it("strips trailing punctuation from tickers", () => {
    const parts = linkifyText("loaded up on $NASA.");
    expect(parts[1]).toEqual({
      type: "ticker",
      value: "$NASA",
      symbol: "NASA",
    });
    expect(parts[2]).toEqual({ type: "text", value: "." });
  });

  it("only matches single-letter share classes ($BRK.BB degrades to $BRK)", () => {
    const parts = linkifyText("hold $BRK.BB now");
    expect(parts[1]).toEqual({
      type: "ticker",
      value: "$BRK",
      symbol: "BRK",
    });
    expect(parts[2]).toEqual({ type: "text", value: ".BB now" });
  });
});

describe("groupByAuthor", () => {
  it("groups consecutive messages by same author within 5 min", () => {
    const t0 = new Date("2026-06-06T12:00:00Z").toISOString();
    const t1 = new Date("2026-06-06T12:01:00Z").toISOString();
    const t2 = new Date("2026-06-06T12:02:00Z").toISOString();
    const groups = groupByAuthor([
      { id: "a", author: { id: 1, name: "Alice" }, created_at: t0 },
      { id: "b", author: { id: 1, name: "Alice" }, created_at: t1 },
      { id: "c", author: { id: 2, name: "Bob" }, created_at: t2 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  it("splits a group when the gap exceeds 5 minutes", () => {
    const t0 = new Date("2026-06-06T12:00:00Z").toISOString();
    const t1 = new Date("2026-06-06T12:10:00Z").toISOString();
    const groups = groupByAuthor([
      { id: "a", author: { id: 1, name: "Alice" }, created_at: t0 },
      { id: "b", author: { id: 1, name: "Alice" }, created_at: t1 },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("escapeHtml", () => {
  it("escapes HTML metacharacters", () => {
    expect(escapeHtml("<script>alert('x')</script>")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"
    );
  });
});

describe("mentionsUser", () => {
  it("matches @<name>", () => {
    expect(mentionsUser("hello @Boz, how are you", "Boz", "bozmode")).toBe(true);
  });
  it("matches bare name as word boundary", () => {
    expect(mentionsUser("hello Boz, how are you", "Boz", null)).toBe(true);
  });
  it("does not match substring", () => {
    expect(mentionsUser("Bobby is here", "Bo", null)).toBe(false);
  });
});

describe("uuid", () => {
  it("generates a v4 uuid", () => {
    const id = uuid();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
