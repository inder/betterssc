// Link unfurl (v0.7) — pure, testable helpers for the local, per-viewer link
// preview cards. The DOM rendering and the actual cross-origin fetch live in
// app.js; everything here is string-in / data-out so it unit-tests without a
// browser or a DOM.
//
// Design notes (see the v0.7 PR + project memory):
//   - Per-viewer + local-only: each client unfurls the links it sees, in its
//     own browser session. Nothing is written back to Substack.
//   - parseOgMetadata returns RAW attacker-controlled strings. The renderer
//     MUST place them via textContent (never innerHTML) — this module does no
//     escaping, by design, so callers can't accidentally double-escape.

// Cap how much of a URL we'll even consider — pasted data: blobs and
// pathological query strings aren't real article links. Mirrors the 500-char
// guard in app.js collectThreadLinks.
export const UNFURL_MAX_URL_LEN = 500;

// Cap how much HTML we parse for meta tags. OG/twitter tags live in <head>, so
// the first ~256KB is plenty; reading more just burns memory on huge pages.
export const UNFURL_MAX_HTML_BYTES = 256 * 1024;

// Field length caps so a hostile or runaway page can't push a megabyte of text
// into a card. Applied after decode.
export const UNFURL_MAX_TITLE_LEN = 300;
export const UNFURL_MAX_DESC_LEN = 600;

// Exclude () and [] from the URL body so a parenthesized link in prose
// ("(see https://reuters.com/x)") isn't truncated at the first ')'. Same
// regex shape app.js collectThreadLinks uses.
const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/i;
const URL_RE_G = /https?:\/\/[^\s<>"'()[\]]+/gi;

// Image extensions / known image hosts — these are handled by the attachment
// renderer (or Explain vision), never unfurled as article cards. Kept local to
// this module so it stays dependency-free and node-testable.
const IMAGE_URL_RE =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|#|$)/i;
const IMAGE_HOST_RE =
  /substack-post-media|substackcdn|substack-cdn|cloudfront|s3\.amazonaws|media[0-9]?\.giphy\.com/i;

function looksLikeImageUrl(url) {
  if (!url) return false;
  return IMAGE_URL_RE.test(url) || IMAGE_HOST_RE.test(url);
}

// Trim trailing sentence punctuation a user typed right after a URL
// ("check https://x.com/y." → drop the period). Matches app.js behavior.
function trimTrailingPunctuation(u) {
  return u.replace(/[.,;:!?]+$/, "");
}

// Pick the FIRST unfurlable link in a message body, or null. "Unfurlable" =
// http(s), not an image, within the length cap. First-link-wins keeps the card
// deterministic and avoids stacking N cards under a link-heavy message.
export function firstUnfurlableUrl(body) {
  if (!body || typeof body !== "string") return null;
  const matches = body.match(URL_RE_G);
  if (!matches) return null;
  for (let u of matches) {
    u = trimTrailingPunctuation(u);
    if (!u || u.length > UNFURL_MAX_URL_LEN) continue;
    if (looksLikeImageUrl(u)) continue;
    return u;
  }
  return null;
}

// Minimal, safe HTML-entity decode for the handful that show up in meta tag
// content. Numeric (decimal + hex) plus the five named entities. NOT a general
// HTML decoder — we only run it on short attribute-value strings, and the
// output is rendered via textContent so an un-decoded entity is cosmetic, not
// an injection vector.
export function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // &amp; LAST so "&amp;lt;" decodes to "&lt;", not "<".
    .replace(/&amp;/gi, "&");
}

function safeFromCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch (_) {
    return "";
  }
}

// Pull the `content` attribute of the first <meta> whose property/name matches
// any of `keys`. Order of `keys` is priority order. Attribute order within a
// tag varies (content before property, single vs double quotes), so we scan
// every <meta ...> tag and test both attributes.
function metaContent(html, keys) {
  // Consume quoted segments wholesale so a `>` inside a quoted attribute value
  // (e.g. content="a>b" or an entity-free "</script>") doesn't end the tag
  // early. Per HTML spec a tag ends only at a `>` outside any quotes.
  const metaRe = /<meta\b(?:"[^"]*"|'[^']*'|[^>])*>/gi;
  let m;
  const wanted = keys.map((k) => k.toLowerCase());
  // Collect first hit per key, then return by priority.
  const found = new Map();
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const key = (
      attr(tag, "property") ||
      attr(tag, "name") ||
      attr(tag, "itemprop") ||
      ""
    ).toLowerCase();
    if (!key || !wanted.includes(key)) continue;
    if (found.has(key)) continue;
    const content = attr(tag, "content");
    if (content != null) found.set(key, content);
  }
  for (const k of wanted) {
    if (found.has(k)) return found.get(k);
  }
  return null;
}

// Read a single attribute value from a tag string. Handles double-quoted,
// single-quoted, and unquoted forms.
function attr(tag, name) {
  // Negative lookbehind so `content` doesn't match inside `data-content` and
  // `property` doesn't match inside a hyphenated/prefixed attribute — a hostile
  // page could otherwise put `data-content="Fake"` before the real `content=`
  // to spoof the card text. (V8 has supported lookbehind since Chrome 62.)
  const re = new RegExp(
    "(?<![a-zA-Z0-9_-])" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i"
  );
  const m = tag.match(re);
  if (!m) return null;
  return m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : null;
}

// Resolve a possibly-relative image URL against the page's final URL. Returns
// only http(s) absolute URLs (drops data:, javascript:, protocol-relative
// without a base, etc.). null on anything we can't safely resolve.
export function resolveImageUrl(raw, finalUrl) {
  if (!raw || typeof raw !== "string") return null;
  let resolved;
  try {
    resolved = finalUrl ? new URL(raw, finalUrl).href : new URL(raw).href;
  } catch (_) {
    return null;
  }
  // https-only: the extension page is https, so an http image would be
  // mixed-content-blocked anyway, and we don't want to load a plaintext
  // tracking pixel from an arbitrary host.
  if (!/^https:\/\//i.test(resolved)) return null;
  return resolved;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch (_) {
    return "";
  }
}

function clamp(str, max) {
  if (!str) return "";
  const s = str.trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// Parse Open Graph / Twitter Card / <title> metadata out of a page's HTML.
// `finalUrl` is the post-redirect response URL (used to resolve relative
// images and to derive a site name). Returns null when there's nothing worth
// showing (no title AND no description), so the caller can negative-cache it.
//
// Returned strings are RAW — render them via textContent only.
export function parseOgMetadata(html, finalUrl) {
  if (!html || typeof html !== "string") return null;
  const head = html.length > UNFURL_MAX_HTML_BYTES
    ? html.slice(0, UNFURL_MAX_HTML_BYTES)
    : html;

  const rawTitle =
    metaContent(head, ["og:title", "twitter:title"]) || titleTag(head);
  const rawDesc =
    metaContent(head, ["og:description", "twitter:description", "description"]);
  const rawImage =
    metaContent(head, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
  const rawSite = metaContent(head, ["og:site_name"]);

  const title = clamp(decodeHtmlEntities(rawTitle || ""), UNFURL_MAX_TITLE_LEN);
  const description = clamp(
    decodeHtmlEntities(rawDesc || ""),
    UNFURL_MAX_DESC_LEN
  );

  // Nothing useful — let the caller negative-cache so it never refetches.
  if (!title && !description) return null;

  const image = resolveImageUrl(rawImage, finalUrl);
  const siteName =
    decodeHtmlEntities(rawSite || "").trim() || hostnameOf(finalUrl || "");

  return {
    title,
    description,
    image, // https? absolute URL or null
    siteName,
    url: finalUrl || null,
  };
}

function titleTag(html) {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1] : null;
}

// ─── X / Twitter status cards ────────────────────────────────────────────
//
// X serves us og:title="<Name> (@handle) on X", og:description=<tweet text>,
// and og:image=<the embedded media> (for a tweet WITH media) or <the author's
// avatar> (for a media-less tweet). That's enough to render a card that reads
// like a real tweet — name/handle header, full text, large media — without any
// API. The author avatar for a media tweet isn't in the OG tags, so we resolve
// it from the handle via unavatar.io.

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

// A valid X handle: 1–15 of [A-Za-z0-9_]. Used both to extract from the URL and
// to validate before building an unavatar URL (so we never interpolate junk).
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// If `url` is an X/Twitter *status* (tweet) URL, return { handle } (handle has
// no leading @). Otherwise null — a profile URL, search, etc. gets the generic
// card, not the tweet card.
export function parseXStatus(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  // /<handle>/status/<digits>  (also /statuses/ on very old links)
  const m = u.pathname.match(/^\/([^/]+)\/status(?:es)?\/\d+/);
  if (!m) return null;
  const handle = decodeURIComponent(m[1]);
  if (!X_HANDLE_RE.test(handle)) return null;
  return { handle };
}

// Strip the " (@handle) on X" / " on Twitter" suffix X appends to og:title,
// leaving just the display name. Falls back to the whole title if the pattern
// isn't present (X could change the format).
export function xAuthorName(ogTitle) {
  if (!ogTitle || typeof ogTitle !== "string") return "";
  const t = ogTitle.trim();
  // "Name (@handle) on X" or "Name (@handle) on Twitter"
  const m = t.match(/^(.*?)\s*\(@[A-Za-z0-9_]{1,15}\)\s+on\s+(?:X|Twitter)\s*$/i);
  if (m) return m[1].trim();
  // "Name on X" with no parenthesized handle
  const m2 = t.match(/^(.*?)\s+on\s+(?:X|Twitter)\s*$/i);
  if (m2) return m2[1].trim();
  return t;
}

// X uses pbs.twimg.com/profile_images/... for a media-less tweet's og:image
// (i.e. the image IS the avatar) and pbs.twimg.com/media/... (or other) for
// embedded media. This lets us tell whether og:image should sit in the avatar
// slot or render as large tweet media.
function isXAvatarImage(imageUrl) {
  return !!imageUrl && /\/profile_images\//i.test(imageUrl);
}

// Build the unavatar.io avatar URL for a handle, or null if the handle is
// unsafe. https only; the <img> loads with no referrer at render time.
export function unavatarUrl(handle) {
  if (!handle || !X_HANDLE_RE.test(handle)) return null;
  return "https://unavatar.io/twitter/" + encodeURIComponent(handle);
}

// Given an X status URL + already-parsed OG data, return the tweet-card fields,
// or null if `url` isn't an X status. Decides avatar vs. large-media from the
// og:image URL shape (see isXAvatarImage).
export function buildXInfo(url, og) {
  const s = parseXStatus(url);
  if (!s || !og) return null;
  const handle = s.handle;
  const name = xAuthorName(og.title) || handle;
  let avatarUrl = null;
  let media = null;
  if (og.image && isXAvatarImage(og.image)) {
    // Media-less tweet: og:image is the avatar itself.
    avatarUrl = og.image;
  } else if (og.image) {
    // Tweet with embedded media: render it large, resolve the avatar separately.
    media = og.image;
    avatarUrl = unavatarUrl(handle);
  } else {
    // No og:image at all: no large media, fall back to unavatar for the avatar.
    avatarUrl = unavatarUrl(handle);
  }
  return { name, handle: "@" + handle, avatarUrl, media };
}

// Exposed for callers/tests that want the single-match regex.
export { URL_RE };
