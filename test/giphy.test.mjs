// Unit tests for lib/giphy.js — Giphy v1 REST client + result filters.
//
// fetch is stubbed via vi.stubGlobal; no live API calls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchGiphyTrending,
  fetchGiphySearch,
  pickGifFromResult,
  pickGifsFromResponse,
  testGiphyKey,
  GIPHY_DEFAULT_LIMIT,
  GIPHY_DEFAULT_RATING,
  GIPHY_MAX_BYTES_DEFAULT,
} from "../lib/giphy.js";

// Helper: build a Giphy result entry with the goldens from the live
// 2026-06-11 trending response (re-anonymized).
function makeResult(opts = {}) {
  return {
    type: opts.type || "gif",
    id: opts.id || "abc123",
    title: opts.title || "Test GIF",
    images: {
      original: {
        url: opts.originalUrl || "https://media.giphy.com/.../giphy.gif",
        size: opts.size != null ? String(opts.size) : "1574305",
        width: "480",
        height: "480",
      },
      fixed_width_small: {
        url: opts.thumbnailUrl || "https://media.giphy.com/.../100w.gif",
        size: "96244",
      },
      preview_gif: {
        url: "https://media.giphy.com/.../preview.gif",
        size: "35994",
      },
      ...(opts.imagesExtras || {}),
    },
  };
}

function jsonOk(data) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      meta: { status: 200, msg: "OK" },
      data,
      pagination: { total_count: data.length, count: data.length, offset: 0 },
    }),
    text: async () => "",
  };
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// fetchGiphyTrending
// ---------------------------------------------------------------------------

describe("fetchGiphyTrending", () => {
  it("builds the right URL with api_key + limit + rating defaults", async () => {
    const fetchSpy = vi.fn(async () => jsonOk([makeResult()]));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchGiphyTrending("KEY1");
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("https://api.giphy.com/v1/gifs/trending?");
    expect(url).toContain("api_key=KEY1");
    expect(url).toContain(`limit=${GIPHY_DEFAULT_LIMIT}`);
    expect(url).toContain(`rating=${GIPHY_DEFAULT_RATING}`);
  });

  it("passes through custom limit + rating", async () => {
    const fetchSpy = vi.fn(async () => jsonOk([]));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchGiphyTrending("KEY1", { limit: 5, rating: "g" });
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("limit=5");
    expect(url).toContain("rating=g");
  });

  it("throws on missing API key (defense-in-depth — picker should pre-check)", async () => {
    await expect(fetchGiphyTrending(null)).rejects.toThrow(/missing API key/);
    await expect(fetchGiphyTrending("")).rejects.toThrow(/missing API key/);
  });

  it("throws a specific error on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }))
    );
    await expect(fetchGiphyTrending("BAD")).rejects.toThrow(/invalid or unauthorized/);
  });

  it("throws a specific error on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "" }))
    );
    await expect(fetchGiphyTrending("OK")).rejects.toThrow(/rate limit/);
  });

  it("surfaces other non-2xx as Giphy <status>: <body>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }))
    );
    await expect(fetchGiphyTrending("OK")).rejects.toThrow(/Giphy 500: boom/);
  });

  it("translates a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );
    await expect(fetchGiphyTrending("OK")).rejects.toThrow(/network error: ECONNRESET/);
  });
});

// ---------------------------------------------------------------------------
// fetchGiphySearch
// ---------------------------------------------------------------------------

describe("fetchGiphySearch", () => {
  it("URL-encodes the query and includes lang default 'en'", async () => {
    const fetchSpy = vi.fn(async () => jsonOk([makeResult()]));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchGiphySearch("KEY1", "rolling thunder");
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("/search?");
    // URLSearchParams encodes space as +
    expect(url).toMatch(/q=rolling\+thunder/);
    expect(url).toContain("lang=en");
  });

  it("trims whitespace from the query", async () => {
    const fetchSpy = vi.fn(async () => jsonOk([]));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchGiphySearch("KEY1", "  hi  ");
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("q=hi");
  });

  it("rejects empty / whitespace-only query (caller should short-circuit)", async () => {
    await expect(fetchGiphySearch("KEY1", "")).rejects.toThrow(/empty search/);
    await expect(fetchGiphySearch("KEY1", "   ")).rejects.toThrow(/empty search/);
    await expect(fetchGiphySearch("KEY1", null)).rejects.toThrow(/empty search/);
  });
});

// ---------------------------------------------------------------------------
// pickGifFromResult — the filter / shape-normalizer
// ---------------------------------------------------------------------------

describe("pickGifFromResult", () => {
  it("accepts a normal trending entry + returns the right fields", () => {
    const r = makeResult({ id: "X1", title: "Hello", size: 500_000 });
    const p = pickGifFromResult(r);
    expect(p).not.toBeNull();
    expect(p.id).toBe("X1");
    expect(p.title).toBe("Hello");
    expect(p.originalUrl).toBe(r.images.original.url);
    expect(p.thumbnailUrl).toBe(r.images.fixed_width_small.url);
    expect(p.size).toBe(500_000); // parsed from string
  });

  it("filters out non-gif types (videos, stickers)", () => {
    expect(pickGifFromResult(makeResult({ type: "video" }))).toBeNull();
    expect(pickGifFromResult(makeResult({ type: "sticker" }))).toBeNull();
  });

  it("filters out oversized GIFs by `size`", () => {
    const giant = makeResult({ size: 20 * 1024 * 1024 });
    expect(pickGifFromResult(giant)).toBeNull();
  });

  it("accepts a 9.9 MB GIF (cap = 10 MB)", () => {
    const big = makeResult({ size: 9.9 * 1024 * 1024 });
    expect(pickGifFromResult(big)).not.toBeNull();
  });

  it("respects a custom maxBytes argument", () => {
    const r = makeResult({ size: 500_000 });
    expect(pickGifFromResult(r, 100_000)).toBeNull();
    expect(pickGifFromResult(r, 1_000_000)).not.toBeNull();
  });

  it("rejects when original.size is missing / malformed", () => {
    const noSize = makeResult();
    delete noSize.images.original.size;
    expect(pickGifFromResult(noSize)).toBeNull();
    const badSize = makeResult();
    badSize.images.original.size = "not-a-number";
    expect(pickGifFromResult(badSize)).toBeNull();
  });

  it("rejects when original.url is missing", () => {
    const noUrl = makeResult();
    delete noUrl.images.original.url;
    expect(pickGifFromResult(noUrl)).toBeNull();
  });

  it("falls back to preview_gif when fixed_width_small is absent", () => {
    const r = makeResult();
    delete r.images.fixed_width_small;
    const p = pickGifFromResult(r);
    expect(p.thumbnailUrl).toBe(r.images.preview_gif.url);
  });

  it("falls back to original when both thumbnail variants are absent", () => {
    const r = makeResult();
    delete r.images.fixed_width_small;
    delete r.images.preview_gif;
    const p = pickGifFromResult(r);
    expect(p.thumbnailUrl).toBe(r.images.original.url);
  });

  it("returns null on null / non-object input", () => {
    expect(pickGifFromResult(null)).toBeNull();
    expect(pickGifFromResult(undefined)).toBeNull();
    expect(pickGifFromResult("not a result")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pickGifsFromResponse — array filter
// ---------------------------------------------------------------------------

describe("pickGifsFromResponse", () => {
  it("drops nulls from filtered results", () => {
    const json = {
      data: [
        makeResult({ id: "ok", size: 100_000 }),
        makeResult({ type: "video", id: "skip-video" }),
        makeResult({ id: "skip-big", size: 50 * 1024 * 1024 }),
        makeResult({ id: "ok2", size: 200_000 }),
      ],
    };
    const out = pickGifsFromResponse(json);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.id)).toEqual(["ok", "ok2"]);
  });

  it("returns [] on a malformed response (no data array)", () => {
    expect(pickGifsFromResponse(null)).toEqual([]);
    expect(pickGifsFromResponse({})).toEqual([]);
    expect(pickGifsFromResponse({ data: "not an array" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// testGiphyKey
// ---------------------------------------------------------------------------

describe("testGiphyKey", () => {
  it("returns {ok:true} on a successful trending ping", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonOk([makeResult()])));
    expect(await testGiphyKey("OK")).toEqual({ ok: true });
  });

  it("returns {ok:false, error} on 401 (invalid key)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }))
    );
    const res = await testGiphyKey("BAD");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid or unauthorized/);
  });

  it("returns {ok:false} on empty key without making a network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await testGiphyKey("")).toEqual({ ok: false, error: "No key entered" });
    expect(await testGiphyKey(null)).toEqual({ ok: false, error: "No key entered" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("constants — sanity guards", () => {
  it("max bytes default is 10 MB to match the composer cap", () => {
    expect(GIPHY_MAX_BYTES_DEFAULT).toBe(10 * 1024 * 1024);
  });
  it("default rating is pg-13 (Discord/Slack-friendly)", () => {
    expect(GIPHY_DEFAULT_RATING).toBe("pg-13");
  });
  it("default page limit is between 10 and 50 (Giphy beta cap)", () => {
    expect(GIPHY_DEFAULT_LIMIT).toBeGreaterThanOrEqual(10);
    expect(GIPHY_DEFAULT_LIMIT).toBeLessThanOrEqual(50);
  });
});
