// AI moderation before posting (slice 3 of the moderation arc — see
// roadmap.md). Pure prompt-building + response-parsing only — the
// timer/DOM/network wiring lives in app.js (reviewModerationText,
// reviewAndSend). Every provider's callProvider() returns FREE TEXT ONLY
// (no JSON mode, no function-calling/tool-output structure on any of the
// 3 wired providers) — this module is what turns that free text into a
// structured, validated verdict, or fails closed.

// Kept small and fast: this call sits in the send path, so it should not
// itself blow past the arc's 1-2s post-review window. Web search is
// deliberately OFF for moderation (unlike AI Insights/Ask) — search adds
// multi-second latency the arc's oracle can't afford.
export const MODERATION_MAX_TOKENS = 512;
export const MODERATION_TIMEOUT_MS = 15000;
export const MODERATION_CONTEXT_MESSAGE_LIMIT = 100;
// Small budget — this is background/tone context for the reviewer model,
// not a summary payload, so it doesn't need AI Insights' full 60K budget.
export const MODERATION_CONTEXT_BUDGET_CHARS = 20000;

// Shared between app.js's submitComposer fail-fast precheck and
// reviewModerationText's own defensive check for the same condition
// (moderation toggled on with no provider/key ever configured, or one
// that got removed mid-session) — one string, no drift between the two.
export const MODERATION_NO_PROVIDER_MESSAGE =
  "AI moderation is on, but no AI provider is configured. Set one up in AI Insights, or turn off moderation (or enable skip-review) in Chat preferences.";

// Build the system prompt for a moderation review call.
//
// draftText: the message being reviewed (a single message, or a burst
// already joined into one — the caller decides which).
// contextString: formatMessagesForLLM(...).context — recent chat, for
// tone/background only. This call never summarizes the chat.
// replyingTo: { authorName, body } | null — when set, the model also
// classifies whether THAT parent message is political; when null,
// political_reply must always be reported false (the caller additionally
// enforces this — see reviewModerationText in app.js — never trust the
// model alone on a field it could hallucinate for a non-reply).
export function buildModerationSystemPrompt(contextString, opts = {}) {
  const draftText = opts.draftText || "";
  const replyingTo = opts.replyingTo || null;
  const replyBlock = replyingTo
    ? `\nREPLY CONTEXT — this draft is a reply to:\n${replyingTo.authorName || "someone"}: "${replyingTo.body || ""}"\n`
    : "";

  return `You are reviewing a DRAFT message before it posts to a public group chat, on behalf of the person about to send it. You are NOT summarizing the chat — the chat context below is background only, so you can judge tone and fit in context.

Classify the draft along these dimensions:

1. "offensive" — TRUE ONLY for content that is unpostable even after rewording: slurs, harassment, threats, doxxing, or similarly severe content. This is a NARROW, HIGH bar. Most blunt, rude, or divisive messages are NOT "offensive" — those belong in needs_reword instead.
2. "needs_reword" — TRUE for a message that is blunt, divisive, inflammatory, or otherwise poorly-registered for a public forum, even though it is NOT "offensive". This is the DEFAULT verdict for tone/framing problems — most messages that need work will land here, not under "offensive". When needs_reword is true, also provide "reworded": a rewrite that preserves the draft's substance and meaning but reads as calm, balanced, and appropriate for a public group chat. Never soften it into meaninglessness, and never add a claim the user didn't make. When needs_reword is false, set "reworded" to an empty string.
3. "political_reply" — TRUE only when REPLY CONTEXT is present below AND that parent message is about politics (elections, parties, policy, partisan issues). If there is no REPLY CONTEXT, this must be false.
4. "reasoning" — one or two sentences explaining your classification.
${replyBlock}
CHAT CONTEXT (background only, oldest → newest):
---
${contextString}
---

DRAFT MESSAGE TO REVIEW:
"${draftText}"

Respond with ONLY a single fenced JSON block, nothing else — no preamble, no epilogue, no commentary outside the fence:
\`\`\`json
{"offensive": true|false, "needs_reword": true|false, "reworded": "...", "political_reply": true|false, "reasoning": "..."}
\`\`\``;
}

export const MODERATION_USER_MESSAGE =
  "Review the draft message per your instructions and respond with the JSON block.";

// Extracts a fenced block's content — accepts ```json, ```JSON, or a bare
// ``` fence (models don't always honor the language-tag instruction).
// Non-greedy so a closing-looking ``` sequence inside "reasoning" text
// can't swallow past the real end of the block.
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

// Parse a moderation review response into a validated verdict, or a
// failure. NEVER throws — every failure path is a returned { ok:false }.
//
// mode: "full" (the eligible/mergeable send path — no mentions/reply/
// attachment, so a reword can safely replace the sent text) requires all
// 5 fields, and requires "reworded" to be a non-empty string when
// needs_reword is true. mode: "block-only" (a send with a mention, reply,
// or attachment — reword is never applied there, mention tokens can't
// safely survive a rewrite) only requires offensive/political_reply/
// reasoning — needs_reword/reworded are ignored even if present, so an
// attachment-only or otherwise textless send can't fail validation on a
// field the caller will never read.
export function parseModerationResponse(text, mode = "full") {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "empty response" };
  }
  const fenced = FENCE_RE.exec(text);
  const candidate = fenced ? fenced[1] : text.trim();
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (_) {
    return { ok: false, error: "unparseable JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "not a JSON object" };
  }
  if (typeof parsed.offensive !== "boolean") {
    return { ok: false, error: "missing/invalid offensive" };
  }
  if (typeof parsed.political_reply !== "boolean") {
    return { ok: false, error: "missing/invalid political_reply" };
  }
  if (typeof parsed.reasoning !== "string" || !parsed.reasoning.trim()) {
    return { ok: false, error: "missing/invalid reasoning" };
  }

  let needsReword = false;
  let reworded = "";
  if (mode === "full") {
    if (typeof parsed.needs_reword !== "boolean") {
      return { ok: false, error: "missing/invalid needs_reword" };
    }
    needsReword = parsed.needs_reword;
    if (needsReword) {
      if (typeof parsed.reworded !== "string" || !parsed.reworded.trim()) {
        return { ok: false, error: "needs_reword true but reworded missing/empty" };
      }
      reworded = parsed.reworded;
    }
  }

  return {
    ok: true,
    result: {
      offensive: parsed.offensive,
      needsReword,
      reworded,
      politicalReply: parsed.political_reply,
      reasoning: parsed.reasoning,
    },
  };
}
