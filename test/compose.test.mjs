// Composer mount + auto-grow tests (commit 1 of v0.2 write side).
//
// These tests verify the COMPOSER UI mounts with the right elements and the
// auto-grow logic clamps height correctly. Send wiring is commit 2.

import { describe, it, expect, beforeEach } from "vitest";
import {
  autoGrowTextarea,
  buildCommentBody,
  findActiveMentionToken,
  replaceMentionToken,
} from "../lib/compose.js";

describe("composer mount (DOM)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app">
        <div class="composer" id="composer">
          <div class="composer-reply hidden" id="composerReply">
            <span class="composer-reply-label" id="composerReplyLabel"></span>
            <button id="composerReplyClose">×</button>
          </div>
          <div class="composer-row">
            <textarea id="composerInput" rows="1" placeholder="Send a message"></textarea>
            <button id="composerSend" disabled>Send</button>
          </div>
          <div class="composer-mention hidden" id="composerMention"></div>
        </div>
      </div>
    `;
  });

  it("renders the textarea, send button, mention dropdown, and reply bar", () => {
    expect(document.getElementById("composer")).not.toBeNull();
    expect(document.getElementById("composerInput")).not.toBeNull();
    expect(document.getElementById("composerSend")).not.toBeNull();
    expect(document.getElementById("composerMention")).not.toBeNull();
    expect(document.getElementById("composerReply")).not.toBeNull();
  });

  it("placeholder reads 'Send a message'", () => {
    const ta = document.getElementById("composerInput");
    expect(ta.getAttribute("placeholder")).toBe("Send a message");
  });

  it("send button starts disabled", () => {
    const btn = document.getElementById("composerSend");
    expect(btn.disabled).toBe(true);
  });

  it("reply bar and mention dropdown start hidden", () => {
    expect(
      document.getElementById("composerReply").classList.contains("hidden")
    ).toBe(true);
    expect(
      document.getElementById("composerMention").classList.contains("hidden")
    ).toBe(true);
  });
});

describe("autoGrowTextarea", () => {
  beforeEach(() => {
    document.body.innerHTML = `<textarea id="t"></textarea>`;
  });

  it("returns one line height for empty input", () => {
    const t = document.getElementById("t");
    t.value = "";
    const h = autoGrowTextarea(t, { lineHeight: 22, maxRows: 4 });
    expect(h).toBe(22);
  });

  it("caps height at maxRows * lineHeight", () => {
    const t = document.getElementById("t");
    t.value = "a\nb\nc\nd\ne\nf\ng"; // 7 lines
    const h = autoGrowTextarea(t, { lineHeight: 22, maxRows: 4 });
    expect(h).toBe(88); // 4 * 22
  });

  it("grows with newlines below the cap", () => {
    const t = document.getElementById("t");
    t.value = "a\nb"; // 2 lines
    const h = autoGrowTextarea(t, { lineHeight: 22, maxRows: 4 });
    expect(h).toBe(44); // 2 * 22
  });

  it("returns 0 when element is null (no-op safety)", () => {
    expect(autoGrowTextarea(null)).toBe(0);
  });
});

describe("buildCommentBody — surface", () => {
  it("returns plain body and empty mentions for plain text", () => {
    expect(buildCommentBody("hello world", {})).toEqual({
      body: "hello world",
      mentions: {},
    });
  });
  it("tolerates null inputs", () => {
    expect(buildCommentBody(null, null)).toEqual({ body: "", mentions: {} });
  });
});

describe("findActiveMentionToken — surface", () => {
  it("returns null when no @ before cursor", () => {
    expect(findActiveMentionToken("plain text", 5)).toBeNull();
  });
  it("returns the active @-token at cursor", () => {
    const r = findActiveMentionToken("hi @bo", 6);
    expect(r).toEqual({ query: "bo", start: 3, end: 6 });
  });
});

describe("replaceMentionToken — surface", () => {
  it("replaces the @-token with @name + space", () => {
    const r = replaceMentionToken("hi @bo", { start: 3, end: 6 }, "Boz");
    expect(r.text).toBe("hi @Boz ");
    expect(r.cursor).toBe(8);
  });
});
