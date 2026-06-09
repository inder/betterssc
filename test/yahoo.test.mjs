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

describe("fetchYahooQuotes", () => {
  it("returns empty Map for empty input", async () => {
    const proxyFn = vi.fn();
    const out = await fetchYahooQuotes([], proxyFn);
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
    expect(proxyFn).not.toHaveBeenCalled();
  });

  it("returns empty Map when proxy returns non-ok", async () => {
    const proxyFn = vi.fn(async () => ({ ok: false, status: 0 }));
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

  it("parses quote shape and keys by HUMAN symbol", async () => {
    const proxyFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({
        quoteResponse: {
          result: [
            {
              symbol: "AAPL",
              regularMarketPrice: 234.56,
              regularMarketChange: 2.34,
              regularMarketChangePercent: 1.01,
              marketState: "REGULAR",
              currency: "USD",
            },
            {
              symbol: "BTC-USD",
              regularMarketPrice: 67890.12,
              regularMarketChange: -1234.56,
              regularMarketChangePercent: -1.79,
              marketState: "REGULAR",
              currency: "USD",
            },
          ],
        },
      }),
    }));
    const out = await fetchYahooQuotes(["AAPL", "BTC"], proxyFn);
    expect(out.size).toBe(2);
    const aapl = out.get("AAPL");
    expect(aapl.price).toBe(234.56);
    expect(aapl.changePercent).toBeCloseTo(1.01);
    expect(aapl.currency).toBe("USD");
    // BTC-USD should map BACK to "BTC" via fromYahooSymbol.
    const btc = out.get("BTC");
    expect(btc.price).toBe(67890.12);
    expect(btc.changePercent).toBeCloseTo(-1.79);
  });

  it("batches requests of 10 symbols", async () => {
    const calls = [];
    const proxyFn = vi.fn(async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({ quoteResponse: { result: [] } }),
      };
    });
    const symbols = Array.from({ length: 25 }, (_, i) => `SYM${i}`);
    await fetchYahooQuotes(symbols, proxyFn);
    // 25 symbols / 10 per batch = 3 calls (10, 10, 5).
    expect(proxyFn).toHaveBeenCalledTimes(3);
    expect(calls[0]).toContain("symbols=");
  });

  it("silently survives proxy throwing", async () => {
    const proxyFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const out = await fetchYahooQuotes(["AAPL"], proxyFn);
    expect(out.size).toBe(0);
  });
});
