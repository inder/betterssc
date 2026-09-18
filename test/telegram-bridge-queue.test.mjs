// The bridge's send queue with a fake Telegram API and fake timers: the
// slice-3 seam (tagged items, enqueueText) must never leak a text item into
// the mirror's comment path, must not require streaming, must keep the
// 1.2s spacing, and must swallow a failed send.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTelegramBridge } from "../lib/telegram-bridge.js";

function fakeApi() {
  const calls = [];
  let failNext = false;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body, t: Date.now() });
    if (failNext) {
      failNext = false;
      return { status: 429, json: async () => ({ ok: false, description: "Too Many Requests", error_code: 429 }) };
    }
    return { status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  };
  return { calls, fetchImpl, failNextSend: () => { failNext = true; } };
}

describe("telegram bridge queue — text items (trade alerts)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("enqueueText sends with streaming OFF, as sendMessage, preview disabled, no comment formatting", async () => {
    const api = fakeApi();
    const b = createTelegramBridge({ fetchImpl: api.fetchImpl, log: () => {} });
    b.setConfig({ token: "T", chatId: 42, streaming: false });
    expect(b.enqueueText({ text: "🟢 <b>BUY CBRS</b> — Za: Bought: CBRS", parse_mode: "HTML" })).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls.length).toBe(1);
    expect(api.calls[0].method).toBe("sendMessage");
    expect(api.calls[0].body).toEqual({ chat_id: 42, text: "🟢 <b>BUY CBRS</b> — Za: Bought: CBRS", parse_mode: "HTML", disable_web_page_preview: true });
    expect(api.calls[0].body.text).not.toContain("Unknown");
  });

  it("refuses without a connected bot, and refuses empty text", () => {
    const api = fakeApi();
    const b = createTelegramBridge({ fetchImpl: api.fetchImpl, log: () => {} });
    expect(b.enqueueText({ text: "x" })).toBe(false); // no token
    b.setConfig({ token: "T", chatId: null });
    expect(b.enqueueText({ text: "x" })).toBe(false); // no chat id
    b.setConfig({ token: "T", chatId: 1 });
    expect(b.enqueueText({ text: "" })).toBe(false);
    expect(b.enqueueText(null)).toBe(false);
    expect(api.calls.length).toBe(0);
  });

  it("keeps the 1.2s spacing between items and preserves order across mirror comments and alerts", async () => {
    const api = fakeApi();
    const b = createTelegramBridge({ fetchImpl: api.fetchImpl, log: () => {}, getCurrentCommentIds: () => [] });
    b.setConfig({ token: "T", chatId: 42, streaming: true });
    // setConfig({streaming:true}) may emit the session banner first — filter it.
    await vi.advanceTimersByTimeAsync(5);
    api.calls.length = 0;
    b.forwardNewMessages([{ id: "c1", body: "hello", author: { id: 9, name: "Bob" }, created_at: "2026-09-18T14:00:00.000Z" }]);
    b.enqueueText({ text: "ALERT 1" });
    b.enqueueText({ text: "ALERT 2" });
    await vi.advanceTimersByTimeAsync(6000);
    const texts = api.calls.map((c) => c.body.text);
    const i0 = texts.findIndex((t) => t.includes("Bob"));
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(texts.slice(i0)).toEqual([texts[i0], "ALERT 1", "ALERT 2"]);
    for (let i = i0 + 1; i < api.calls.length; i++) expect(api.calls[i].t - api.calls[i - 1].t).toBeGreaterThanOrEqual(1200);
  });

  it("a failed alert send is swallowed and the queue keeps draining", async () => {
    const api = fakeApi();
    const b = createTelegramBridge({ fetchImpl: api.fetchImpl, log: () => {} });
    b.setConfig({ token: "T", chatId: 42 });
    api.failNextSend();
    b.enqueueText({ text: "first (will 429)" });
    b.enqueueText({ text: "second" });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1201);
    expect(api.calls.map((c) => c.body.text)).toEqual(["first (will 429)", "second"]);
    expect(b._state().queued).toBe(0);
  });

  it("a text item never enters the inbound reply map (rememberSent) — a mirrored comment does", async () => {
    const api = fakeApi();
    const b = createTelegramBridge({ fetchImpl: api.fetchImpl, log: () => {}, getCurrentCommentIds: () => [] });
    b.setConfig({ token: "T", chatId: 42, streaming: true });
    await vi.advanceTimersByTimeAsync(5);
    b.enqueueText({ text: "alert" });
    await vi.advanceTimersByTimeAsync(1);
    expect(b._state().msgMapSize).toBe(0); // rememberSent NOT called for the alert
    expect(b._state().sentCount).toBe(0); // and sentIds untouched
    b.forwardNewMessages([{ id: "c1", body: "hello", author: { id: 9, name: "Bob" }, created_at: "2026-09-18T14:00:00.000Z" }]);
    await vi.advanceTimersByTimeAsync(1300);
    expect(b._state().msgMapSize).toBe(1); // the control: a mirrored comment IS remembered
  });
});
