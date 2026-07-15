// Regression tests for lib/api.js's proxy-tab retry logic.
//
// Reproduces the live bug: "Failed to load chat: executeScript failed (tab
// closed?): Cannot access contents of the page. Extension manifest must
// request permission to access the respective host." — thrown when the
// substack.com tab findProxyTab() picked navigated away (or was replaced)
// between being found and being injected into.

import { describe, it, expect, beforeEach } from "vitest";

import { fetchInbox, putChatMediaBinary } from "../lib/api.js";

beforeEach(() => {
  chrome.tabs.get.mockResolvedValue(null); // no cached tab survives between tests
  chrome.tabs.query.mockReset();
  chrome.scripting.executeScript.mockReset();
});

describe("proxy-tab retry (proxyFetch, via fetchInbox)", () => {
  it("falls through to a second open substack.com tab when the first fails injection", async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 1, url: "https://substack.com/chat/123/post/abc" },
      { id: 2, url: "https://otherpub.substack.com/chat/456/post/def" },
    ]);
    chrome.scripting.executeScript
      .mockRejectedValueOnce(
        new Error(
          "Cannot access contents of the page. Extension manifest must request permission to access the respective host."
        )
      )
      .mockResolvedValueOnce([
        {
          result: {
            ok: true,
            status: 200,
            text: JSON.stringify({ ok: true }),
            ms: 1,
          },
        },
      ]);

    const res = await fetchInbox();
    expect(res).toEqual({ ok: true });
    // First call targeted tab 1, retry targeted tab 2 (not tab 1 again).
    expect(chrome.scripting.executeScript.mock.calls[0][0].target.tabId).toBe(
      1
    );
    expect(chrome.scripting.executeScript.mock.calls[1][0].target.tabId).toBe(
      2
    );
  });

  it("retries the SAME tab on a transient failure when it's the only one open", async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 1, url: "https://substack.com/chat/123/post/abc" },
    ]);
    chrome.scripting.executeScript
      .mockRejectedValueOnce(new Error("frame was removed"))
      .mockResolvedValueOnce([
        {
          result: {
            ok: true,
            status: 200,
            text: JSON.stringify({ ok: true }),
            ms: 1,
          },
        },
      ]);

    const res = await fetchInbox();
    expect(res).toEqual({ ok: true });
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(chrome.scripting.executeScript.mock.calls[1][0].target.tabId).toBe(
      1
    );
  });

  it("raises an actionable error (not the raw Chrome message) when no tab can be reached", async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 1, url: "https://substack.com/chat/123/post/abc" },
    ]);
    chrome.scripting.executeScript.mockRejectedValue(
      new Error(
        "Cannot access contents of the page. Extension manifest must request permission to access the respective host."
      )
    );

    await expect(fetchInbox()).rejects.toThrow(
      /open or refresh https:\/\/substack\.com\/chat/i
    );
  });

  it("reports no open Substack tab distinctly from an unreachable one", async () => {
    chrome.tabs.query.mockResolvedValue([]);

    await expect(fetchInbox()).rejects.toThrow(/no substack\.com tab open/i);
  });
});

describe("proxy-tab retry (proxyFetchBinary, via putChatMediaBinary)", () => {
  it("falls through to a second open substack.com tab when the first fails injection", async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 1, url: "https://substack.com/chat/123/post/abc" },
      { id: 2, url: "https://otherpub.substack.com/chat/456/post/def" },
    ]);
    chrome.scripting.executeScript
      .mockRejectedValueOnce(
        new Error(
          "Cannot access contents of the page. Extension manifest must request permission to access the respective host."
        )
      )
      .mockResolvedValueOnce([
        {
          result: {
            ok: true,
            status: 200,
            text: JSON.stringify({ url: "https://substack.com/x.png" }),
          },
        },
      ]);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const res = await putChatMediaBinary(
      "https://substack.com/api/v1/thread_media_upload/u-1",
      blob
    );
    expect(res.url).toBe("https://substack.com/x.png");
    expect(chrome.scripting.executeScript.mock.calls[0][0].target.tabId).toBe(
      1
    );
    expect(chrome.scripting.executeScript.mock.calls[1][0].target.tabId).toBe(
      2
    );
  });
});
