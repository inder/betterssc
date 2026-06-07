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

// ----- OpenAI (gpt-4o-mini, cheap + fast) -----
export const openai = {
  name: "openai",
  model: "gpt-4o-mini",
  buildRequest({ systemPrompt, conversation, apiKey, signal }) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: openai.model,
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
  buildRequest({ systemPrompt, conversation, apiKey, signal }) {
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
          model: anthropic.model,
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
  buildRequest({ systemPrompt, conversation, apiKey, signal }) {
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
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${google.model}:generateContent?key=${encodeURIComponent(apiKey)}`,
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
