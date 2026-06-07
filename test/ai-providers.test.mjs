// Unit tests for lib/ai-providers.js — BYOK provider adapters.
//
// Covers buildRequest shape, parseResponse extraction + error paths, and
// the callProvider boundary guards (missing key, bad shape, unknown
// provider). The security invariant test asserts the apiKey never leaks
// into a request body payload.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  openai,
  anthropic,
  google,
  PROVIDERS,
  callProvider,
} from "../lib/ai-providers.js";

const SYSTEM_PROMPT = "You are a helpful assistant.";
const CONVERSATION = [
  { role: "user", content: "Hi there." },
  { role: "assistant", content: "Hello!" },
  { role: "user", content: "What's up?" },
];
const API_KEY = "sk-secret-key-xyz-123";

// ---------------------------------------------------------------------------
// buildRequest — happy path shape
// ---------------------------------------------------------------------------

describe("openai.buildRequest", () => {
  it("returns correct url + headers + body shape", () => {
    const { url, init } = openai.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe(openai.model);
    expect(body.model).toMatch(/^gpt-/);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: SYSTEM_PROMPT,
    });
    // user + assistant + user from CONVERSATION should follow the system msg.
    expect(body.messages.slice(1)).toEqual(CONVERSATION);
  });
});

describe("anthropic.buildRequest", () => {
  it("returns correct url + headers + body shape (system separate from messages)", () => {
    const { url, init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe(API_KEY);
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["anthropic-dangerous-direct-browser-access"]).toBe(
      "true"
    );
    const body = JSON.parse(init.body);
    expect(body.model).toBe(anthropic.model);
    expect(body.model).toMatch(/^claude-/);
    expect(body.system).toBe(SYSTEM_PROMPT);
    // messages must NOT contain a system message — system lives at top level.
    expect(body.messages).toEqual(CONVERSATION);
    expect(body.messages.some((m) => m.role === "system")).toBe(false);
  });
});

describe("google.buildRequest", () => {
  it("returns correct url + body shape; maps 'assistant' role to 'model'", () => {
    const { url, init } = google.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain(google.model);
    expect(url).toContain(`key=${encodeURIComponent(API_KEY)}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    // systemInstruction is a top-level field separate from contents.
    expect(body.systemInstruction).toEqual({
      parts: [{ text: SYSTEM_PROMPT }],
    });
    expect(Array.isArray(body.contents)).toBe(true);
    expect(body.contents).toHaveLength(CONVERSATION.length);
    // Role mapping: assistant → model, user → user.
    expect(body.contents[0]).toEqual({
      role: "user",
      parts: [{ text: "Hi there." }],
    });
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [{ text: "Hello!" }],
    });
    expect(body.contents[2]).toEqual({
      role: "user",
      parts: [{ text: "What's up?" }],
    });
  });
});

// ---------------------------------------------------------------------------
// parseResponse — happy path text extraction
// ---------------------------------------------------------------------------

describe("openai.parseResponse", () => {
  it("extracts text from a typical success envelope", () => {
    const res = openai.parseResponse({
      choices: [{ message: { content: "Hello back!" } }],
    });
    expect(res).toEqual({ text: "Hello back!" });
  });

  it("returns {error} when the API returns an error envelope", () => {
    const res = openai.parseResponse({
      error: { message: "Rate limit exceeded" },
    });
    expect(res).toEqual({ error: "Rate limit exceeded" });
  });

  it("returns {error} when text is missing (empty choices)", () => {
    const res = openai.parseResponse({ choices: [] });
    expect(res.error).toBeTruthy();
    expect(res.text).toBeUndefined();
  });
});

describe("anthropic.parseResponse", () => {
  it("extracts text from a typical success envelope", () => {
    const res = anthropic.parseResponse({
      content: [{ type: "text", text: "Hi from Claude." }],
    });
    expect(res).toEqual({ text: "Hi from Claude." });
  });

  it("returns {error} when the API returns an error envelope", () => {
    const res = anthropic.parseResponse({
      error: { message: "Invalid API key" },
    });
    expect(res).toEqual({ error: "Invalid API key" });
  });

  it("returns {error} when text is missing (empty content)", () => {
    const res = anthropic.parseResponse({ content: [] });
    expect(res.error).toBeTruthy();
    expect(res.text).toBeUndefined();
  });
});

describe("google.parseResponse", () => {
  it("extracts text from a typical success envelope", () => {
    const res = google.parseResponse({
      candidates: [
        { content: { parts: [{ text: "Hello from Gemini." }] } },
      ],
    });
    expect(res).toEqual({ text: "Hello from Gemini." });
  });

  it("returns {error} when the API returns an error envelope", () => {
    const res = google.parseResponse({
      error: { message: "Quota exceeded" },
    });
    expect(res).toEqual({ error: "Quota exceeded" });
  });

  it("returns {error} when text is missing (empty candidates)", () => {
    const res = google.parseResponse({ candidates: [] });
    expect(res.error).toBeTruthy();
    expect(res.text).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// callProvider boundary guards (no fetch needed)
// ---------------------------------------------------------------------------

describe("callProvider boundary guards", () => {
  it("returns {error: 'Missing API key'} when apiKey is absent", async () => {
    const res = await callProvider(openai, {
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      // apiKey intentionally omitted.
    });
    expect(res).toEqual({ error: "Missing API key" });
  });

  it("returns {error: 'Missing API key'} when params object is missing entirely", async () => {
    const res = await callProvider(openai, null);
    expect(res).toEqual({ error: "Missing API key" });
  });

  it("returns {error: 'Invalid request shape'} when conversation is not an array", async () => {
    const res = await callProvider(openai, {
      systemPrompt: SYSTEM_PROMPT,
      conversation: "not-an-array",
      apiKey: API_KEY,
    });
    expect(res).toEqual({ error: "Invalid request shape" });
  });

  it("returns {error: 'Invalid request shape'} when systemPrompt is missing", async () => {
    const res = await callProvider(openai, {
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(res).toEqual({ error: "Invalid request shape" });
  });

  it("returns {error: 'Unknown provider'} when provider.name is not in PROVIDERS", async () => {
    const res = await callProvider(
      { name: "made-up", buildRequest() {}, parseResponse() {} },
      {
        systemPrompt: SYSTEM_PROMPT,
        conversation: CONVERSATION,
        apiKey: API_KEY,
      }
    );
    expect(res).toEqual({ error: "Unknown provider" });
  });

  it("returns {error: 'Unknown provider'} when provider is null/undefined", async () => {
    const res = await callProvider(null, {
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(res).toEqual({ error: "Unknown provider" });
  });
});

// ---------------------------------------------------------------------------
// PROVIDERS registry sanity
// ---------------------------------------------------------------------------

describe("PROVIDERS registry", () => {
  it("exposes openai, anthropic, google", () => {
    expect(PROVIDERS.openai).toBe(openai);
    expect(PROVIDERS.anthropic).toBe(anthropic);
    expect(PROVIDERS.google).toBe(google);
  });
});

// ---------------------------------------------------------------------------
// Security invariant — apiKey MUST NOT appear in the request body string.
// It belongs in the Authorization header (openai), x-api-key header
// (anthropic), or the URL query string (google) — never in init.body.
// ---------------------------------------------------------------------------

describe("security: apiKey never appears in init.body", () => {
  const sentinelKey = "SENTINEL-KEY-MUST-NOT-LEAK-INTO-BODY-ABCDEF";
  const params = {
    systemPrompt: SYSTEM_PROMPT,
    conversation: CONVERSATION,
    apiKey: sentinelKey,
  };

  it("openai.buildRequest body does not contain the apiKey", () => {
    const { init } = openai.buildRequest(params);
    expect(typeof init.body).toBe("string");
    expect(init.body.includes(sentinelKey)).toBe(false);
  });

  it("anthropic.buildRequest body does not contain the apiKey", () => {
    const { init } = anthropic.buildRequest(params);
    expect(typeof init.body).toBe("string");
    expect(init.body.includes(sentinelKey)).toBe(false);
  });

  it("google.buildRequest body does not contain the apiKey", () => {
    const { url, init } = google.buildRequest(params);
    expect(typeof init.body).toBe("string");
    expect(init.body.includes(sentinelKey)).toBe(false);
    // sanity: google puts the key in the URL, which is fine.
    expect(url.includes(sentinelKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// callProvider fetch paths — happy + non-2xx + abort.
// We stub global fetch via vi.stubGlobal so no network or extra deps.
// ---------------------------------------------------------------------------

describe("callProvider fetch paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns {text} on a successful fetch + parse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "hello from openai" } }],
        }),
        text: async () => "",
      }))
    );
    const res = await callProvider(openai, {
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(res).toEqual({ text: "hello from openai" });
  });

  it("returns {error} prefixed with provider name on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => JSON.stringify({ error: { message: "slow down" } }),
      }))
    );
    const res = await callProvider(anthropic, {
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(res.error).toContain("anthropic");
    expect(res.error).toContain("429");
    expect(res.error).toContain("slow down");
  });

  it("returns {error: 'Cancelled'} when fetch throws an AbortError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      })
    );
    const res = await callProvider(openai, {
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(res).toEqual({ error: "Cancelled" });
  });

  it("returns network error string when fetch throws a non-abort error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );
    const res = await callProvider(google, {
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(res.error).toContain("google");
    expect(res.error).toContain("ECONNRESET");
  });
});
