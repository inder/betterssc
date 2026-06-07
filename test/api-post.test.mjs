// Regression tests for lib/api.js's POST payload shapes.
// Reproduces the v0.2-A live bug: Substack rejects `mentions: {}` with
// 400 "Invalid value" — the field must be omitted entirely when empty.

import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to spy on the fetch path. The simplest way without rewriting
// api.js is to intercept chrome.scripting.executeScript (which proxyFetch
// uses) and assert the body our caller asked to send.

import { postComment, postReaction } from "../lib/api.js";

function lastBodyArg(executeScriptMock) {
  // proxyFetch passes (path, init) as args[0] and args[1] inside the
  // executeScript func — they appear as the 1st and 2nd entries in
  // the `args` array of the call.
  const call =
    executeScriptMock.mock.calls[executeScriptMock.mock.calls.length - 1];
  const callArgs = call[0].args;
  const init = callArgs[1];
  return JSON.parse(init.body);
}

beforeEach(() => {
  // Pretend there's a substack.com tab so findProxyTab succeeds.
  chrome.tabs.query.mockResolvedValue([
    { id: 42, url: "https://substack.com/chat/123/post/abc" },
  ]);
  // executeScript returns a synthetic 200 response.
  chrome.scripting.executeScript.mockResolvedValue([
    {
      result: {
        ok: true,
        status: 200,
        text: JSON.stringify({ ok: true, id: "server-id-1" }),
        ms: 5,
      },
    },
  ]);
});

describe("postComment payload shape", () => {
  it("OMITS mentions when none are passed (regression: v0.2-A 400 bug)", async () => {
    await postComment("post-uuid-1", {
      id: "client-1",
      body: "hello world",
    });
    const body = lastBodyArg(chrome.scripting.executeScript);
    expect(body).toEqual({ id: "client-1", body: "hello world" });
    expect("mentions" in body).toBe(false);
  });

  it("OMITS mentions when an empty object is passed", async () => {
    await postComment("post-uuid-1", {
      id: "client-2",
      body: "hi",
      mentions: {},
    });
    const body = lastBodyArg(chrome.scripting.executeScript);
    expect("mentions" in body).toBe(false);
  });

  it("INCLUDES mentions when a non-empty object is passed", async () => {
    await postComment("post-uuid-1", {
      id: "client-3",
      body: "${0} hey",
      mentions: { 0: { user_id: 99, text: "@bob" } },
    });
    const body = lastBodyArg(chrome.scripting.executeScript);
    expect(body.mentions).toEqual({ 0: { user_id: 99, text: "@bob" } });
  });

  it("OMITS parent_id when undefined or null", async () => {
    await postComment("post-uuid-1", { id: "c4", body: "x" });
    expect("parent_id" in lastBodyArg(chrome.scripting.executeScript)).toBe(
      false
    );
    await postComment("post-uuid-1", { id: "c5", body: "x", parentId: null });
    expect("parent_id" in lastBodyArg(chrome.scripting.executeScript)).toBe(
      false
    );
  });

  it("INCLUDES parent_id when a real id is passed", async () => {
    await postComment("post-uuid-1", {
      id: "c6",
      body: "reply",
      parentId: "parent-uuid",
    });
    expect(lastBodyArg(chrome.scripting.executeScript).parent_id).toBe(
      "parent-uuid"
    );
  });

  it("OMITS quote when undefined or null", async () => {
    await postComment("post-uuid-1", { id: "c7", body: "x" });
    expect("quote" in lastBodyArg(chrome.scripting.executeScript)).toBe(false);
  });

  it("INCLUDES quote when an object is passed", async () => {
    await postComment("post-uuid-1", {
      id: "c8",
      body: "x",
      quote: { comment: { id: "qid" } },
    });
    expect(lastBodyArg(chrome.scripting.executeScript).quote).toEqual({
      comment: { id: "qid" },
    });
  });
});

describe("postReaction payload shape", () => {
  it("sends only {reaction}", async () => {
    await postReaction("comment-uuid", "thumbs_up");
    const body = lastBodyArg(chrome.scripting.executeScript);
    expect(body).toEqual({ reaction: "thumbs_up" });
  });
});
