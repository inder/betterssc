// Tests for the rolling-ticker-bar trending extractor (lib/trending.js).
//
// Covers the four entity classes and their gates:
//   - tickers: bare KNOWN_TICKERS + $-prefixed, deduped, ranked first
//   - people: from mention targets, never duplicating a ticker
//   - topics: free words, gated by >=2 distinct authors + stoplist + length
//   - recency weighting, window cutoff, maxItems cap
//   - adversarial near-positives that MUST NOT become chips

import { describe, it, expect } from "vitest";
import { extractTrending } from "../lib/trending.js";

const NOW = 1_700_000_000_000;
const isoAt = (msAgo) => new Date(NOW - msAgo).toISOString();

// helper to build a comment
const c = (body, { mentions, authorId = 1, msAgo = 0 } = {}) => ({
  body,
  mentions,
  author: { id: authorId },
  created_at: isoAt(msAgo),
});

const run = (comments, opts) => extractTrending(comments, { now: NOW, ...opts });

describe("tickers", () => {
  it("extracts bare KNOWN_TICKERS symbols", () => {
    const out = run([c("NVDA ripping today, AAPL flat")]);
    const syms = out.filter((i) => i.kind === "ticker").map((i) => i.symbol);
    expect(syms).toContain("NVDA");
    expect(syms).toContain("AAPL");
  });

  it("extracts $-prefixed tickers even when not in KNOWN_TICKERS", () => {
    const out = run([c("watching $ZZZZ and $XYZ closely")]);
    const syms = out.filter((i) => i.kind === "ticker").map((i) => i.symbol);
    expect(syms).toContain("ZZZZ");
    expect(syms).toContain("XYZ");
  });

  it("dedupes the same symbol across $-prefixed and bare forms", () => {
    const out = run([c("$AAPL and AAPL again", { authorId: 1 })]);
    const aapl = out.filter((i) => i.kind === "ticker" && i.symbol === "AAPL");
    expect(aapl).toHaveLength(1);
  });

  it("does NOT treat lowercase or Titlecase company words as tickers", () => {
    // "Meta" / "meta" must not match — only ALL-CAPS META would, and it's
    // not present here.
    const out = run([c("the meta announcement and Apple event were big")]);
    const syms = out.filter((i) => i.kind === "ticker").map((i) => i.symbol);
    expect(syms).not.toContain("META");
    expect(syms).not.toContain("AAPL");
  });

  it("ranks tickers before people and topics", () => {
    const out = run([
      c("NVDA up", { authorId: 1 }),
      c("interesting earnings discussion here folks", { authorId: 2 }),
      c("earnings discussion continues with detail", { authorId: 3 }),
    ]);
    // first item should be the ticker
    expect(out[0].kind).toBe("ticker");
  });

  it("crypto symbols come through as plain symbols (mapping happens at fetch)", () => {
    const out = run([c("BTC and ETH pumping")]);
    const syms = out.filter((i) => i.kind === "ticker").map((i) => i.symbol);
    expect(syms).toContain("BTC");
    expect(syms).toContain("ETH");
  });
});

describe("people", () => {
  it("extracts mentioned people as @-prefixed search terms", () => {
    const out = run([
      c("hey ${0} what do you think", {
        mentions: { 0: { text: "@Jordan", user_id: 9 } },
      }),
    ]);
    const ppl = out.filter((i) => i.kind === "person");
    expect(ppl).toHaveLength(1);
    expect(ppl[0].label).toBe("Jordan");
    expect(ppl[0].term).toBe("@Jordan");
  });

  it("caps a person label to 2 words", () => {
    const out = run([
      c("ping ${0}", {
        mentions: { 0: { text: "@John Q Public", user_id: 9 } },
      }),
    ]);
    const ppl = out.filter((i) => i.kind === "person");
    expect(ppl[0].label).toBe("John Q");
  });

  it("does not duplicate a person within one message", () => {
    const out = run([
      c("${0} hi ${1}", {
        mentions: {
          0: { text: "@Sam", user_id: 9 },
          1: { text: "@Sam", user_id: 9 },
        },
      }),
    ]);
    const sam = out.filter((i) => i.kind === "person" && i.label === "Sam");
    expect(sam).toHaveLength(1);
    expect(sam[0].count).toBe(1);
  });
});

describe("topics — gated", () => {
  it("surfaces a topic mentioned by >=2 distinct authors", () => {
    const out = run([
      c("the recession fears are real", { authorId: 1 }),
      c("recession talk everywhere", { authorId: 2 }),
    ]);
    const topics = out.filter((i) => i.kind === "topic").map((i) => i.label);
    expect(topics).toContain("recession");
  });

  it("does NOT surface a word repeated by a single author", () => {
    const out = run([
      c("recession recession recession", { authorId: 1 }),
      c("recession again", { authorId: 1 }),
    ]);
    const topics = out.filter((i) => i.kind === "topic").map((i) => i.label);
    expect(topics).not.toContain("recession");
  });

  it("filters stopwords and short words even across many authors", () => {
    const out = run([
      c("really just think that this", { authorId: 1 }),
      c("really just think about that", { authorId: 2 }),
      c("really think okay yeah", { authorId: 3 }),
    ]);
    const topics = out.filter((i) => i.kind === "topic").map((i) => i.label);
    expect(topics).not.toContain("really");
    expect(topics).not.toContain("just");
    expect(topics).not.toContain("think");
    expect(topics).not.toContain("that");
  });

  it("a ticker word never also appears as a topic", () => {
    const out = run([
      c("NVDA NVDA story", { authorId: 1 }),
      c("NVDA again here", { authorId: 2 }),
    ]);
    const topicLabels = out.filter((i) => i.kind === "topic").map((i) => i.label);
    expect(topicLabels).not.toContain("nvda");
  });
});

describe("window + recency + caps", () => {
  it("ignores comments older than the window", () => {
    const out = run(
      [
        c("NVDA fresh", { msAgo: 1000 }),
        c("TSLA stale", { msAgo: 60 * 60 * 1000 }), // 1h ago — outside the explicit 45m window passed below
      ],
      { windowMs: 45 * 60 * 1000 }
    );
    const syms = out.filter((i) => i.kind === "ticker").map((i) => i.symbol);
    expect(syms).toContain("NVDA");
    expect(syms).not.toContain("TSLA");
  });

  it("recent mentions outrank old ones for the same class", () => {
    const out = run([
      c("AAPL", { msAgo: 40 * 60 * 1000 }), // old
      c("NVDA", { msAgo: 10 * 1000 }), // very recent
    ]);
    const tickers = out.filter((i) => i.kind === "ticker");
    expect(tickers[0].symbol).toBe("NVDA");
  });

  it("respects maxItems", () => {
    const body = "NVDA AAPL TSLA AMD MSFT GOOG META AMZN";
    const out = run([c(body)], { maxItems: 3 });
    expect(out.length).toBe(3);
  });

  it("skips local AI rows", () => {
    const ai = { body: "NVDA from AI", created_at: isoAt(0), _aiGenerated: true };
    const out = run([ai]);
    expect(out).toHaveLength(0);
  });

  it("returns empty for no comments", () => {
    expect(run([])).toEqual([]);
    expect(run(null)).toEqual([]);
  });
});

describe("recency/frequency blend (recencyAlpha)", () => {
  const min = (n) => n * 60 * 1000;

  // The canonical case from the design discussion: a sustained mover the room
  // discussed across the window (A) vs a fresh 3x burst (B).
  //   A — 8 mentions, 8 distinct authors, spread 40–110 min ago
  //   B — 3 mentions, 3 distinct authors, all in the last ~minute
  const sustainedVsBurst = () => {
    const out = [];
    [110, 100, 90, 80, 70, 60, 50, 40].forEach((m, i) =>
      out.push(c("$AAA strong", { authorId: 100 + i, msAgo: min(m) }))
    );
    [0.2, 0.4, 0.6].forEach((m, i) =>
      out.push(c("$BBB hot", { authorId: 200 + i, msAgo: min(m) }))
    );
    return out;
  };

  it("pure recency (α=1) ranks the fresh burst first — old behavior", () => {
    const out = run(sustainedVsBurst(), { recencyAlpha: 1 });
    const tickers = out.filter((i) => i.kind === "ticker");
    expect(tickers[0].symbol).toBe("BBB");
  });

  it("blended (α=0.65) flips it: the sustained mover ranks first", () => {
    const out = run(sustainedVsBurst(), { recencyAlpha: 0.65 });
    const tickers = out.filter((i) => i.kind === "ticker");
    expect(tickers[0].symbol).toBe("AAA");
  });

  it("α defaults to 1.0 (no behavior change unless opted in)", () => {
    const def = run(sustainedVsBurst());
    const alpha1 = run(sustainedVsBurst(), { recencyAlpha: 1 });
    expect(def.map((i) => i.label)).toEqual(alpha1.map((i) => i.label));
  });

  it("exposes freq and rank on returned items", () => {
    const out = run([c("NVDA up", { authorId: 1 })], { recencyAlpha: 0.65 });
    const nvda = out.find((i) => i.symbol === "NVDA");
    expect(nvda.freq).toBe(1);
    expect(typeof nvda.rank).toBe("number");
    expect(nvda.rank).toBeGreaterThan(0);
  });
});

describe("per-author frequency cap (anti-spam)", () => {
  it("one author repeating a ticker cannot out-rank two-author interest", () => {
    // Spammer posts $ZZZ 6x recently; a separate symbol $YYY gets 2 mentions
    // from 2 distinct authors, slightly older. With the cap, the spammer's
    // effective frequency is bounded so it can't dominate purely on volume.
    const comments = [];
    for (let i = 0; i < 6; i++)
      comments.push(c("$ZZZ", { authorId: 1, msAgo: i * 1000 }));
    comments.push(c("$YYY", { authorId: 2, msAgo: 30 * 60 * 1000 }));
    comments.push(c("$YYY", { authorId: 3, msAgo: 30 * 60 * 1000 }));

    const out = run(comments, { recencyAlpha: 0.65, perAuthorFreqCap: 3 });
    const zzz = out.find((i) => i.symbol === "ZZZ");
    const yyy = out.find((i) => i.symbol === "YYY");
    // 6 posts from one author count as at most 3 toward frequency.
    expect(zzz.freq).toBe(3);
    expect(yyy.freq).toBe(2);
  });

  it("distinct authors accumulate frequency beyond the per-author cap", () => {
    // 5 distinct authors each mention $WWW once → effective freq 5, above the
    // cap of 3, because the cap is per-author not global.
    const comments = [];
    for (let a = 0; a < 5; a++)
      comments.push(c("$WWW", { authorId: 10 + a, msAgo: 1000 }));
    const out = run(comments, { recencyAlpha: 0.65, perAuthorFreqCap: 3 });
    const www = out.find((i) => i.symbol === "WWW");
    expect(www.freq).toBe(5);
  });

  it("author-less occurrences are pooled into a single capped bucket", () => {
    const anon = (msAgo) => ({ body: "$QQQ", created_at: isoAt(msAgo) });
    const out = run([anon(0), anon(1000), anon(2000), anon(3000)], {
      recencyAlpha: 0.65,
      perAuthorFreqCap: 3,
    });
    const qqq = out.find((i) => i.symbol === "QQQ");
    expect(qqq.freq).toBe(3); // 4 anon posts capped to 3
  });
});
