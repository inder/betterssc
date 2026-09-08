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
  chatNameAcronym,
  AI_MODERATION_DEBOUNCE_OPTIONS_MS,
  resolveAiModerationSettings,
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

  it("renders a handle mention as the cached real name when available", () => {
    const users = new Map([
      [42, { id: 42, name: "Jordan Conner", handle: "jconner_trades" }],
    ]);
    expect(
      segmentBody("hi ${0}", {
        0: { user_id: 42, text: "@jconner_trades" },
      }, users)
    ).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", value: "@Jordan Conner", userId: 42 },
    ]);
  });

  it("keeps handle text when no real-name metadata is available", () => {
    expect(
      segmentBody("hi ${0}", {
        0: { user_id: 42, text: "@jconner_trades" },
      })
    ).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", value: "@jconner_trades", userId: 42 },
    ]);
  });

  it("does not replace a useful handle with a synthetic cached name", () => {
    const users = new Map([
      [42, { id: 42, name: "User #42", handle: null, _nameFallback: true }],
    ]);
    expect(
      segmentBody("hi ${0}", {
        0: { user_id: 42, text: "@jconner_trades" },
      }, users)
    ).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", value: "@jconner_trades", userId: 42 },
    ]);
  });

  it("resolves numeric cached ids when the mention user id is a string", () => {
    const users = new Map([[42, { id: 42, name: "Jordan Conner" }]]);
    expect(
      segmentBody("${0}", {
        0: { user_id: "42", text: "@jconner_trades" },
      }, users)
    ).toEqual([
      { type: "mention", value: "@Jordan Conner", userId: "42" },
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

  // ===== Bare-ticker (no $) detection =====

  it("detects bare ALL-CAPS tickers from the allowlist", () => {
    const parts = linkifyText("buying AAPL today");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", value: "buying " });
    expect(parts[1]).toEqual({ type: "ticker", value: "AAPL", symbol: "AAPL" });
    expect(parts[2]).toEqual({ type: "text", value: " today" });
  });

  it("detects multiple bare tickers in one message", () => {
    const parts = linkifyText("BTC up, SPY flat, QQQ down");
    const tickers = parts.filter((p) => p.type === "ticker").map((p) => p.symbol);
    expect(tickers).toEqual(["BTC", "SPY", "QQQ"]);
  });

  it("does NOT match lowercase or mixed-case spellings", () => {
    expect(linkifyText("tsla up")).toEqual([
      { type: "text", value: "tsla up" },
    ]);
    expect(linkifyText("Meta announced")).toEqual([
      { type: "text", value: "Meta announced" },
    ]);
  });

  it("does NOT match ALL-CAPS words that aren't in the allowlist", () => {
    expect(linkifyText("OMG this is LOL")).toEqual([
      { type: "text", value: "OMG this is LOL" },
    ]);
  });

  it("respects word boundaries (TSLAQ is not TSLA)", () => {
    expect(linkifyText("TSLAQ rumors")).toEqual([
      { type: "text", value: "TSLAQ rumors" },
    ]);
  });

  it("strips trailing punctuation around bare tickers", () => {
    const parts = linkifyText("loaded up on TSLA.");
    expect(parts[0]).toEqual({ type: "text", value: "loaded up on " });
    expect(parts[1]).toEqual({ type: "ticker", value: "TSLA", symbol: "TSLA" });
    expect(parts[2]).toEqual({ type: "text", value: "." });
  });

  it("handles bare ticker + $ticker + URL together", () => {
    const parts = linkifyText("AAPL vs $MSFT — see https://example.com");
    const types = parts.map((p) => p.type);
    expect(types).toEqual(["ticker", "text", "ticker", "text", "link"]);
    expect(parts[0]).toEqual({ type: "ticker", value: "AAPL", symbol: "AAPL" });
    expect(parts[2]).toEqual({ type: "ticker", value: "$MSFT", symbol: "MSFT" });
  });

  it("matches META even though it's a common English word (allowlist accepts the FP risk)", () => {
    const parts = linkifyText("META beat earnings");
    expect(parts[0]).toEqual({ type: "ticker", value: "META", symbol: "META" });
  });

  it("matches bare ticker inside a URL's surrounding text without breaking the URL", () => {
    const parts = linkifyText("see https://example.com about TSLA");
    expect(parts).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://example.com" },
      { type: "text", value: " about " },
      { type: "ticker", value: "TSLA", symbol: "TSLA" },
    ]);
  });

  it("does NOT match tickers inside URLs (URL token wins)", () => {
    const parts = linkifyText("https://aapl.com/news");
    expect(parts).toEqual([
      { type: "link", value: "https://aapl.com/news" },
    ]);
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

describe("chatNameAcronym", () => {
  it("multi-word possessive name produces initials, drops the suffix 's'", () => {
    expect(chatNameAcronym("Za's Market Terminal")).toBe("ZMT");
    expect(chatNameAcronym("Boz's Bullpen")).toBe("BB");
  });

  it("drops common articles + connectors", () => {
    expect(chatNameAcronym("The Daily Stock")).toBe("DS");
    expect(chatNameAcronym("Stocks and Options")).toBe("SO");
    expect(chatNameAcronym("News of the Day")).toBe("ND");
  });

  it("preserves short ALL-CAPS tokens intact instead of taking just the first letter", () => {
    expect(chatNameAcronym("ETH Discussion")).toBe("ETHD");
    expect(chatNameAcronym("BTC Daily Talk")).toBe("BTCDT");
  });

  it("expands CamelCase into multi-word tokens", () => {
    expect(chatNameAcronym("TechBros")).toBe("TB");
    expect(chatNameAcronym("MarketWatchers")).toBe("MW");
  });

  it("single-word name returns the word as-is when short enough", () => {
    expect(chatNameAcronym("Bullpen")).toBe("Bullpen");
    expect(chatNameAcronym("ETH")).toBe("ETH");
  });

  it("single-word very long name gets truncated to 8 chars", () => {
    expect(chatNameAcronym("Investorsalpha")).toBe("Investor");
  });

  it("handles empty / null / non-string input", () => {
    expect(chatNameAcronym("")).toBe("Chat");
    expect(chatNameAcronym(null)).toBe("Chat");
    expect(chatNameAcronym(undefined)).toBe("Chat");
    expect(chatNameAcronym(42)).toBe("Chat");
  });

  it("handles pure-punctuation names by falling back to truncated alnum or 'Chat'", () => {
    expect(chatNameAcronym("!!!")).toBe("Chat");
    expect(chatNameAcronym("...365")).toBe("365");
  });

  it("strips emoji and non-alnum noise, keeps real words", () => {
    expect(chatNameAcronym("Stock Market 💰")).toBe("SM");
    // "DeFi" is CamelCase, expands to "De Fi" → 4 initials.
    expect(chatNameAcronym("Crypto / DeFi Talk")).toBe("CDFT");
  });

  it("is stable / deterministic across multiple calls", () => {
    const name = "Za's Market Terminal";
    expect(chatNameAcronym(name)).toBe(chatNameAcronym(name));
  });
});

describe("AI_MODERATION_DEBOUNCE_OPTIONS_MS", () => {
  it("is exactly the 4 values the settings <select> offers", () => {
    expect(AI_MODERATION_DEBOUNCE_OPTIONS_MS).toEqual([1000, 2000, 3000, 5000]);
  });
});

describe("resolveAiModerationSettings", () => {
  const current = { enabled: false, debounceMs: 2000, skip: false };

  it("adopts valid stored values for all 3 fields", () => {
    const res = {
      bssc_ai_moderation_enabled: true,
      bssc_ai_moderation_debounce_ms: 3000,
      bssc_ai_moderation_skip: true,
    };
    expect(resolveAiModerationSettings(res, current)).toEqual({
      enabled: true,
      debounceMs: 3000,
      skip: true,
    });
  });

  it("keeps the current value for a key entirely absent from storage (empty result, e.g. first-ever load)", () => {
    expect(resolveAiModerationSettings({}, current)).toEqual(current);
  });

  it("keeps the current debounce when the stored value isn't one of the 4 whitelisted options", () => {
    const res = { bssc_ai_moderation_debounce_ms: 4000 };
    expect(resolveAiModerationSettings(res, current).debounceMs).toBe(2000);
  });

  it("rejects a stored debounce of the right value but wrong type (string, not number)", () => {
    const res = { bssc_ai_moderation_debounce_ms: "2000" };
    expect(resolveAiModerationSettings(res, current).debounceMs).toBe(2000);
  });

  it("rejects a non-boolean stored value for enabled/skip and keeps current", () => {
    const res = {
      bssc_ai_moderation_enabled: "true",
      bssc_ai_moderation_skip: 1,
    };
    const resolved = resolveAiModerationSettings(res, current);
    expect(resolved.enabled).toBe(false);
    expect(resolved.skip).toBe(false);
  });

  it("resolves each field independently — one valid, one absent, one invalid, in the same call", () => {
    const res = {
      bssc_ai_moderation_enabled: true, // valid
      // debounce_ms absent
      bssc_ai_moderation_skip: "nope", // invalid type
    };
    expect(resolveAiModerationSettings(res, current)).toEqual({
      enabled: true,
      debounceMs: 2000,
      skip: false,
    });
  });

  it("round-trips through a chrome.storage.local-shaped get/set cycle", () => {
    // Mirrors test/setup.mjs's chromeStub.storage.local semantics: get()
    // omits absent keys from the result object rather than returning
    // `undefined` for them.
    const store = new Map();
    const set = (obj) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    };
    const get = (keys) => {
      const result = {};
      for (const k of keys) if (store.has(k)) result[k] = store.get(k);
      return result;
    };
    set({
      bssc_ai_moderation_enabled: true,
      bssc_ai_moderation_debounce_ms: 5000,
      bssc_ai_moderation_skip: false,
    });
    const loaded = get([
      "bssc_ai_moderation_enabled",
      "bssc_ai_moderation_debounce_ms",
      "bssc_ai_moderation_skip",
    ]);
    expect(resolveAiModerationSettings(loaded, current)).toEqual({
      enabled: true,
      debounceMs: 5000,
      skip: false,
    });
  });
});
