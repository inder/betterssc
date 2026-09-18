// Meta-test: every row of the committed corpus must hold under the CURRENT
// regex set. Real captures + natural negatives + hand-built adversarials +
// terse valids + formatting rows + ET-day rows. This is the mechanical gate
// for lib/trades.js — a regex change that flips a row fails here, on the
// next `npm test`, not in the next live dogfood.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseTradeMessage, etDateKey, isTodayET } from "../lib/trades.js";

// happy-dom shadows URL, so resolve the fixture from the repo root (vitest cwd)
// the way the other fixture-backed tests in this suite do.
const fixture = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/trade-messages.json"), "utf8"));
const strip = (t) => ({ action: t.action, qualifier: t.qualifier, tickers: t.tickers, confidence: t.confidence });

describe("trade-messages fixture — coverage floors", () => {
  it("has 20+ real positives, 10+ real natural negatives, and every failure mode M1..M12", () => {
    const real = fixture.rows.filter((r) => r.kind === "real" || r.kind === "root");
    expect(real.filter((r) => r.expect.length > 0).length).toBeGreaterThanOrEqual(20);
    expect(real.filter((r) => r.expect.length === 0).length).toBeGreaterThanOrEqual(10);
    const modes = new Set(fixture.rows.map((r) => r.mode));
    for (let i = 1; i <= 12; i++) expect(modes.has(`M${i}`)).toBe(true);
    expect(fixture.rows.filter((r) => r.kind === "terse").length).toBeGreaterThanOrEqual(3);
    expect(fixture.rows.filter((r) => r.kind === "root").length).toBeGreaterThanOrEqual(5);
    expect(fixture.dates.length).toBeGreaterThanOrEqual(5);
  });
  it("every positive expect entry pins a confidence (toEqual treats a missing key as undefined)", () => {
    for (const r of fixture.rows) for (const e of r.expect) expect(["high", "low"]).toContain(e.confidence);
  });
});

describe("parseTradeMessage — every fixture row", () => {
  for (const row of fixture.rows) {
    it(`[${row.id} ${row.kind}/${row.mode}] ${row.body.slice(0, 60).replace(/\n/g, " ")}`, () => {
      const got = parseTradeMessage(row.body).map(strip);
      expect(got).toEqual(row.expect);
    });
  }
  it("never emits a tickerless trade and always echoes raw", () => {
    for (const row of fixture.rows) {
      for (const t of parseTradeMessage(row.body)) {
        expect(t.tickers.length).toBeGreaterThan(0);
        expect(t.raw).toBe(row.body);
        expect(["BUY", "SELL"]).toContain(t.action);
        expect([null, "closed", "partial"]).toContain(t.qualifier);
        expect(typeof t.verb).toBe("string");
      }
    }
  });
  it("confidence is 'low' only when a ticker came through the lowercase path", () => {
    const conf = (b) => parseTradeMessage(b).map((t) => t.confidence);
    expect(conf("Bought CBRS")).toEqual(["high"]);
    expect(conf("bought $orcu")).toEqual(["high"]);
    expect(conf("Bought MO")).toEqual(["high"]);
    expect(conf("bought orcu")).toEqual(["low"]);
    expect(conf("Trim mull")).toEqual(["low"]);
    expect(conf("Covered tna and tqqq short.")).toEqual(["low"]);
    expect(conf("sold NVDA, bought amd")).toEqual(["high", "low"]);
  });
  it("non-string input → []", () => {
    expect(parseTradeMessage(undefined)).toEqual([]);
    expect(parseTradeMessage(null)).toEqual([]);
    expect(parseTradeMessage(42)).toEqual([]);
    expect(parseTradeMessage("")).toEqual([]);
  });
});

describe("etDateKey / isTodayET — every fixture date row", () => {
  for (const d of fixture.dates) {
    it(`[${d.id}] ${d.note || d.iso}`, () => {
      expect(etDateKey(d.iso)).toBe(d.key);
      expect(isTodayET(d.iso, new Date(d.now))).toBe(d.today);
    });
  }
  it("accepts Date objects and rejects other types", () => {
    expect(etDateKey(new Date("2026-09-18T04:00:00.000Z"))).toBe("2026-09-18");
    expect(etDateKey(new Date("nope"))).toBeNull();
    expect(etDateKey(123)).toBeNull();
    expect(etDateKey(undefined)).toBeNull();
    expect(isTodayET(undefined)).toBe(false);
  });
  it("isTodayET defaults `now` to the real clock", () => {
    // Two instants an hour apart agree on the ET day except in the single
    // hour before ET midnight — assert whichever side of that we are on.
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 36e5);
    expect(isTodayET(hourAgo)).toBe(etDateKey(hourAgo) === etDateKey(now));
    expect(isTodayET(now)).toBe(true);
  });
});
