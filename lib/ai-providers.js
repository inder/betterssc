// Provider implementations for AI Insights (BYOK — bring your own key).
//
// Each provider exports: { name, model, buildRequest, parseResponse }.
// callProvider() wraps the fetch + error envelope.
//
// PRIVACY NOTE: every byte of chat content sent here goes straight from
// the extension page (chrome-extension:// origin) to the configured
// provider's API. We never proxy through substack.com — that would leak
// chat content into the Substack tab's network trail, which is the
// opposite of what users expect. The substack proxy tab is for Substack
// API calls only.

// Per-model pricing in USD per 1,000,000 tokens. Sourced from each
// provider's public pricing page; VERIFY PERIODICALLY — these drift
// silently when providers reprice (Anthropic re-tiered Haiku between
// 3.5 and 4.5; OpenAI has cut gpt-4o multiple times). The live cost
// estimate in the Tune AI Model dialog reads from here, so wrong
// numbers here = wrong cost shown to the user. When in doubt, prefer
// over-estimating (user pleasantly surprised) to under-estimating
// (user surprised by their bill).
export const MODEL_CATALOG = {
  openai: [
    { id: "gpt-4o-mini", displayName: "gpt-4o-mini (fast, cheap)", inputPer1M: 0.15, outputPer1M: 0.60 },
    { id: "gpt-4o", displayName: "gpt-4o (more capable, ~17x cost)", inputPer1M: 2.50, outputPer1M: 10.00 },
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5 (fast, cheap)", inputPer1M: 1.00, outputPer1M: 5.00 },
    { id: "claude-sonnet-4-6", displayName: "claude-sonnet-4-6 (more capable, ~3x cost)", inputPer1M: 3.00, outputPer1M: 15.00 },
  ],
  google: [
    { id: "gemini-2.5-flash", displayName: "gemini-2.5-flash (fast, cheap)", inputPer1M: 0.075, outputPer1M: 0.30 },
    { id: "gemini-2.5-pro", displayName: "gemini-2.5-pro (more capable, ~17x cost)", inputPer1M: 1.25, outputPer1M: 10.00 },
  ],
};

export function getModelInfo(providerName, modelId) {
  const list = MODEL_CATALOG[providerName] || [];
  return list.find((m) => m.id === modelId) || list[0] || null;
}

// Default output token cap. The previous 1024 hit-rate was high enough on
// long market briefings (multi-stock + Open Questions tail) that responses
// were truncating mid-word. 2048 covers typical briefings with headroom;
// power users can dial up via the Tune AI Model dialog (1024 / 2048 / 4096).
export const DEFAULT_MAX_TOKENS = 2048;
export const MAX_TOKENS_OPTIONS = [1024, 2048, 4096];

function clampMaxTokens(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_TOKENS;
  if (v < 256) return 256;
  if (v > 8192) return 8192;
  return Math.floor(v);
}

// Caps Anthropic's server-side web_search invocations per call. 5 is
// enough for a single multi-hop question; a heavier value drives cost up
// without much marginal answer quality. Promote to a Tune dialog field
// later if power users start hitting the ceiling.
export const ANTHROPIC_WEB_SEARCH_MAX_USES = 5;

// Which providers support native web search in this build:
//   anthropic — yes, server-side web_search tool on /v1/messages
//   google    — yes, googleSearch grounding on generateContent
//   openai    — NO. Native web_search requires the Responses API
//               (/v1/responses), which is a separate endpoint and
//               body shape. Migrating OpenAI to Responses is tracked
//               as follow-up; the system prompt will tell the model
//               to stay strictly within the chat when this returns false.
export function supportsWebSearch(providerName) {
  return providerName === "anthropic" || providerName === "google";
}

// ----- OpenAI (gpt-4o-mini default, cheap + fast) -----
export const openai = {
  name: "openai",
  model: "gpt-4o-mini",
  buildRequest({ systemPrompt, conversation, apiKey, signal, model, maxTokens }) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || openai.model,
          messages: [
            { role: "system", content: systemPrompt },
            ...conversation,
          ],
          temperature: 0.4,
          max_tokens: clampMaxTokens(maxTokens),
        }),
        signal,
      },
    };
  },
  parseResponse(json) {
    if (json && json.error) {
      return { error: json.error.message || "OpenAI error" };
    }
    const text =
      json && json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content
        : null;
    if (!text) return { error: "OpenAI: no response text" };
    return { text };
  },
};

// ----- Anthropic (claude-haiku-4-5) -----
// Requires the anthropic-dangerous-direct-browser-access header to opt
// into direct browser calls; without it Anthropic returns a CORS error.
export const anthropic = {
  name: "anthropic",
  model: "claude-haiku-4-5-20251001",
  buildRequest({ systemPrompt, conversation, apiKey, signal, model, maxTokens, webSearchEnabled }) {
    const body = {
      model: model || anthropic.model,
      max_tokens: clampMaxTokens(maxTokens),
      system: systemPrompt,
      messages: conversation,
    };
    if (webSearchEnabled) {
      // Anthropic native server-side tool. max_uses caps the cost at the
      // provider — 5 searches is plenty for a single Ask call. The
      // citations come back inside text blocks' `citations` array; we
      // pull them out in parseResponse.
      body.tools = [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: ANTHROPIC_WEB_SEARCH_MAX_USES,
      }];
    }
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
        signal,
      },
    };
  },
  parseResponse(json) {
    if (json && json.error) {
      return { error: json.error.message || "Anthropic error" };
    }
    // Anthropic returns content as an array of blocks. When web search
    // ran, blocks interleave: server_tool_use (the search invocation),
    // web_search_tool_result (the raw results), and text blocks (the
    // model's prose). Text blocks may carry per-citation entries inside
    // `citations: [{type:"web_search_result_location", url, title, ...}]`.
    // We concatenate text and collect unique citations by URL.
    const content = (json && Array.isArray(json.content)) ? json.content : [];
    const textParts = [];
    const citationMap = new Map();
    for (const block of content) {
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
        if (Array.isArray(block.citations)) {
          for (const c of block.citations) {
            // Scheme guard: only http(s) URLs reach the renderer. The
            // DOM-side a.href assignment in app.js does NOT block
            // javascript: / data: URIs — they're navigable when clicked
            // — so we filter at the parse boundary. Anthropic's web
            // search never returns non-http schemes in practice, but
            // shouldn't-happen ≠ won't-happen.
            if (!c || !c.url || citationMap.has(c.url)) continue;
            if (!/^https?:\/\//i.test(c.url)) continue;
            citationMap.set(c.url, {
              url: c.url,
              title: c.title || c.url,
              snippet: c.cited_text || "",
            });
          }
        }
      }
    }
    const text = textParts.join("").trim();
    if (!text) return { error: "Anthropic: no response text" };
    const citations = Array.from(citationMap.values());
    return citations.length ? { text, citations } : { text };
  },
};

// ----- Google (Gemini 2.5 Flash) -----
// Google's API uses different role names ("user" / "model") and puts the
// API key in the URL query string. systemInstruction is a separate top-
// level field, not part of contents[].
export const google = {
  name: "google",
  model: "gemini-2.5-flash",
  buildRequest({ systemPrompt, conversation, apiKey, signal, model, maxTokens, webSearchEnabled }) {
    // Google only accepts "user" / "model" roles. Reject any other role
    // up front rather than silently coercing a "system" turn into a
    // user message (which would mix the system prompt into the
    // conversation and produce confusing outputs).
    const contents = conversation
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const modelId = model || google.model;
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: clampMaxTokens(maxTokens),
      },
    };
    if (webSearchEnabled) {
      // Gemini 2.5 google_search grounding. The response will carry a
      // groundingMetadata field with the chunks and supports.
      body.tools = [{ google_search: {} }];
    }
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    };
  },
  parseResponse(json) {
    if (json && json.error) {
      return { error: json.error.message || "Google error" };
    }
    const cand = json && json.candidates && json.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    const text =
      parts && parts[0] && typeof parts[0].text === "string"
        ? parts[0].text
        : null;
    if (!text) return { error: "Google: no response text" };
    // groundingMetadata.groundingChunks carries [{web: {uri, title}}, ...]
    // when the google_search tool was invoked. Each chunk's web object
    // becomes a citation. Dedupe by URL, first-seen-wins (matches
    // anthropic.parseResponse semantics for downstream consistency).
    const chunks =
      (cand && cand.groundingMetadata && Array.isArray(cand.groundingMetadata.groundingChunks))
        ? cand.groundingMetadata.groundingChunks
        : [];
    const citationMap = new Map();
    for (const chunk of chunks) {
      const web = chunk && chunk.web;
      if (!web || !web.uri || citationMap.has(web.uri)) continue;
      // Scheme guard — same reasoning as anthropic.parseResponse above.
      if (!/^https?:\/\//i.test(web.uri)) continue;
      citationMap.set(web.uri, {
        url: web.uri,
        title: web.title || web.uri,
        snippet: "",
      });
    }
    const citations = Array.from(citationMap.values());
    return citations.length ? { text, citations } : { text };
  },
};

export const PROVIDERS = { openai, anthropic, google };

// Friendly wrapper. Returns { text } on success, { error } on any
// failure path (network, HTTP non-2xx, malformed body, abort, missing key).
// NEVER logs apiKey — caller passes it in, it goes straight into the
// header/url and never appears in any string we own beyond that.
export async function callProvider(provider, params) {
  if (!provider || !PROVIDERS[provider.name]) {
    return { error: "Unknown provider" };
  }
  if (!params || !params.apiKey) {
    return { error: "Missing API key" };
  }
  if (!params.systemPrompt || !Array.isArray(params.conversation)) {
    return { error: "Invalid request shape" };
  }
  const { url, init } = provider.buildRequest(params);
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      // Only surface a server message if we can parse one out of a JSON
      // error envelope. Raw bodyText is intentionally NOT included —
      // some providers occasionally reflect request fragments in error
      // bodies, and we don't want any chance of an auth header leaking
      // into a user-facing error string.
      const bodyText = await res.text().catch(() => "");
      let serverMsg = null;
      try {
        const parsed = JSON.parse(bodyText);
        serverMsg =
          (parsed && parsed.error && parsed.error.message) ||
          (parsed && parsed.message) ||
          null;
      } catch (_) {}
      return {
        error: `${provider.name} ${res.status}: ${serverMsg || "request failed"}`,
      };
    }
    const json = await res.json();
    return provider.parseResponse(json);
  } catch (e) {
    if (e && e.name === "AbortError") return { error: "Cancelled" };
    return { error: `${provider.name} network error: ${(e && e.message) || e}` };
  }
}
