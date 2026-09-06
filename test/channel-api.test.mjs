// Path-construction tests for the two channel endpoints added in the
// 2026-09-06 Substack chat migration.
//
// These assert the PATH the proxy is asked to fetch, not the response shape —
// the response shape is pinned by test/fixtures/channel-posts-page1.json. The
// `before` branch of fetchChannelPosts has no production caller yet (the app
// reads only page 1), so without this it would be undocumented dead code whose
// query-param spelling nobody would notice was wrong until pagination landed.

import { describe, it, expect, beforeEach } from "vitest";
import { fetchChatChannel, fetchChannelPosts } from "../lib/api.js";

const CH = "aeb6bcb1-60c2-4531-be48-1a08b43d6416";

// Returns the path lib/api.js handed to the tab proxy for the last call.
const capturedPath = () => chrome.scripting.executeScript.mock.calls[0][0].args[0];

beforeEach(() => {
  chrome.tabs.get.mockResolvedValue(null);
  chrome.tabs.query.mockReset();
  chrome.scripting.executeScript.mockReset();
  chrome.tabs.query.mockResolvedValue([
    { id: 1, url: `https://substack.com/chat/group/${CH}` },
  ]);
  chrome.scripting.executeScript.mockResolvedValue([
    { result: { ok: true, status: 200, text: JSON.stringify({ threads: [] }), ms: 1 } },
  ]);
});

describe("fetchChatChannel", () => {
  it("hits the channel record endpoint", async () => {
    await fetchChatChannel(CH);
    expect(capturedPath()).toBe(`/api/v1/chat/channels/${CH}`);
  });
});

describe("fetchChannelPosts", () => {
  it("hits the bare posts endpoint with no query string when unpaginated", async () => {
    await fetchChannelPosts(CH);
    expect(capturedPath()).toBe(`/api/v1/chat/channels/${CH}/posts`);
  });

  it("omits the query string for a falsy `before` rather than sending before=", async () => {
    // Substack 400s on malformed query params (verified live against the
    // mention endpoint), so an empty `before=` would be a hard failure, not a
    // no-op — the falsy check is load-bearing.
    await fetchChannelPosts(CH, { before: "" });
    expect(capturedPath()).toBe(`/api/v1/chat/channels/${CH}/posts`);
  });

  it("appends an encoded `before` when paginating backwards", async () => {
    // `before` is the ONLY param that pages this endpoint — `order` and
    // `after` were both accepted and ignored in the live capture, so a future
    // pagination caller must not reach for them.
    await fetchChannelPosts(CH, { before: "2026-09-04T10:46:50.115Z" });
    expect(capturedPath()).toBe(
      `/api/v1/chat/channels/${CH}/posts?before=2026-09-04T10%3A46%3A50.115Z`
    );
  });
});
