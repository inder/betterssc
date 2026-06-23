import { describe, it, expect } from "vitest";
import {
  firstUnfurlableUrl,
  parseOgMetadata,
  decodeHtmlEntities,
  resolveImageUrl,
  UNFURL_MAX_URL_LEN,
  UNFURL_MAX_TITLE_LEN,
  UNFURL_MAX_DESC_LEN,
} from "../lib/unfurl.js";

describe("firstUnfurlableUrl", () => {
  it("returns null for empty / non-string / no-link bodies", () => {
    expect(firstUnfurlableUrl("")).toBe(null);
    expect(firstUnfurlableUrl(null)).toBe(null);
    expect(firstUnfurlableUrl(undefined)).toBe(null);
    expect(firstUnfurlableUrl(42)).toBe(null);
    expect(firstUnfurlableUrl("no links here, just $NVDA chatter")).toBe(null);
  });

  it("picks the FIRST http(s) link in the body", () => {
    expect(
      firstUnfurlableUrl("read https://reuters.com/a then https://bloomberg.com/b")
    ).toBe("https://reuters.com/a");
  });

  it("trims trailing sentence punctuation", () => {
    expect(firstUnfurlableUrl("see https://example.com/x.")).toBe(
      "https://example.com/x"
    );
    expect(firstUnfurlableUrl("(https://example.com/y),")).toBe(
      "https://example.com/y"
    );
  });

  it("does not truncate a parenthesized link at the first paren", () => {
    // The () exclusion in the regex means the trailing ) is simply not part of
    // the match — the URL itself (no internal parens) comes through whole.
    expect(firstUnfurlableUrl("(see https://reuters.com/markets/foo)")).toBe(
      "https://reuters.com/markets/foo"
    );
  });

  it("skips image URLs by extension and by known image host", () => {
    expect(
      firstUnfurlableUrl("pic https://cdn.site.com/a.png and https://reuters.com/b")
    ).toBe("https://reuters.com/b");
    expect(
      firstUnfurlableUrl("https://x.substackcdn.com/image/foo then https://reuters.com/b")
    ).toBe("https://reuters.com/b");
    expect(firstUnfurlableUrl("only an image https://media1.giphy.com/x.gif")).toBe(
      null
    );
  });

  it("skips a link over the length cap and falls through to the next", () => {
    const huge = "https://x.com/" + "a".repeat(UNFURL_MAX_URL_LEN + 5);
    expect(firstUnfurlableUrl(`${huge} https://reuters.com/ok`)).toBe(
      "https://reuters.com/ok"
    );
  });

  it("ignores non-http schemes", () => {
    expect(firstUnfurlableUrl("ftp://x.com/a mailto:me@x.com")).toBe(null);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named entities, & last so &amp;lt; -> &lt;", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("a &lt;b&gt; c")).toBe("a <b> c");
    expect(decodeHtmlEntities("&quot;hi&quot;")).toBe('"hi"');
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("decodes decimal and hex numeric references", () => {
    expect(decodeHtmlEntities("&#8212;")).toBe("—"); // em dash
    expect(decodeHtmlEntities("&#x2014;")).toBe("—");
    expect(decodeHtmlEntities("caf&#xe9;")).toBe("café");
  });

  it("drops out-of-range / garbage code points instead of throwing", () => {
    expect(decodeHtmlEntities("&#xFFFFFFFF;")).toBe("");
    expect(decodeHtmlEntities("&#999999999;")).toBe("");
  });
});

describe("resolveImageUrl", () => {
  it("resolves relative paths against the final URL", () => {
    expect(resolveImageUrl("/img/x.png", "https://site.com/article/1")).toBe(
      "https://site.com/img/x.png"
    );
    expect(resolveImageUrl("og.jpg", "https://site.com/a/b")).toBe(
      "https://site.com/a/og.jpg"
    );
  });

  it("passes through absolute http(s) URLs", () => {
    expect(resolveImageUrl("https://cdn.com/x.png", "https://site.com/a")).toBe(
      "https://cdn.com/x.png"
    );
  });

  it("rejects non-http schemes (data:, javascript:)", () => {
    expect(resolveImageUrl("data:image/png;base64,AAAA", "https://site.com/")).toBe(
      null
    );
    expect(resolveImageUrl("javascript:alert(1)", "https://site.com/")).toBe(null);
  });

  it("rejects http:// images (https-only — no plaintext tracking pixels)", () => {
    expect(resolveImageUrl("http://tracker.com/1x1.gif", "https://site.com/")).toBe(
      null
    );
    // protocol-relative resolved against an http base also drops out
    expect(resolveImageUrl("//cdn.com/img.jpg", "http://old.site.com/")).toBe(null);
  });

  it("returns null for empty / unresolvable input", () => {
    expect(resolveImageUrl("", "https://site.com/")).toBe(null);
    expect(resolveImageUrl(null, "https://site.com/")).toBe(null);
    expect(resolveImageUrl("/rel.png", null)).toBe(null); // no base, not absolute
  });
});

describe("parseOgMetadata — happy paths", () => {
  it("extracts og:title / og:description / og:image / og:site_name", () => {
    const html = `<html><head>
      <meta property="og:title" content="Markets rally" />
      <meta property="og:description" content="Stocks up on data" />
      <meta property="og:image" content="https://cdn.com/hero.jpg" />
      <meta property="og:site_name" content="Reuters" />
    </head></html>`;
    const r = parseOgMetadata(html, "https://reuters.com/markets/1");
    expect(r).toEqual({
      title: "Markets rally",
      description: "Stocks up on data",
      image: "https://cdn.com/hero.jpg",
      siteName: "Reuters",
      url: "https://reuters.com/markets/1",
    });
  });

  it("falls back to twitter:* tags when og:* absent", () => {
    const html = `<head>
      <meta name="twitter:title" content="TW title">
      <meta name="twitter:description" content="TW desc">
      <meta name="twitter:image" content="https://cdn.com/t.png">
    </head>`;
    const r = parseOgMetadata(html, "https://x.com/y");
    expect(r.title).toBe("TW title");
    expect(r.description).toBe("TW desc");
    expect(r.image).toBe("https://cdn.com/t.png");
    expect(r.siteName).toBe("x.com");
  });

  it("falls back to <title> when no meta title, derives site from host", () => {
    const html = `<head><title>Just a title</title>
      <meta name="description" content="plain desc"></head>`;
    const r = parseOgMetadata(html, "https://www.example.com/a");
    expect(r.title).toBe("Just a title");
    expect(r.description).toBe("plain desc");
    expect(r.siteName).toBe("example.com"); // www. stripped
    expect(r.image).toBe(null);
  });

  it("handles single-quoted and unquoted attribute values", () => {
    const html =
      "<meta property='og:title' content='Single quoted'>" +
      "<meta property=og:description content=unquoted>";
    const r = parseOgMetadata(html, "https://s.com/");
    expect(r.title).toBe("Single quoted");
    expect(r.description).toBe("unquoted");
  });

  it("handles content-before-property attribute order", () => {
    const html = `<meta content="Backwards" property="og:title">`;
    const r = parseOgMetadata(html, "https://s.com/");
    expect(r.title).toBe("Backwards");
  });

  it("is not spoofed by a data-content shadow attribute before content", () => {
    // Hostile page tries to make us read data-content instead of content.
    const html = `<meta property="og:title" data-content="Fake" content="Real">`;
    const r = parseOgMetadata(html, "https://s.com/");
    expect(r.title).toBe("Real");
  });

  it("resolves a relative og:image against the final URL", () => {
    const html = `<meta property="og:title" content="T">
      <meta property="og:image" content="/assets/og.png">`;
    const r = parseOgMetadata(html, "https://site.com/blog/post");
    expect(r.image).toBe("https://site.com/assets/og.png");
  });

  it("decodes entities in title/description", () => {
    const html = `<meta property="og:title" content="Tom &amp; Jerry &#8212; live">
      <meta property="og:description" content="&quot;quoted&quot;">`;
    const r = parseOgMetadata(html, "https://s.com/");
    expect(r.title).toBe("Tom & Jerry — live");
    expect(r.description).toBe('"quoted"');
  });

  it("description-only (no title) still returns a card", () => {
    const html = `<meta property="og:description" content="only desc">`;
    const r = parseOgMetadata(html, "https://s.com/");
    expect(r.title).toBe("");
    expect(r.description).toBe("only desc");
  });
});

describe("parseOgMetadata — null / empty cases (negative-cacheable)", () => {
  it("returns null when there is no title AND no description", () => {
    expect(parseOgMetadata("<html><head></head></html>", "https://s.com/")).toBe(
      null
    );
    expect(parseOgMetadata("", "https://s.com/")).toBe(null);
    expect(parseOgMetadata(null, "https://s.com/")).toBe(null);
  });

  it("treats a meta tag with no content attribute as absent", () => {
    const html = `<meta property="og:title"><meta property="og:image" content="https://c/x.png">`;
    expect(parseOgMetadata(html, "https://s.com/")).toBe(null);
  });
});

describe("parseOgMetadata — adversarial / hostile inputs", () => {
  // The parser does NOT sanitize — it returns raw strings, and the RENDERER
  // places them via textContent. These tests pin that the raw (un-executed)
  // string comes through verbatim so the textContent contract is the only
  // thing standing between us and XSS — make that contract explicit.
  it("returns a raw <script>-bearing og:title verbatim (quoted > not tag-end)", () => {
    const html = `<meta property="og:title" content="<script>alert(1)</script>">`;
    const r = parseOgMetadata(html, "https://evil.com/");
    expect(r.title).toBe("<script>alert(1)</script>"); // raw, not executed; render escapes it
  });

  it("returns an ENTITY-ENCODED script payload decoded but inert (real vector)", () => {
    // What a hostile page actually serves: < and > encoded in the attribute.
    const html = `<meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;">`;
    const r = parseOgMetadata(html, "https://evil.com/");
    expect(r.title).toBe("<script>alert(1)</script>"); // decoded text; textContent neutralizes it
  });

  it("does not let an img onerror payload smuggle through as image", () => {
    const html = `<meta property="og:title" content="x">
      <meta property="og:image" content="javascript:alert(1)//x.png">`;
    const r = parseOgMetadata(html, "https://evil.com/");
    expect(r.image).toBe(null); // non-http(s) scheme rejected
  });

  it("clamps a runaway title/description to the field cap", () => {
    const bigTitle = "T".repeat(UNFURL_MAX_TITLE_LEN + 500);
    const bigDesc = "D".repeat(UNFURL_MAX_DESC_LEN + 500);
    const html = `<meta property="og:title" content="${bigTitle}">
      <meta property="og:description" content="${bigDesc}">`;
    const r = parseOgMetadata(html, "https://s.com/");
    expect(r.title.length).toBeLessThanOrEqual(UNFURL_MAX_TITLE_LEN);
    expect(r.description.length).toBeLessThanOrEqual(UNFURL_MAX_DESC_LEN);
    expect(r.title.endsWith("…")).toBe(true);
  });

  it("only parses meta within the byte cap (tags past the cap are ignored)", () => {
    const filler = "<!-- " + "x".repeat(300 * 1024) + " -->";
    const html =
      `<meta property="og:title" content="Early">` +
      filler +
      `<meta property="og:description" content="LateAndDropped">`;
    const r = parseOgMetadata(html, "https://s.com/");
    expect(r.title).toBe("Early");
    expect(r.description).toBe(""); // beyond the 256KB slice
  });
});
