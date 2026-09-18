import { describe, it, expect } from "vitest";
import { deriveTradeRows, formatTradeTimeET, tradeBadge } from "../lib/trades-strip.js";

// 2026-09-18 12:00 ET (16:00Z) — a Friday, well inside the trading day.
const NOW = new Date("2026-09-18T16:00:00.000Z");
const c = (id, body, at, author = { id: 1, name: "Za" }, extra = {}) => ({ id, body, created_at: at, author, ...extra });
const strip = (r) => ({ id: r.id, kind: r.kind, action: r.action, qualifier: r.qualifier, tickers: r.tickers, authorId: r.authorId });

describe("deriveTradeRows — today (ET) filter", () => {
  it("keeps today's trades and drops yesterday's (ET boundary, not local)", () => {
    const rows = deriveTradeRows({
      comments: [
        c("a", "Bought CBRS", "2026-09-18T04:00:00.000Z"), // 00:00 ET today
        c("b", "Bought NVDA", "2026-09-18T03:59:00.000Z"), // 23:59 ET yesterday
      ],
      now: NOW,
    });
    expect(rows.map(strip)).toEqual([{ id: "a", kind: "comment", action: "BUY", qualifier: null, tickers: ["CBRS"], authorId: 1 }]);
  });
  it("returns [] for an invalid `now` or empty inputs", () => {
    expect(deriveTradeRows({ comments: [], now: new Date("nope") })).toEqual([]);
    expect(deriveTradeRows({ now: NOW })).toEqual([]);
    expect(deriveTradeRows({ comments: [c("a", "", "2026-09-18T14:00:00.000Z")], now: NOW })).toEqual([]);
  });
});

describe("deriveTradeRows — shape and ordering", () => {
  it("is newest-first, one row per trade, tickers copied", () => {
    const rows = deriveTradeRows({
      comments: [
        c("old", "sold NVDA, bought AMD", "2026-09-18T13:00:00.000Z"),
        c("new", "Bought: CBRS at 12.40", "2026-09-18T15:00:00.000Z"),
        c("chat", "good morning all", "2026-09-18T15:30:00.000Z"),
      ],
      now: NOW,
    });
    expect(rows.map((r) => [r.id, r.action, r.tickers.join("+")])).toEqual([
      ["new", "BUY", "CBRS"],
      ["old", "SELL", "NVDA"],
      ["old", "BUY", "AMD"],
    ]);
    expect(rows[0].raw).toBe("Bought: CBRS at 12.40");
    expect(rows[0].authorName).toBe("Za");
    expect(rows[0].confidence).toBe("high");
  });
  it("never mutates its inputs", () => {
    const comment = c("a", "Bought CBRS", "2026-09-18T14:00:00.000Z");
    const frozen = Object.freeze({ ...comment, author: Object.freeze({ ...comment.author }) });
    const threads = Object.freeze([Object.freeze({ communityPost: Object.freeze({ id: "p1", body: "Bought: NVDA", created_at: "2026-09-18T14:10:00.000Z", user_id: 7 }), user: Object.freeze({ id: 7, name: "Za" }) })]);
    const memo = new Map();
    const rows = deriveTradeRows({ comments: [frozen], channelThreads: threads, now: NOW, memo });
    expect(rows.length).toBe(2);
    rows[0].tickers.push("X"); // a caller mutating a row must not reach the MEMOIZED parse
    expect(deriveTradeRows({ comments: [frozen], channelThreads: threads, now: NOW, memo })[0].tickers).not.toContain("X");
  });
});

describe("deriveTradeRows — roots", () => {
  const root = { id: "p-cur", body: "Bought: CBRS In times of panic and chaos", created_at: "2026-09-18T14:24:00.000Z", user_id: 7, user: { id: 7, name: "Za" } };
  it("includes the current thread's root and the channel's roots, deduped by post id", () => {
    const rows = deriveTradeRows({
      comments: [],
      rootPost: root,
      channelThreads: [
        { communityPost: root, user: { id: 7, name: "Za" } }, // same post again
        { communityPost: { id: "p-other", body: "Bought: NVDA Stop: $207", created_at: "2026-09-18T13:49:00.000Z", user_id: 7 }, user: { id: 7, name: "Za" } },
        { communityPost: { id: "p-gm", body: "Good morning all! Futures are lower", created_at: "2026-09-18T10:19:00.000Z", user_id: 7 }, user: { id: 7, name: "Za" } },
        { communityPost: { id: "p-old", body: "Bought: TEM", created_at: "2026-09-10T13:43:00.000Z", user_id: 7 }, user: { id: 7, name: "Za" } },
      ],
      now: NOW,
    });
    expect(rows.map((r) => [r.kind, r.id, r.postUuid, r.tickers[0], r.authorId, r.authorName])).toEqual([
      ["root", "p-cur", "p-cur", "CBRS", 7, "Za"],
      ["root", "p-other", "p-other", "NVDA", 7, "Za"],
    ]);
  });
  it("falls back to communityPost.user_id when the thread has no user object", () => {
    const rows = deriveTradeRows({ channelThreads: [{ communityPost: { id: "p", body: "Bought: XYZ", created_at: "2026-09-18T14:00:00.000Z", user_id: 42 } }], now: NOW });
    expect(rows[0].authorId).toBe(42);
    expect(rows[0].authorName).toBeNull();
  });
});

describe("deriveTradeRows — pinned-only", () => {
  it("keeps only pinned authors, for comments AND roots", () => {
    const rows = deriveTradeRows({
      comments: [c("a", "Bought CBRS", "2026-09-18T14:00:00.000Z", { id: 1, name: "Za" }), c("b", "Bought NVDA", "2026-09-18T14:01:00.000Z", { id: 2, name: "Bob" })],
      channelThreads: [{ communityPost: { id: "p", body: "Bought: AMD", created_at: "2026-09-18T14:02:00.000Z", user_id: 2 }, user: { id: 2, name: "Bob" } }],
      now: NOW,
      pinnedOnly: true,
      pinnedIds: new Set([1]),
    });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });
  it("pinnedOnly with no pinned ids yields nothing; off yields everything", () => {
    const comments = [c("a", "Bought CBRS", "2026-09-18T14:00:00.000Z", { id: 1, name: "Za" })];
    expect(deriveTradeRows({ comments, now: NOW, pinnedOnly: true, pinnedIds: new Set() })).toEqual([]);
    expect(deriveTradeRows({ comments, now: NOW, pinnedOnly: false, pinnedIds: new Set() }).length).toBe(1);
  });
});

describe("deriveTradeRows — invariants", () => {
  it("never parses a quoted parent (invariant 2): body 'nice' + quote 'Bought: CBRS' → no rows", () => {
    const rows = deriveTradeRows({ comments: [c("r", "nice", "2026-09-18T14:00:00.000Z", { id: 1 }, { quote: { id: "q", body: "Bought: CBRS at 12.40" } })], now: NOW });
    expect(rows).toEqual([]);
  });
  it("skips pending and failed optimistic rows", () => {
    const rows = deriveTradeRows({
      comments: [
        c("tmp", "Bought CBRS", "2026-09-18T14:00:00.000Z", { id: 1 }, { _pending: true }),
        c("bad", "Bought NVDA", "2026-09-18T14:00:00.000Z", { id: 1 }, { _failed: true }),
        c("ok", "Bought AMD", "2026-09-18T14:00:00.000Z", { id: 1 }),
      ],
      now: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("deriveTradeRows — memo", () => {
  it("parses once per (id, body), re-parses on edit, and never holds a non-today row", () => {
    const memo = new Map();
    const today = c("a", "Bought CBRS", "2026-09-18T14:00:00.000Z");
    const yesterday = c("y", "Bought NVDA", "2026-09-17T14:00:00.000Z");
    deriveTradeRows({ comments: [today, yesterday], now: NOW, memo });
    expect(memo.size).toBe(1);
    expect(memo.get("a").trades[0].tickers).toEqual(["CBRS"]);
    const first = memo.get("a").trades;
    // Wholesale replacement with an identical body (reaction poll) → hit.
    deriveTradeRows({ comments: [{ ...today }], now: NOW, memo });
    expect(memo.get("a").trades).toBe(first);
    // Edited body → miss, re-parse.
    deriveTradeRows({ comments: [{ ...today, body: "Sold CBRS" }], now: NOW, memo });
    expect(memo.get("a").trades[0].action).toBe("SELL");
    expect(memo.has("y")).toBe(false);
  });
});

describe("formatTradeTimeET / tradeBadge", () => {
  it("renders the ET wall-clock time with a suffix", () => {
    expect(formatTradeTimeET("2026-09-18T12:47:00.000Z")).toBe("8:47 ET"); // EDT
    expect(formatTradeTimeET("2026-01-15T14:05:00.000Z")).toBe("9:05 ET"); // EST
    expect(formatTradeTimeET("garbage")).toBe("");
  });
  it("maps action/qualifier to a badge", () => {
    expect(tradeBadge("BUY", null).label).toBe("BUY");
    expect(tradeBadge("SELL", "closed").cls).toBe("sell-closed");
    expect(tradeBadge("SELL", "partial").emoji).toBe("🟠");
    expect(tradeBadge("SELL", null).label).toBe("SELL");
  });
});
