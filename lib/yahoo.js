// Yahoo Finance quote fetcher. Used by the inline ticker price chips
// rendered next to $TICKER and bare-ticker links in chat messages.
//
// Privacy / architecture: the fetch runs via the existing proxy-tab
// pattern in lib/api.js — chrome.scripting.executeScript in the MAIN
// world on an open substack.com tab. The HTTP request actually goes
// from substack.com → yahoo.com (not from the extension page directly).
// This avoids needing a new host_permissions grant on user upgrade.
// Trade-off: only works while a Substack tab is open. When no tab is
// available, fetches fail silently and ticker chips stay empty.
//
// Yahoo's v7 quote endpoint sometimes blocks CORS depending on origin
// and time of day. The pattern here is best-effort: on any failure,
// return an empty array, let the caller leave the chip blank, and try
// again on the next render cycle (debounced + cached so we don't spam).

// Yahoo uses idiosyncratic symbol formats that don't match the
// US-market tickers humans type in chat. Map them at fetch time so
// the cache + UI stay keyed on the original (human) symbol.
const YAHOO_SYMBOL_MAP = {
  // Cryptos — Yahoo's spot quote is "<TICKER>-USD".
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  XRP: "XRP-USD",
  ADA: "ADA-USD",
  DOT: "DOT-USD",
  AVAX: "AVAX-USD",
  MATIC: "MATIC-USD",
  DOGE: "DOGE-USD",
  SHIB: "SHIB-USD",
  LINK: "LINK-USD",
  ATOM: "ATOM-USD",
  ALGO: "ALGO-USD",
  NEAR: "NEAR-USD",
  LTC: "LTC-USD",
  BCH: "BCH-USD",
  BNB: "BNB-USD",
  INJ: "INJ-USD",
  RNDR: "RNDR-USD",
  ORDI: "ORDI-USD",

  // Indices — Yahoo prefixes with caret.
  SPX: "^GSPC",
  NDX: "^NDX",
  RUT: "^RUT",
  VIX: "^VIX",
  DXY: "DX-Y.NYB",
  DJI: "^DJI",
  COMP: "^IXIC",
  TNX: "^TNX",
  HSI: "^HSI",
  FTSE: "^FTSE",
  DAX: "^GDAXI",
};

export function toYahooSymbol(symbol) {
  return YAHOO_SYMBOL_MAP[symbol] || symbol;
}

// Reverse map for "Yahoo returned this symbol, what was the original?"
export function fromYahooSymbol(yahooSymbol) {
  for (const [orig, yahoo] of Object.entries(YAHOO_SYMBOL_MAP)) {
    if (yahoo === yahooSymbol) return orig;
  }
  return yahooSymbol;
}

// NYSE market hours, roughly. Used by the caller to pick cache TTL
// (60s during market hours, 5 min when closed). DST-tolerant via a
// wide UTC window — we don't need minute-perfect, just "are we close
// to NYSE open?". Weekends always closed.
export function isMarketHours() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 13:30 UTC = 9:30 ET (DST), 14:30 UTC = 9:30 ET (standard).
  // 20:00 UTC = 16:00 ET (DST), 21:00 UTC = 16:00 ET (standard).
  // Forgiving window covers both DST states.
  return utcMin >= 13 * 60 + 30 && utcMin <= 21 * 60;
}

// Fetch quotes for an array of human symbols. Returns a Map keyed by
// the human symbol with quote data, or an empty Map on any failure.
//
// proxyFn signature: async (path, init) => { ok, status, text } using
// the substack-tab proxy from lib/api.js. We pass it in as a dep so
// this module stays unit-testable without chrome.* APIs.
export async function fetchYahooQuotes(humanSymbols, proxyFn) {
  if (!humanSymbols || !humanSymbols.length) return new Map();
  const yahooSyms = humanSymbols.map(toYahooSymbol);
  const out = new Map();
  // Yahoo's v7 quote accepts comma-separated symbols. Cap per request
  // at 10 to keep URL length and parse time reasonable.
  const BATCH = 10;
  for (let i = 0; i < yahooSyms.length; i += BATCH) {
    const slice = yahooSyms.slice(i, i + BATCH);
    // FULL URL — proxyFn (proxyFetchAbsolute) hands this verbatim to a
    // fetch() inside the substack.com tab's MAIN world.
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(slice.join(","));
    try {
      const res = await proxyFn(url);
      if (!res) {
        // eslint-disable-next-line no-console
        console.warn("[BetterSSC] Yahoo quote: proxy returned no response", { url });
        continue;
      }
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn("[BetterSSC] Yahoo quote: non-ok response", {
          status: res.status,
          error: res.error,
          textPreview: (res.text || "").slice(0, 200),
          url,
        });
        continue;
      }
      let json;
      try {
        json = JSON.parse(res.text);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[BetterSSC] Yahoo quote: JSON parse failed", {
          textPreview: (res.text || "").slice(0, 200),
          url,
        });
        continue;
      }
      const results =
        (json && json.quoteResponse && json.quoteResponse.result) || [];
      if (!results.length) {
        // eslint-disable-next-line no-console
        console.warn("[BetterSSC] Yahoo quote: empty result array", {
          jsonPreview: JSON.stringify(json).slice(0, 200),
          url,
        });
      }
      for (const r of results) {
        if (!r || !r.symbol) continue;
        const human = fromYahooSymbol(r.symbol);
        out.set(human, {
          price: r.regularMarketPrice,
          change: r.regularMarketChange,
          changePercent: r.regularMarketChangePercent,
          marketState: r.marketState || null,
          currency: r.currency || "USD",
          fetchedAt: null, // caller stamps with its own clock
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[BetterSSC] Yahoo quote: threw", {
        message: (e && e.message) || String(e),
        url,
      });
    }
  }
  return out;
}
