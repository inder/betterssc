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
  MODEL_CATALOG,
  getModelInfo,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_OPTIONS,
  supportsWebSearch,
  ANTHROPIC_WEB_SEARCH_MAX_USES,
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

// ---------------------------------------------------------------------------
// MODEL_CATALOG + getModelInfo
// ---------------------------------------------------------------------------

describe("MODEL_CATALOG", () => {
  it("has at least one model per provider", () => {
    expect(MODEL_CATALOG.openai.length).toBeGreaterThan(0);
    expect(MODEL_CATALOG.anthropic.length).toBeGreaterThan(0);
    expect(MODEL_CATALOG.google.length).toBeGreaterThan(0);
  });
  it("every model has id + displayName + numeric pricing", () => {
    for (const list of Object.values(MODEL_CATALOG)) {
      for (const m of list) {
        expect(typeof m.id).toBe("string");
        expect(m.id.length).toBeGreaterThan(0);
        expect(typeof m.displayName).toBe("string");
        expect(typeof m.inputPer1M).toBe("number");
        expect(m.inputPer1M).toBeGreaterThan(0);
        expect(typeof m.outputPer1M).toBe("number");
        expect(m.outputPer1M).toBeGreaterThan(0);
      }
    }
  });
  it("default model id matches the first catalog entry for each provider", () => {
    expect(MODEL_CATALOG.openai[0].id).toBe(openai.model);
    expect(MODEL_CATALOG.anthropic[0].id).toBe(anthropic.model);
    expect(MODEL_CATALOG.google[0].id).toBe(google.model);
  });
});

describe("getModelInfo", () => {
  it("returns the exact model when id matches", () => {
    const info = getModelInfo("openai", "gpt-4o");
    expect(info).not.toBeNull();
    expect(info.id).toBe("gpt-4o");
    expect(info.inputPer1M).toBeGreaterThan(0);
  });
  it("falls back to the first catalog entry on unknown id", () => {
    const info = getModelInfo("openai", "no-such-model");
    expect(info).not.toBeNull();
    expect(info.id).toBe(MODEL_CATALOG.openai[0].id);
  });
  it("returns null on unknown provider", () => {
    expect(getModelInfo("xai", "grok-9000")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// model override via params.model — verifies the new Tune AI Model wiring
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Output cap (max_tokens) — default + override + clamp + per-provider field
// ---------------------------------------------------------------------------

describe("output cap defaults + overrides", () => {
  it("DEFAULT_MAX_TOKENS is 2048 (raised from 1024 to cover long briefings)", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(2048);
  });

  it("MAX_TOKENS_OPTIONS is the UI selector set [1024, 2048, 4096]", () => {
    expect(MAX_TOKENS_OPTIONS).toEqual([1024, 2048, 4096]);
  });

  it("openai max_tokens defaults to 2048 when params.maxTokens omitted", () => {
    const { init } = openai.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(JSON.parse(init.body).max_tokens).toBe(2048);
  });

  it("openai max_tokens uses params.maxTokens when provided", () => {
    const { init } = openai.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      maxTokens: 4096,
    });
    expect(JSON.parse(init.body).max_tokens).toBe(4096);
  });

  it("anthropic max_tokens defaults to 2048 when params.maxTokens omitted", () => {
    const { init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(JSON.parse(init.body).max_tokens).toBe(2048);
  });

  it("anthropic max_tokens uses params.maxTokens when provided", () => {
    const { init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      maxTokens: 4096,
    });
    expect(JSON.parse(init.body).max_tokens).toBe(4096);
  });

  it("google maxOutputTokens defaults to 2048 when params.maxTokens omitted", () => {
    const { init } = google.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(JSON.parse(init.body).generationConfig.maxOutputTokens).toBe(2048);
  });

  it("google maxOutputTokens uses params.maxTokens when provided", () => {
    const { init } = google.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      maxTokens: 1024,
    });
    expect(JSON.parse(init.body).generationConfig.maxOutputTokens).toBe(1024);
  });

  it("clamps insanely high maxTokens to 8192 ceiling", () => {
    const { init } = openai.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      maxTokens: 999_999,
    });
    expect(JSON.parse(init.body).max_tokens).toBe(8192);
  });

  it("clamps tiny maxTokens to 256 floor (prevents broken-response zero/negative)", () => {
    const { init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      maxTokens: 0,
    });
    expect(JSON.parse(init.body).max_tokens).toBe(256);
  });

  it("falls back to DEFAULT_MAX_TOKENS when maxTokens is non-numeric garbage", () => {
    const { init } = google.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      maxTokens: "not-a-number",
    });
    expect(JSON.parse(init.body).generationConfig.maxOutputTokens).toBe(DEFAULT_MAX_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// Web search tool — native attachment per provider, citation parsing
// ---------------------------------------------------------------------------

describe("supportsWebSearch", () => {
  it("returns true for anthropic (native web_search tool)", () => {
    expect(supportsWebSearch("anthropic")).toBe(true);
  });
  it("returns true for google (googleSearch grounding)", () => {
    expect(supportsWebSearch("google")).toBe(true);
  });
  it("returns false for openai (Responses API migration pending)", () => {
    expect(supportsWebSearch("openai")).toBe(false);
  });
  it("returns false for unknown providers", () => {
    expect(supportsWebSearch("xai")).toBe(false);
    expect(supportsWebSearch("")).toBe(false);
    expect(supportsWebSearch(null)).toBe(false);
  });
});

describe("buildRequest with webSearchEnabled", () => {
  it("anthropic attaches web_search_20250305 tool when enabled", () => {
    const { init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      webSearchEnabled: true,
    });
    const body = JSON.parse(init.body);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: ANTHROPIC_WEB_SEARCH_MAX_USES,
    });
  });

  it("ANTHROPIC_WEB_SEARCH_MAX_USES is a reasonable cap (3-10 range)", () => {
    expect(ANTHROPIC_WEB_SEARCH_MAX_USES).toBeGreaterThanOrEqual(3);
    expect(ANTHROPIC_WEB_SEARCH_MAX_USES).toBeLessThanOrEqual(10);
  });

  it("anthropic omits tools when webSearchEnabled is false", () => {
    const { init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      webSearchEnabled: false,
    });
    expect(JSON.parse(init.body).tools).toBeUndefined();
  });

  it("anthropic omits tools when webSearchEnabled is omitted", () => {
    const { init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    expect(JSON.parse(init.body).tools).toBeUndefined();
  });

  it("google attaches google_search tool when enabled", () => {
    const { init } = google.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      webSearchEnabled: true,
    });
    const body = JSON.parse(init.body);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools[0]).toEqual({ google_search: {} });
  });

  it("google omits tools when webSearchEnabled is false", () => {
    const { init } = google.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      webSearchEnabled: false,
    });
    expect(JSON.parse(init.body).tools).toBeUndefined();
  });

  it("openai ignores webSearchEnabled (no native chat-completions tool)", () => {
    // Even when caller passes webSearchEnabled:true, openai.buildRequest
    // does NOT attach a tool — supportsWebSearch returns false so the
    // call-site is supposed to gate this. Defense-in-depth: even if it
    // got through, no broken tool config lands in the request.
    const { init } = openai.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      webSearchEnabled: true,
    });
    expect(JSON.parse(init.body).tools).toBeUndefined();
  });
});

describe("anthropic.parseResponse — citations extraction", () => {
  it("extracts text + citations from a web-search-aware response", () => {
    const res = anthropic.parseResponse({
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "spx today" } },
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", url: "https://example.com/a", title: "A" },
          ],
        },
        {
          type: "text",
          text: "SPX closed at 7400.",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example.com/a",
              title: "A",
              cited_text: "SPX closed at 7400 today",
            },
          ],
        },
      ],
    });
    expect(res.text).toBe("SPX closed at 7400.");
    expect(res.citations).toEqual([
      {
        url: "https://example.com/a",
        title: "A",
        snippet: "SPX closed at 7400 today",
      },
    ]);
  });

  it("dedupes citations by URL across multiple text blocks", () => {
    const res = anthropic.parseResponse({
      content: [
        {
          type: "text",
          text: "First. ",
          citations: [{ url: "https://example.com/a", title: "A", cited_text: "first" }],
        },
        {
          type: "text",
          text: "Second.",
          citations: [
            { url: "https://example.com/a", title: "A (dup)", cited_text: "dup snippet" },
            { url: "https://example.com/b", title: "B", cited_text: "b text" },
          ],
        },
      ],
    });
    expect(res.text).toBe("First. Second.");
    expect(res.citations).toHaveLength(2);
    // First-seen wins for duplicates.
    expect(res.citations[0]).toEqual({
      url: "https://example.com/a",
      title: "A",
      snippet: "first",
    });
    expect(res.citations[1].url).toBe("https://example.com/b");
  });

  it("returns {text} with no citations key when none are present (backwards-compatible)", () => {
    const res = anthropic.parseResponse({
      content: [{ type: "text", text: "plain answer" }],
    });
    expect(res).toEqual({ text: "plain answer" });
    expect(res.citations).toBeUndefined();
  });

  it("falls back to error when content has no text block", () => {
    const res = anthropic.parseResponse({
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "x" } },
      ],
    });
    expect(res.error).toBeTruthy();
  });
});

describe("buildRequest with params.model override", () => {
  it("openai uses params.model in the JSON body when provided", () => {
    const { init } = openai.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      model: "gpt-4o",
    });
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o");
  });
  it("openai falls back to default model when params.model is absent", () => {
    const { init } = openai.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
    });
    const body = JSON.parse(init.body);
    expect(body.model).toBe(openai.model);
  });
  it("anthropic uses params.model in the JSON body when provided", () => {
    const { init } = anthropic.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      model: "claude-sonnet-4-6",
    });
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-sonnet-4-6");
  });
  it("google uses params.model in the URL when provided", () => {
    const { url } = google.buildRequest({
      systemPrompt: SYSTEM_PROMPT,
      conversation: CONVERSATION,
      apiKey: API_KEY,
      model: "gemini-2.5-pro",
    });
    expect(url).toContain("gemini-2.5-pro:generateContent");
  });
});
