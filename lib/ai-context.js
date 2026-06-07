// Format a filtered slice of chat messages into a string suitable for
// inclusion in an LLM system prompt. Pure functions — caller owns the
// state-shape concerns (search filter, thread filter, etc.) and passes
// in the array of comments already filtered + sorted oldest → newest.
//
// Caller contract:
//   comments: Array<{ id, author?: {name}, body, created_at }>
//   The body should be the rendered text (mentions resolved if you want
//   them shown as @name; raw body works too — the LLM handles both).
//
// All exports are pure: no DOM, no state, no fetch.

// 60K chars ≈ 15K tokens, which is <12% of every supported provider's
// context window (gpt-4o-mini 128K, claude-haiku-4-5 200K,
// gemini-2.5-flash 1M). Sized to fit realistic full-chat summaries
// without paying the latency + cost tax of maxing out the window, and
// well clear of the long-context "lost in the middle" attention cliff.
const DEFAULT_BUDGET_CHARS = 60000;
const TRUNCATION_MARKER = "[earlier messages omitted to fit the context window]";

// Best-effort time stamp: "HH:MM" within a single day, "MMM D HH:MM"
// across multiple days. Falls back to the raw ISO if parsing fails.
export function formatTimestamp(iso, opts = {}) {
  const showDate = !!opts.showDate;
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (!showDate) return `${hh}:${mm}`;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

// True when the span of `comments` covers more than one calendar day.
function spansMultipleDays(comments) {
  if (!comments || comments.length < 2) return false;
  const first = new Date(comments[0].created_at);
  const last = new Date(comments[comments.length - 1].created_at);
  if (isNaN(first.getTime()) || isNaN(last.getTime())) return false;
  return (
    first.getFullYear() !== last.getFullYear() ||
    first.getMonth() !== last.getMonth() ||
    first.getDate() !== last.getDate()
  );
}

// Turn one comment into a single line: "[time] Author Name: body".
// The body is single-lined (newlines collapsed to " · ") so each comment
// is one line for easier LLM tokenization.
function formatLine(c, showDate) {
  const ts = formatTimestamp(c.created_at, { showDate });
  const author =
    (c.author && (c.author.name || c.author.handle)) || "Unknown";
  // Collapse newlines + surrounding ASCII horizontal whitespace so each
  // comment renders as one line. Intentionally NOT \s — that would
  // swallow non-breaking / ideographic spaces inside CJK / multilingual
  // bodies, which would corrupt the user's text in the LLM context.
  const body = (c.body || "").replace(/[ \t]*\n+[ \t]*/g, " · ").trim();
  return `[${ts}] ${author}: ${body}`;
}

// Format the full slice into a single context string. If the total
// exceeds `budget`, drop oldest messages one by one until it fits and
// prepend TRUNCATION_MARKER.
//
// Returns { context: string, included: number, dropped: number }.
export function formatMessagesForLLM(comments, opts = {}) {
  const budget = opts.budget != null ? opts.budget : DEFAULT_BUDGET_CHARS;
  if (!comments || !comments.length) {
    return { context: "(no messages in current view)", included: 0, dropped: 0 };
  }
  const showDate = spansMultipleDays(comments);
  const lines = comments.map((c) => formatLine(c, showDate));
  let joined = lines.join("\n");
  if (joined.length <= budget) {
    return { context: joined, included: lines.length, dropped: 0 };
  }
  // Truncate from oldest. Drop lines one at a time until the remaining
  // text + truncation marker fits the budget.
  let dropped = 0;
  while (lines.length > 1) {
    lines.shift();
    dropped += 1;
    joined = TRUNCATION_MARKER + "\n" + lines.join("\n");
    if (joined.length <= budget) break;
  }
  // Last-resort hard truncation: if even one line + marker still exceeds
  // budget (very long single body), crop the surviving line so the
  // returned context is GUARANTEED to fit. Without this a pasted block
  // of text could silently blow past the caller's budget.
  if (joined.length > budget) {
    const headroom = Math.max(
      40,
      budget - TRUNCATION_MARKER.length - 6 // " · …\n" overhead
    );
    const survivor = lines[0] || "";
    const cropped = survivor.slice(0, headroom) + " …";
    joined = TRUNCATION_MARKER + "\n" + cropped;
  }
  return { context: joined, included: lines.length, dropped };
}

// Default lens hint — describes the *kind* of chat we're reading so the
// LLM knows where to focus attention. The default is trading-flavored
// because BetterSSC's prototype audience is Za Terminal-style markets
// chats, but the user can override it via the Tune Prompt dialog if
// they use BetterSSC for a different community.
export const DEFAULT_LENS_HINT =
  "This is a financial / markets / trading group chat. Pay attention to ticker mentions, trade ideas, entries/exits, theses, and risk caveats.";

// Default response-format template — drives the section headings the
// LLM emits. Editable per user via the Tune Prompt dialog.
export const DEFAULT_FORMAT_TEMPLATE = `Format your response with these sections (omit any that have nothing real to say):
- **Themes** — 1-3 lines on what's being discussed
- **Key takeaways** — bullets of the most important claims or conclusions
- **Notable trades / ideas** — bullets of specific tickers, entries, theses
- **Open questions** — what's unresolved or being asked`;

// Default system prompt for the one-click "AI Insights" preview.
// Tone deliberately calm and structured; we ask for sections so the
// rendered output has natural headings the user can scan quickly.
//
// opts.focusedAuthor: when the user has filtered the chat to one
// person (via @name, /from:, or /me), every observation gets phrased
// in third person from that person's viewpoint ("In Jordan's view, …",
// "Jordan thinks …"). Without this the LLM tends to summarize "the
// chat is discussing X" which is wrong — the chat IS just one
// person at that point. THIS LOGIC IS NOT USER-OVERRIDABLE — it's
// mechanical (driven by the search filter) and breaking it produces
// summaries that look like bugs.
//
// opts.lensHint: optional override for the "what kind of chat is
// this" hint. Falls back to DEFAULT_LENS_HINT (trading-flavored).
// opts.formatTemplate: optional override for the response-format
// section block. Falls back to DEFAULT_FORMAT_TEMPLATE.
export function buildSystemPrompt(contextString, opts = {}) {
  const lensHint =
    typeof opts.lensHint === "string" && opts.lensHint.trim()
      ? opts.lensHint.trim()
      : DEFAULT_LENS_HINT;
  const formatTemplate =
    typeof opts.formatTemplate === "string" && opts.formatTemplate.trim()
      ? opts.formatTemplate.trim()
      : DEFAULT_FORMAT_TEMPLATE;
  const focusedAuthor = (opts.focusedAuthor || "").trim();
  const perspectiveHint = focusedAuthor
    ? ` The user has filtered the view to show ONLY messages from ${focusedAuthor}. Phrase every observation in the third person from ${focusedAuthor}'s viewpoint. Use constructions like "In ${focusedAuthor}'s view, …", "${focusedAuthor} thinks …", "${focusedAuthor}'s thesis is that …", "${focusedAuthor} flagged that …". Do NOT speak as a neutral summarizer of "the chat"; the chat at this point IS ${focusedAuthor}. Do not reference other authors unless ${focusedAuthor} quoted or explicitly addressed them.`
    : "";
  return `You are reading a private group chat. ${lensHint}${perspectiveHint} Be concrete: name people, name tickers, quote brief snippets when useful. Avoid hedging. If something is uncertain or speculative, say so explicitly.

CHAT CONTEXT (oldest → newest):
---
${contextString}
---

${formatTemplate}`;
}

// The user-side prompt for the one-click preview action. Kept short
// because the heavy lifting is in the system prompt.
//
// opts.variant: "normal" (default), "concise", or "elaborate".
// "concise" appends a length constraint; "elaborate" asks for more
// depth. Both are length steers — the *structure* (themes / takeaways
// / trades / questions) stays the same so the user can compare apples
// to apples across regenerations.
export function buildPreviewUserMessage(opts = {}) {
  const variant = opts.variant || "normal";
  const base = "Give me the insights summary for this conversation.";
  if (variant === "concise") {
    return base + " Keep it tight: 3-4 bullets total across all sections, headlines only, no preamble.";
  }
  if (variant === "elaborate") {
    return base + " Be thorough: include direct short quotes where they're load-bearing, 2-3 sentences per section, and call out caveats / contrary views explicitly.";
  }
  return base;
}
