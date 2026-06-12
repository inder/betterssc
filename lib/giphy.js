// Giphy v1 REST client for the BetterSSC GIF picker.
//
// All endpoints documented at developers.giphy.com/docs/api. BYOK
// (bring-your-own-key): the user creates a free API key at
// developers.giphy.com/dashboard, pastes it into BetterSSC settings,
// and we send it as the `api_key` query param on every request.
//
// Response goldens (verified live against the API 2026-06-11):
//
//   {
//     "meta": {"status": 200, "msg": "OK", "response_id": "..."},
//     "data": [
//       {
//         "type": "gif" | "video" | "sticker",  // filter to "gif"
//         "id": "328LsbHLaleBPb787h",
//         "title": "Confused Emily Blunt GIF…",
//         "images": {
//           "original":          {"url": "...giphy.gif", "size": "1574305", "width": "480", "height": "480"},
//           "fixed_width_small": {"url": "...100w.gif",  "size": "96244"},
//           "preview_gif":       {"url": "...preview.gif", "size": "35994"},
//           // ...many more variants we ignore
//         }
//       },
//       ...
//     ],
//     "pagination": {"total_count": 5000, "count": 25, "offset": 0}
//   }
//
// NOTE the `size` field is a STRING (`"1574305"`) — parseInt before
// arithmetic. Same for width/height.

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

// Cap mirrors COMPOSER_ATTACH_MAX_BYTES in app.js so we don't surface
// GIFs the upload path would reject. Fetched separately because lib/
// shouldn't import app.js.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// Limit per page. Beta keys cap at 50; we use 25 for fast picker load
// since the grid is the bottleneck (each thumbnail is a live GIF).
const DEFAULT_LIMIT = 25;

// Reasonable default rating filter. "g" is way too restrictive; "r"
// is explicit. "pg-13" matches Discord / Slack out-of-the-box defaults.
const DEFAULT_RATING = "pg-13";

// Build a Giphy URL with consistent encoding. Keys are appended verbatim
// — they're alphanumeric, no escaping needed, but URLSearchParams
// handles it for safety.
function buildGiphyUrl(path, params) {
  const qs = new URLSearchParams(params);
  return `${GIPHY_BASE}${path}?${qs.toString()}`;
}

// Generic JSON fetch with status-code-aware error messages so the
// picker can distinguish "bad key" (401/403) from "rate limited" (429)
// from "network is down."
async function giphyFetchJson(url, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    throw new Error(`Giphy network error: ${(e && e.message) || e}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Giphy: API key invalid or unauthorized");
  }
  if (res.status === 429) {
    throw new Error("Giphy: rate limit hit — wait a minute and try again");
  }
  if (!res.ok) {
    throw new Error(`Giphy ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

// /v1/gifs/trending — the picker's default landing view.
export async function fetchGiphyTrending(apiKey, opts = {}) {
  if (!apiKey) throw new Error("Giphy: missing API key");
  const url = buildGiphyUrl("/trending", {
    api_key: apiKey,
    limit: String(opts.limit || DEFAULT_LIMIT),
    rating: opts.rating || DEFAULT_RATING,
  });
  return giphyFetchJson(url, { signal: opts.signal });
}

// /v1/gifs/search — the user typed something in the search box.
// Empty / whitespace-only query falls back to trending (caller's job
// to short-circuit, but we error here as defense-in-depth).
export async function fetchGiphySearch(apiKey, query, opts = {}) {
  if (!apiKey) throw new Error("Giphy: missing API key");
  const q = (query || "").trim();
  if (!q) throw new Error("Giphy: empty search query");
  const url = buildGiphyUrl("/search", {
    api_key: apiKey,
    q,
    limit: String(opts.limit || DEFAULT_LIMIT),
    rating: opts.rating || DEFAULT_RATING,
    lang: opts.lang || "en",
  });
  return giphyFetchJson(url, { signal: opts.signal });
}

// Pure: pick the best fields from a Giphy result for downstream use.
// Filters out non-"gif" types (videos, stickers) and oversized GIFs
// before the user even sees them in the picker. Returns null on reject.
//
// `result` is one entry from data[]; `maxBytes` defaults to 10MB.
//
// Returns: {
//   id, title,
//   thumbnailUrl,        // for the grid (fixed_width_small, ~100KB)
//   originalUrl, size,   // for the upload (real GIF, image/gif)
// } or null when the result fails any filter.
export function pickGifFromResult(result, maxBytes = DEFAULT_MAX_BYTES) {
  if (!result || result.type !== "gif") return null;
  const images = result.images || {};
  const original = images.original;
  if (!original || !original.url) return null;
  // Size is a string in the API response. Parse before comparison;
  // missing/malformed size sorts as Infinity so we'd skip — Giphy
  // always populates it on real results, so absence = reject.
  const size = parseInt(original.size, 10);
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size > maxBytes) return null;
  // Thumbnail: prefer fixed_width_small (100w GIF, animated), fall
  // back to preview_gif (smaller, also animated). The user sees this
  // in the picker grid.
  const thumb =
    (images.fixed_width_small && images.fixed_width_small.url) ||
    (images.preview_gif && images.preview_gif.url) ||
    original.url;
  return {
    id: result.id,
    title: result.title || "GIF",
    thumbnailUrl: thumb,
    originalUrl: original.url,
    size,
  };
}

// Convenience: turn an API response into a clean array of picks.
// Applies pickGifFromResult to each entry and drops nulls. Caller
// typically wants this — the raw data[] is verbose and includes
// rejected entries.
export function pickGifsFromResponse(json, maxBytes = DEFAULT_MAX_BYTES) {
  if (!json || !Array.isArray(json.data)) return [];
  const out = [];
  for (const r of json.data) {
    const p = pickGifFromResult(r, maxBytes);
    if (p) out.push(p);
  }
  return out;
}

// Live key-validation ping used by the onboarding flow's "Test key"
// button. Returns { ok: true } on success, { ok: false, error } on
// failure. We use /trending with limit=1 to keep the round-trip tiny.
export async function testGiphyKey(apiKey, opts = {}) {
  if (!apiKey) return { ok: false, error: "No key entered" };
  try {
    const json = await fetchGiphyTrending(apiKey, { limit: 1, signal: opts.signal });
    if (json && json.meta && json.meta.status === 200) return { ok: true };
    return { ok: false, error: "Unexpected response shape" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "Unknown error" };
  }
}

// Public consts so the test suite + app.js can share the same defaults.
export const GIPHY_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const GIPHY_DEFAULT_RATING = DEFAULT_RATING;
export const GIPHY_MAX_BYTES_DEFAULT = DEFAULT_MAX_BYTES;
