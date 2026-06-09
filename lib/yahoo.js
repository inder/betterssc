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
// proxyFn signature: async (url, init) => { ok, status, text } using
// the substack-tab proxy from lib/api.js. We pass it in as a dep so
// this module stays unit-testable without chrome.* APIs.
//
// Endpoint choice — v8 chart, NOT v7 quote:
// Yahoo locked down /v7/finance/quote in 2023-24 (requires a CSRF
// "crumb" cookie/token pair from yahoo.com or returns 401). The v8
// chart endpoint stays publicly accessible without auth and includes
// price + previousClose in its meta block — enough for our chip text.
// Trade-off: one request per symbol (no batching). At a 60s cache TTL
// this stays cheap.
const MAX_PARALLEL = 5;

async function fetchOneSymbol(humanSymbol, proxyFn) {
  const yahooSym = toYahooSymbol(humanSymbol);
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSym) +
    "?interval=1d&range=1d";
  try {
    const res = await proxyFn(url);
    if (!res || !res.ok) return null;
    let json;
    try {
      json = JSON.parse(res.text);
    } catch (_) {
      return null;
    }
    const result =
      json && json.chart && json.chart.result && json.chart.result[0];
    const meta = result && result.meta;
    if (!meta || meta.regularMarketPrice == null) return null;
    const price = meta.regularMarketPrice;
    const prevClose =
      meta.chartPreviousClose != null
        ? meta.chartPreviousClose
        : meta.previousClose;
    let change = null;
    let changePercent = null;
    if (prevClose != null && prevClose !== 0) {
      change = price - prevClose;
      changePercent = (change / prevClose) * 100;
    }
    return {
      symbol: humanSymbol,
      quote: {
        price,
        change,
        changePercent,
        marketState: null,
        currency: meta.currency || "USD",
        fetchedAt: null,
      },
    };
  } catch (_) {
    return null;
  }
}

export async function fetchYahooQuotes(humanSymbols, proxyFn) {
  if (!humanSymbols || !humanSymbols.length) return new Map();
  const out = new Map();
  // Fire requests in parallel groups of MAX_PARALLEL so we don't queue
  // all N executeScript calls at once on the proxy tab. The substack
  // proxy handles concurrency but this keeps it polite.
  for (let i = 0; i < humanSymbols.length; i += MAX_PARALLEL) {
    const group = humanSymbols.slice(i, i + MAX_PARALLEL);
    const results = await Promise.all(
      group.map((sym) => fetchOneSymbol(sym, proxyFn))
    );
    for (const r of results) {
      if (r) out.set(r.symbol, r.quote);
    }
  }
  return out;
}
