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

const DEFAULT_BUDGET_CHARS = 6000;
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

// Default system prompt for the one-click "AI Insights" preview.
// Tone deliberately calm and structured; we ask for sections so the
// rendered output has natural headings the user can scan quickly.
export function buildSystemPrompt(contextString, opts = {}) {
  const lens = opts.lens || "trading";
  const lensHint =
    lens === "trading"
      ? "This is a financial / markets / trading group chat. Pay attention to ticker mentions, trade ideas, entries/exits, theses, and risk caveats."
      : "Read the conversation neutrally.";
  return `You are reading a private group chat. ${lensHint} Be concrete: name people, name tickers, quote brief snippets when useful. Avoid hedging. If something is uncertain or speculative, say so explicitly.

CHAT CONTEXT (oldest → newest):
---
${contextString}
---

Format your response with these sections (omit any that have nothing real to say):
- **Themes** — 1-3 lines on what's being discussed
- **Key takeaways** — bullets of the most important claims or conclusions
- **Notable trades / ideas** — bullets of specific tickers, entries, theses
- **Open questions** — what's unresolved or being asked`;
}

// The user-side prompt for the one-click preview action. Kept short
// because the heavy lifting is in the system prompt.
export function buildPreviewUserMessage() {
  return "Give me the insights summary for this conversation.";
}
