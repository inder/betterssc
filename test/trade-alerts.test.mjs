import { describe, it, expect } from "vitest";
import { planTradeAlerts, formatTradeAlert, tradeKey, ALERT_BODY_MAX, UNCONFIRMED_MARKER } from "../lib/trade-alerts.js";

const NOW = new Date("2026-09-18T16:00:00.000Z"); // 12:00 ET
const DAY = "2026-09-18";
const c = (id, body, at = "2026-09-18T14:00:00.000Z", author = { id: 1, name: "Za" }, extra = {}) => ({ id, body, created_at: at, author, post_id: "p1", ...extra });

describe("planTradeAlerts — what alerts", () => {
  it("one message per comment, listing every distinct trade; keys are composite", () => {
    const plan = planTradeAlerts({ comments: [c("a", "sold NVDA, bought AMD")], now: NOW, sentKeys: new Set(), dayKey: DAY });
    expect(plan.rollover).toBe(false);
    expect(plan.messages.length).toBe(1);
    expect(plan.messages[0].trades.map((t) => [t.action, t.tickers[0]])).toEqual([["SELL", "NVDA"], ["BUY", "AMD"]]);
    expect(plan.messages[0].keys).toEqual(["a|SELL||NVDA", "a|BUY||AMD"]);
    expect(plan.messages[0].authorName).toBe("Za");
    expect(plan.messages[0].raw).toBe("sold NVDA, bought AMD");
  });
  it("collapses two verbs on the same ticker into one trade", () => {
    const plan = planTradeAlerts({ comments: [c("a", "bought CBRS and added CBRS")], now: NOW, sentKeys: new Set(), dayKey: DAY });
    expect(plan.messages[0].trades.length).toBe(1);
    expect(plan.messages[0].keys).toEqual(["a|BUY||CBRS"]);
  });
  it("skips keys already sent, across calls (the persisted dedupe)", () => {
    const sent = new Set();
    const first = planTradeAlerts({ comments: [c("a", "Bought CBRS")], now: NOW, sentKeys: sent, dayKey: DAY });
    for (const k of first.messages[0].keys) sent.add(k);
    const again = planTradeAlerts({ comments: [c("a", "Bought CBRS")], now: NOW, sentKeys: sent, dayKey: DAY });
    expect(again.messages).toEqual([]);
  });
  it("plans against an EMPTY set on ET-day rollover and reports it", () => {
    const sent = new Set(["a|BUY||CBRS"]);
    const plan = planTradeAlerts({ comments: [c("a", "Bought CBRS")], now: NOW, sentKeys: sent, dayKey: "2026-09-17" });
    expect(plan.rollover).toBe(true);
    expect(plan.dayKey).toBe(DAY);
    expect(plan.messages.length).toBe(1);
  });
  it("drops messages not dated today in ET, pending/failed rows, and tickerless text", () => {
    const plan = planTradeAlerts({
      comments: [
        c("y", "Bought NVDA", "2026-09-18T03:59:00.000Z"), // 23:59 ET yesterday
        c("p", "Bought CBRS", undefined, undefined, { _pending: true }),
        c("f", "Bought CBRS", undefined, undefined, { _failed: true }),
        c("t", "bought more"),
        c("ok", "Bought AMD"),
      ],
      now: NOW, sentKeys: new Set(), dayKey: DAY,
    });
    expect(plan.messages.map((m) => m.commentId)).toEqual(["ok"]);
  });
  it("pinned-only keeps pinned authors (and never skips the user's own message when pinned)", () => {
    const plan = planTradeAlerts({
      comments: [c("a", "Bought CBRS", undefined, { id: 1, name: "Me" }), c("b", "Bought NVDA", undefined, { id: 2, name: "Bob" })],
      now: NOW, sentKeys: new Set(), dayKey: DAY, pinnedOnly: true, pinnedIds: new Set([1]),
    });
    expect(plan.messages.map((m) => m.commentId)).toEqual(["a"]);
  });
  it("never parses a quoted parent (invariant 2): body 'nice' + quote 'Bought: CBRS' → no alert", () => {
    const plan = planTradeAlerts({ comments: [c("r", "nice", undefined, undefined, { quote: { id: "q", body: "Bought: CBRS at 12.40" } })], now: NOW, sentKeys: new Set(), dayKey: DAY });
    expect(plan.messages).toEqual([]);
  });
  it("keeps low-confidence trades (marked, not dropped)", () => {
    const plan = planTradeAlerts({ comments: [c("a", "bought orcu")], now: NOW, sentKeys: new Set(), dayKey: DAY });
    expect(plan.messages[0].trades[0].confidence).toBe("low");
  });
  it("invalid clock → nothing, and NOT a rollover (the caller must not wipe the day's keys)", () => {
    const plan = planTradeAlerts({ comments: [c("a", "Bought CBRS")], now: new Date("x"), sentKeys: new Set(["k"]), dayKey: DAY });
    expect(plan.messages).toEqual([]);
    expect(plan.rollover).toBe(false);
    expect(plan.dayKey).toBeNull();
  });
  it("clamps a pathological many-trade message under Telegram's limit and keeps the link", () => {
    const trades = Array.from({ length: 400 }, (_, i) => ({ action: "BUY", qualifier: null, tickers: [`T${String(i).padStart(3, "0")}`], confidence: "high" }));
    const out = formatTradeAlert({ trades, authorName: "Za", raw: "x" }, { link: "https://substack.com/chat/group/c/post/p?target_reply_id=a&showTarget=true" });
    expect(out.text.length).toBeLessThanOrEqual(4096);
    expect(out.text.endsWith('">Link</a>')).toBe(true);
    expect(out.text).not.toMatch(/<b[^>]*…/);
  });
  it("tradeKey sorts tickers so order in the message does not matter", () => {
    expect(tradeKey("a", { action: "BUY", qualifier: null, tickers: ["INTC", "CBRS"] })).toBe("a|BUY||CBRS+INTC");
    expect(tradeKey("a", { action: "SELL", qualifier: "partial", tickers: ["X"] })).toBe("a|SELL|partial|X");
  });
});

describe("formatTradeAlert", () => {
  const link = "https://substack.com/chat/group/ch/post/p1?target_reply_id=a&showTarget=true";
  it("single trade: the oracle line, bold symbol, link on its own line, preview off", () => {
    const m = { trades: [{ action: "BUY", qualifier: null, tickers: ["CBRS"], confidence: "high" }], authorName: "Za", raw: "Bought: CBRS at 12.40" };
    const out = formatTradeAlert(m, { link });
    // The link is a short anchor; its href is entity-escaped attribute text.
    expect(out.text).toBe(`🟢 <b>BUY CBRS</b> — Za: Bought: CBRS at 12.40\n<a href="${link.replace(/&/g, "&amp;")}">Link</a>`);
    expect(out.parse_mode).toBe("HTML");
    expect(out.disable_web_page_preview).toBe(true);
  });
  it("closed / partial / plain sell badges", () => {
    const mk = (q) => formatTradeAlert({ trades: [{ action: "SELL", qualifier: q, tickers: ["CBRS"], confidence: "high" }], authorName: "Za", raw: "x" }).text;
    expect(mk("closed").startsWith("🔴 <b>SELL·closed CBRS</b>")).toBe(true);
    expect(mk("partial").startsWith("🟠 <b>SELL·partial CBRS</b>")).toBe(true);
    expect(mk(null).startsWith("🔴 <b>SELL CBRS</b>")).toBe(true);
  });
  it("several trades: one line each, then the author + body line", () => {
    const m = { trades: [{ action: "SELL", qualifier: null, tickers: ["NVDA"], confidence: "high" }, { action: "BUY", qualifier: null, tickers: ["AMD"], confidence: "high" }], authorName: "Za", raw: "sold NVDA, bought AMD" };
    expect(formatTradeAlert(m).text).toBe("🔴 <b>SELL NVDA</b>\n🟢 <b>BUY AMD</b>\n— Za: sold NVDA, bought AMD");
  });
  it("marks a low-confidence ticker instead of hiding it", () => {
    const m = { trades: [{ action: "BUY", qualifier: null, tickers: ["ORCU"], confidence: "low" }], authorName: "Za", raw: "bought orcu" };
    expect(formatTradeAlert(m).text).toContain(`<b>BUY ORCU</b> ${UNCONFIRMED_MARKER}`);
  });
  it("escapes quotes in the link href", () => {
    const m = { trades: [{ action: "BUY", qualifier: null, tickers: ["X"], confidence: "high" }], authorName: "Za", raw: "Bought X" };
    const out = formatTradeAlert(m, { link: 'https://substack.com/chat/group/c/post/p?target_reply_id=a"b&showTarget=true' }).text;
    expect(out).toContain('<a href="https://substack.com/chat/group/c/post/p?target_reply_id=a&quot;b&amp;showTarget=true">Link</a>');
  });
  it("escapes HTML in body, author and tickers; caps the body entity-safely; collapses whitespace", () => {
    const m = { trades: [{ action: "BUY", qualifier: null, tickers: ["A&B"], confidence: "high" }], authorName: "<Za>", raw: "Bought A&B <now>\n\n" + "x".repeat(500) };
    const out = formatTradeAlert(m).text;
    expect(out).toContain("<b>BUY A&amp;B</b>");
    expect(out).toContain("&lt;Za&gt;:");
    expect(out).toContain("Bought A&amp;B &lt;now&gt; ");
    expect(out).not.toMatch(/&amp$|&lt$|&gt$/);
    expect(out.length).toBeLessThan(ALERT_BODY_MAX + 120);
    expect(out.endsWith("…")).toBe(true);
  });
  it("multi-ticker trade lists both symbols in one bold run", () => {
    const m = { trades: [{ action: "BUY", qualifier: null, tickers: ["INTC", "CBRS"], confidence: "high" }], authorName: "Za", raw: "Bought: INTC CBRS" };
    expect(formatTradeAlert(m).text.startsWith("🟢 <b>BUY INTC CBRS</b> — Za:")).toBe(true);
  });
  it("no author → 'Someone'; no link → no trailing line", () => {
    const m = { trades: [{ action: "BUY", qualifier: null, tickers: ["X"], confidence: "high" }], authorName: null, raw: "Bought X" };
    expect(formatTradeAlert(m).text).toBe("🟢 <b>BUY X</b> — Someone: Bought X");
  });
});
