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
// provider's public pricing page; verify periodically — these can drift.
// Numbers used for the live cost-per-call estimate in the Tune AI Model
// dialog. ONLY input pricing drives the displayed total because output is
// capped via max_tokens (1024 ≈ ~$0.001-$0.020 add-on depending on model)
// and the cost calculator surfaces it as a separate line.
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

// ----- OpenAI (gpt-4o-mini default, cheap + fast) -----
export const openai = {
  name: "openai",
  model: "gpt-4o-mini",
  buildRequest({ systemPrompt, conversation, apiKey, signal, model }) {
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
          max_tokens: 1024,
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
  buildRequest({ systemPrompt, conversation, apiKey, signal, model }) {
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
        body: JSON.stringify({
          model: model || anthropic.model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: conversation,
        }),
        signal,
      },
    };
  },
  parseResponse(json) {
    if (json && json.error) {
      return { error: json.error.message || "Anthropic error" };
    }
    const text =
      json && json.content && json.content[0] && json.content[0].text
        ? json.content[0].text
        : null;
    if (!text) return { error: "Anthropic: no response text" };
    return { text };
  },
};

// ----- Google (Gemini 2.5 Flash) -----
// Google's API uses different role names ("user" / "model") and puts the
// API key in the URL query string. systemInstruction is a separate top-
// level field, not part of contents[].
export const google = {
  name: "google",
  model: "gemini-2.5-flash",
  buildRequest({ systemPrompt, conversation, apiKey, signal, model }) {
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
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 1024,
          },
        }),
        signal,
      },
    };
  },
  parseResponse(json) {
    if (json && json.error) {
      return { error: json.error.message || "Google error" };
    }
    const text =
      json &&
      json.candidates &&
      json.candidates[0] &&
      json.candidates[0].content &&
      json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0]
        ? json.candidates[0].content.parts[0].text
        : null;
    if (!text) return { error: "Google: no response text" };
    return { text };
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
