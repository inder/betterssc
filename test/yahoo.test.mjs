// Unit tests for lib/yahoo.js — Yahoo Finance quote fetcher.

import { describe, it, expect, vi } from "vitest";
import {
  toYahooSymbol,
  fromYahooSymbol,
  isMarketHours,
  fetchYahooQuotes,
} from "../lib/yahoo.js";

describe("toYahooSymbol", () => {
  it("maps crypto tickers to <SYMBOL>-USD form", () => {
    expect(toYahooSymbol("BTC")).toBe("BTC-USD");
    expect(toYahooSymbol("ETH")).toBe("ETH-USD");
    expect(toYahooSymbol("DOGE")).toBe("DOGE-USD");
    expect(toYahooSymbol("SHIB")).toBe("SHIB-USD");
  });

  it("maps indices to caret-prefixed form", () => {
    expect(toYahooSymbol("SPX")).toBe("^GSPC");
    expect(toYahooSymbol("NDX")).toBe("^NDX");
    expect(toYahooSymbol("VIX")).toBe("^VIX");
    expect(toYahooSymbol("DJI")).toBe("^DJI");
  });

  it("passes ordinary stock + ETF tickers through unchanged", () => {
    expect(toYahooSymbol("AAPL")).toBe("AAPL");
    expect(toYahooSymbol("TSLA")).toBe("TSLA");
    expect(toYahooSymbol("SPY")).toBe("SPY");
    expect(toYahooSymbol("QQQ")).toBe("QQQ");
    expect(toYahooSymbol("SOXL")).toBe("SOXL");
  });
});

describe("fromYahooSymbol", () => {
  it("reverses mapped crypto symbols", () => {
    expect(fromYahooSymbol("BTC-USD")).toBe("BTC");
    expect(fromYahooSymbol("ETH-USD")).toBe("ETH");
  });

  it("reverses mapped indices", () => {
    expect(fromYahooSymbol("^GSPC")).toBe("SPX");
    expect(fromYahooSymbol("^NDX")).toBe("NDX");
  });

  it("passes ordinary tickers through unchanged", () => {
    expect(fromYahooSymbol("AAPL")).toBe("AAPL");
    expect(fromYahooSymbol("TSLA")).toBe("TSLA");
  });
});

describe("isMarketHours", () => {
  it("returns a boolean", () => {
    expect(typeof isMarketHours()).toBe("boolean");
  });
  // Time-dependent — only verify shape. The actual hours logic is a
  // simple UTC window check; if it ever needs more sophistication
  // (holidays, half-days) we'd test with frozen Date.now mocks.
});

// Helper — build a v8 chart response with the meta block we read.
function v8Response(symbol, price, prevClose) {
  return {
    ok: true,
    status: 200,
    text: JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              symbol,
              regularMarketPrice: price,
              chartPreviousClose: prevClose,
              currency: "USD",
            },
          },
        ],
        error: null,
      },
    }),
  };
}

describe("fetchYahooQuotes", () => {
  it("returns empty Map for empty input", async () => {
    const proxyFn = vi.fn();
    const out = await fetchYahooQuotes([], proxyFn);
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
    expect(proxyFn).not.toHaveBeenCalled();
  });

  it("returns empty Map when proxy returns non-ok for all symbols", async () => {
    const proxyFn = vi.fn(async () => ({ ok: false, status: 401 }));
    const out = await fetchYahooQuotes(["AAPL", "MSFT"], proxyFn);
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
  });

  it("returns empty Map when proxy returns invalid JSON", async () => {
    const proxyFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: "not json{{",
    }));
    const out = await fetchYahooQuotes(["AAPL"], proxyFn);
    expect(out.size).toBe(0);
  });

  it("parses v8 chart meta shape and keys by HUMAN symbol", async () => {
    const proxyFn = vi.fn(async (url) => {
      if (url.includes("AAPL")) return v8Response("AAPL", 234.56, 232.22);
      if (url.includes("BTC-USD"))
        return v8Response("BTC-USD", 67890.12, 69124.68);
      return { ok: false, status: 404 };
    });
    const out = await fetchYahooQuotes(["AAPL", "BTC"], proxyFn);
    expect(out.size).toBe(2);
    const aapl = out.get("AAPL");
    expect(aapl.price).toBe(234.56);
    expect(aapl.changePercent).toBeCloseTo(((234.56 - 232.22) / 232.22) * 100);
    expect(aapl.currency).toBe("USD");
    // BTC-USD should map BACK to "BTC" via the human-symbol key.
    const btc = out.get("BTC");
    expect(btc.price).toBe(67890.12);
    expect(btc.changePercent).toBeLessThan(0);
  });

  it("fires one request per symbol (no batching with v8 chart)", async () => {
    const proxyFn = vi.fn(async () => v8Response("X", 100, 100));
    const symbols = Array.from({ length: 12 }, (_, i) => `SYM${i}`);
    await fetchYahooQuotes(symbols, proxyFn);
    expect(proxyFn).toHaveBeenCalledTimes(12);
  });

  it("survives a proxy throwing on one symbol while others succeed", async () => {
    const proxyFn = vi.fn(async (url) => {
      if (url.includes("BAD")) throw new Error("network down");
      return v8Response("OK", 50, 49);
    });
    const out = await fetchYahooQuotes(["OK", "BAD"], proxyFn);
    expect(out.size).toBe(1);
    expect(out.has("OK")).toBe(true);
    expect(out.has("BAD")).toBe(false);
  });

  it("skips entries without regularMarketPrice", async () => {
    const proxyFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({
        chart: { result: [{ meta: { symbol: "X", currency: "USD" } }] },
      }),
    }));
    const out = await fetchYahooQuotes(["X"], proxyFn);
    expect(out.size).toBe(0);
  });
});
