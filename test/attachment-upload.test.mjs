// Tests for lib/api.js attachment upload helpers.
//
// Covers the 3-step upload flow decoded from the HAR captures:
//   1. registerChatMediaUpload → POST /api/v1/thread_media_uploads
//   2. putChatMediaBinary      → PUT  /api/v1/thread_media_upload/<id>
//
// (Step 3 is the existing postComment, already covered by api-post.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerChatMediaUpload,
  putChatMediaBinary,
} from "../lib/api.js";

function makeBlob(bytes, mime) {
  return new Blob([new Uint8Array(bytes)], { type: mime });
}

beforeEach(() => {
  chrome.tabs.query.mockResolvedValue([
    { id: 42, url: "https://substack.com/chat/123/post/abc" },
  ]);
});

// ---------------------------------------------------------------------------
// registerChatMediaUpload
// ---------------------------------------------------------------------------

describe("registerChatMediaUpload", () => {
  it("POSTs the exact 3-field shape Substack expects (HAR-confirmed)", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      {
        result: {
          ok: true,
          status: 200,
          text: JSON.stringify({
            url: "https://substack.com/api/v1/thread_media_upload/u-1",
            id: "u-1",
          }),
        },
      },
    ]);
    const res = await registerChatMediaUpload({
      publicationId: 8340803,
      commentId: "c-uuid-1",
      contentType: "image/png",
    });
    expect(res).toEqual({
      url: "https://substack.com/api/v1/thread_media_upload/u-1",
      id: "u-1",
    });
    const call = chrome.scripting.executeScript.mock.calls.at(-1)[0];
    const path = call.args[0];
    const init = call.args[1];
    expect(path).toBe("/api/v1/thread_media_uploads");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      publication_id: 8340803,
      comment_id: "c-uuid-1",
      content_type: "image/png",
    });
  });

  it("accepts all the image MIMEs we expect to flow through it", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: true, status: 200, text: '{"url":"x","id":"x"}' } },
    ]);
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      await registerChatMediaUpload({
        publicationId: 1,
        commentId: "c",
        contentType: mime,
      });
      const init = chrome.scripting.executeScript.mock.calls.at(-1)[0].args[1];
      expect(JSON.parse(init.body).content_type).toBe(mime);
    }
  });

  it("surfaces non-2xx errors via the proxyFetch error contract", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: false, status: 413, text: '{"error":"too large"}' } },
    ]);
    await expect(
      registerChatMediaUpload({
        publicationId: 1,
        commentId: "c",
        contentType: "image/png",
      })
    ).rejects.toThrow(/^413/);
  });
});

// ---------------------------------------------------------------------------
// putChatMediaBinary
// ---------------------------------------------------------------------------

describe("putChatMediaBinary — input validation", () => {
  it("throws on missing registered URL", async () => {
    await expect(
      putChatMediaBinary(null, makeBlob([1, 2, 3], "image/png"))
    ).rejects.toThrow(/missing registeredUrl/);
  });

  it("throws when the body isn't a Blob", async () => {
    await expect(
      putChatMediaBinary("https://substack.com/api/v1/thread_media_upload/u-1", {
        not: "a blob",
      })
    ).rejects.toThrow(/expected a Blob/);
  });

  it("rejects a URL that isn't on substack.com", async () => {
    await expect(
      putChatMediaBinary(
        "https://evil.example.com/upload/u-1",
        makeBlob([1, 2, 3], "image/png")
      )
    ).rejects.toThrow(/bad registeredUrl/);
  });
});

describe("putChatMediaBinary — wire shape", () => {
  it("PUTs base64-encoded bytes through executeScript with the right Content-Type", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      {
        result: {
          ok: true,
          status: 200,
          text: JSON.stringify({
            url: "https://substack-post-media.s3.amazonaws.com/.../u-1.png",
          }),
        },
      },
    ]);
    const blob = makeBlob([0x89, 0x50, 0x4e, 0x47], "image/png");
    const res = await putChatMediaBinary(
      "https://substack.com/api/v1/thread_media_upload/u-1",
      blob
    );
    expect(res.url).toMatch(/\.png$/);
    const call = chrome.scripting.executeScript.mock.calls.at(-1)[0];
    expect(call.args[0]).toBe("/api/v1/thread_media_upload/u-1");
    // args[1] is the base64 string; args[2] is the Content-Type.
    expect(typeof call.args[1]).toBe("string");
    expect(call.args[2]).toBe("image/png");
    // Decode the base64 and check it matches the original bytes.
    const decoded = Uint8Array.from(atob(call.args[1]), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("propagates the blob's MIME for image/gif", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: true, status: 200, text: "{}" } },
    ]);
    const blob = makeBlob([0x47, 0x49, 0x46, 0x38], "image/gif");
    await putChatMediaBinary(
      "https://substack.com/api/v1/thread_media_upload/u-2",
      blob
    );
    const call = chrome.scripting.executeScript.mock.calls.at(-1)[0];
    expect(call.args[2]).toBe("image/gif");
  });

  it("falls back to application/octet-stream if the blob has no MIME", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: true, status: 200, text: "{}" } },
    ]);
    const blob = makeBlob([1, 2, 3], "");
    await putChatMediaBinary(
      "https://substack.com/api/v1/thread_media_upload/u-3",
      blob
    );
    const call = chrome.scripting.executeScript.mock.calls.at(-1)[0];
    expect(call.args[2]).toBe("application/octet-stream");
  });

  it("returns an empty object when the PUT returns no body", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: true, status: 200, text: "" } },
    ]);
    const res = await putChatMediaBinary(
      "https://substack.com/api/v1/thread_media_upload/u-4",
      makeBlob([0], "image/png")
    );
    expect(res).toEqual({});
  });

  it("returns {_raw} when the PUT returns non-JSON text", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: true, status: 200, text: "OK" } },
    ]);
    const res = await putChatMediaBinary(
      "https://substack.com/api/v1/thread_media_upload/u-5",
      makeBlob([0], "image/png")
    );
    expect(res).toEqual({ _raw: "OK" });
  });

  it("surfaces 413 from the binary upload", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: false, status: 413, text: "Payload Too Large" } },
    ]);
    await expect(
      putChatMediaBinary(
        "https://substack.com/api/v1/thread_media_upload/u-big",
        makeBlob([0], "image/png")
      )
    ).rejects.toThrow(/^413/);
  });

  it("chunks large blobs without blowing the call-stack limit", async () => {
    chrome.scripting.executeScript.mockResolvedValue([
      { result: { ok: true, status: 200, text: '{"url":"x"}' } },
    ]);
    // 200KB blob — exercises the 32K chunk loop. fromCharCode.apply would
    // blow the stack at ~ 100K-200K bytes without chunking on some engines.
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const blob = new Blob([big], { type: "image/jpeg" });
    await putChatMediaBinary(
      "https://substack.com/api/v1/thread_media_upload/u-big",
      blob
    );
    const call = chrome.scripting.executeScript.mock.calls.at(-1)[0];
    const decoded = Uint8Array.from(atob(call.args[1]), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(200_000);
    expect(decoded[0]).toBe(0);
    expect(decoded[255]).toBe(255);
    expect(decoded[199_999]).toBe(199_999 & 0xff);
  });
});
