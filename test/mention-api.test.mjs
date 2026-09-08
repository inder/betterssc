import { describe, it, expect, beforeEach } from "vitest";
import { fetchMentionSuggestions } from "../lib/api.js";

const capturedPath = () => chrome.scripting.executeScript.mock.calls[0][0].args[0];

beforeEach(() => {
  chrome.tabs.query.mockReset();
  chrome.scripting.executeScript.mockReset();
  chrome.tabs.query.mockResolvedValue([
    { id: 1, url: "https://substack.com/chat/123/post/abc" },
  ]);
  chrome.scripting.executeScript.mockResolvedValue([
    {
      result: {
        ok: true,
        status: 200,
        text: JSON.stringify({ results: [] }),
        ms: 1,
      },
    },
  ]);
});

describe("fetchMentionSuggestions", () => {
  it("passes a multi-word display-name query without losing its space", async () => {
    await fetchMentionSuggestions("publication-1", "post-1", "Jordan Conner");
    expect(capturedPath()).toBe(
      "/api/v1/community/mention?publication_id=publication-1&community_post_id=post-1&query=Jordan+Conner"
    );
  });
});
