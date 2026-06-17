// Format a filtered slice of chat messages into a string suitable for
// inclusion in an LLM system prompt. Pure functions — caller owns the
// state-shape concerns (search filter, thread filter, etc.) and passes
// in the array of comments already filtered + sorted oldest → newest.
//
// Caller contract:
//   comments: Array<{
//     id, author?: {name|handle}, body, created_at,
//     quote?: { author?, body, id },   // quote-reply parent (attached inline)
//     parent_id? | quote_id?,          // threaded-reply pointer (resolved in slice)
//     reactions?: { <name>: count | {count} },
//   }>
//   The body should be the rendered text (mentions resolved if you want
//   them shown as @name; raw body works too — the LLM handles both).
//   quote / parent_id tell the LLM who-replied-to-whom so it attributes a
//   claim to the right subject instead of the speaker's own earlier topic.
//
// Pure: no DOM/state/fetch. Only reactionEmojiFor (a name→glyph map) imported.
import { reactionEmojiFor } from "./emojis.js";

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

const authorName = (a) => (a && (a.name || a.handle)) || null;

// Defensive reaction count read: REST numeric ({name: 3}) or WS object
// ({name: {count, has_reacted}}).
function reactionCount(val) {
  if (typeof val === "number") return val;
  if (val && typeof val === "object") return val.count || 0;
  return 0;
}

// Compact reaction summary, e.g. " [reactions: 👍×2 ❤️×1]". Empty string
// when the message has no reactions. Signals group agreement / emphasis so
// the LLM doesn't read a reaction as the author's own words.
function formatReactions(reactions) {
  if (!reactions || typeof reactions !== "object") return "";
  const parts = [];
  for (const [name, val] of Object.entries(reactions)) {
    const n = reactionCount(val);
    if (n > 0) parts.push(`${reactionEmojiFor(name)}×${n}`);
  }
  return parts.length ? ` [reactions: ${parts.join(" ")}]` : "";
}

// One-line, length-capped snippet of a quoted/parent body. Slices by code
// point (not UTF-16 unit) so a cap landing mid-emoji can't leave a broken
// surrogate half — these chats are emoji-heavy.
function snippet(body, max = 120) {
  const s = (body || "").replace(/[ \t]*\n+[ \t]*/g, " ").trim();
  if (s.length <= max) return s;
  return [...s].slice(0, max).join("") + "…";
}

// What is this comment replying to? Prefer the inline quote (carries the
// snippet directly); else resolve parent_id/quote_id against the slice's
// id→comment map. Returns { who, text } or null. THIS is the signal that
// stops the LLM from wiring a reply to the speaker's own earlier topic.
function resolveReplyTarget(c, byId) {
  const q = c.quote;
  if (q && (q.body || q.author)) {
    return { who: authorName(q.author) || "someone", text: snippet(q.body) };
  }
  const pid = c.parent_id != null ? c.parent_id : c.quote_id;
  if (pid != null && byId) {
    const parent = byId.get(pid);
    if (parent) {
      return {
        who: authorName(parent.author) || "someone",
        text: snippet(parent.body),
      };
    }
  }
  return null;
}

// Turn one comment into a single line:
//   "[time] Author (replying to X: "snippet"): body [reactions: …]"
// The (replying to …) clause and the [reactions: …] tail only appear when
// the data is present, so plain messages stay "[time] Author: body".
function formatLine(c, showDate, byId) {
  const ts = formatTimestamp(c.created_at, { showDate });
  const author = authorName(c.author) || "Unknown";
  // Collapse newlines + surrounding ASCII horizontal whitespace so each
  // comment renders as one line. Intentionally NOT \s — that would
  // swallow non-breaking / ideographic spaces inside CJK / multilingual
  // bodies, which would corrupt the user's text in the LLM context.
  const body = (c.body || "").replace(/[ \t]*\n+[ \t]*/g, " · ").trim();
  const reply = resolveReplyTarget(c, byId);
  const replyPrefix = reply
    ? reply.text
      ? ` (replying to ${reply.who}: "${reply.text}")`
      : ` (replying to ${reply.who})`
    : "";
  return `[${ts}] ${author}${replyPrefix}: ${body}${formatReactions(c.reactions)}`;
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
  // id → comment map so a threaded reply (parent_id/quote_id) can name the
  // message it answers even when no quote body was attached inline.
  const byId = new Map(comments.map((c) => [c.id, c]));
  const lines = comments.map((c) => formatLine(c, showDate, byId));
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

How to read the transcript:
- Each line is one message: [time] Author: text. Messages are in time order and different people interleave.
- A line marked (replying to X: "…") is a direct response to that quoted message. Attribute its claims to the subject/ticker of the quoted message, NOT to the speaker's own earlier messages.
- Do not assume a message continues the same author's previous topic when someone else has spoken in between, or when it is a reply.
- Attribute a trade, thesis, entry, or exit to a ticker only when that ticker is named in the message itself or in the message it is replying to. Never carry a ticker over from an earlier, unrelated message.
- [reactions: …] shows how others reacted to a message — a signal of agreement or emphasis, not the author's own words.

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

// ---------------------------------------------------------------------------
// ASK MODE — free-form Q&A grounded in the chat (and optionally the web).
//
// The system prompt drives a 3-section response: what was said in the chat,
// what came from the web (if web search was used), and the model's synthesis.
// Commit 6 will parse + render these as labeled sections; for now the model
// produces them as markdown headings.
//
// opts.lensHint: overrides the trading-flavored default lens hint.
// opts.webSearchEnabled: when true, instruct the model that it has web
// access; when false, instruct it to stay strictly within the chat.

export const ASK_FORMAT_INSTRUCTIONS = `Format your answer with these sections (omit any with nothing real to say):

**From the chat** — what was actually said in the chat, with attribution (who said it). Use direct short quotes when load-bearing.
**From the web** — facts or context you pulled in from outside the chat. Only include this section if web search was used.
**Synthesis** — your combined answer, weaving the chat and the web together to address the user's question directly.

Keep your answer focused on the user's question. If the chat doesn't contain enough to answer, say so explicitly — don't fabricate.`;

export function buildAskSystemPrompt(contextString, opts = {}) {
  const lensHint =
    typeof opts.lensHint === "string" && opts.lensHint.trim()
      ? opts.lensHint.trim()
      : DEFAULT_LENS_HINT;
  const webMode = opts.webSearchEnabled
    ? "You have access to a web_search tool. Use it ONLY when the chat alone cannot answer the user's question (e.g. they ask for current price, a definition, a news event the chat references but doesn't explain). When you DO use web search, cite the source URLs inside the **From the web** section. If the chat answers the question completely, do not invoke web search — extra calls cost the user money."
    : "You do NOT have access to web search in this conversation. Answer strictly from the chat content. If the chat doesn't contain enough to answer, say so — do NOT invent facts from your training data.";
  return `You are a research assistant helping the user understand a private group chat. ${lensHint}

You will be given two things:
1. The chat transcript (CHAT CONTEXT below) — what people in the chat actually said.
2. The user's question — what they want to know.

Answer the user's question grounded in the chat content first. ${webMode}

How to read the transcript:
- Each line is one message: [time] Author: text. Messages are in time order and different people interleave.
- A line marked (replying to X: "…") is a direct response to that quoted message. Attribute its claims to the subject/ticker of the quoted message, NOT to the speaker's own earlier messages.
- Attribute a trade, thesis, entry, or exit to a ticker only when that ticker is named in the message itself or in the message it is replying to.
- [reactions: …] shows how others reacted — a signal of agreement or emphasis, not the author's own words.

${ASK_FORMAT_INSTRUCTIONS}

CHAT CONTEXT (oldest → newest):
---
${contextString}
---`;
}

// User-side prompt for Ask mode. The user's raw question is the entire
// content — no decoration. We trim to avoid the model mistaking trailing
// whitespace for a continuation cue.
export function buildAskUserMessage(question) {
  return (question || "").trim();
}

// ---------------------------------------------------------------------------
// EXPLAIN MODE — one-click "✦ Explain" on a single message. Walks the
// message's reply/quote ancestors so the model reads the thread it sits in,
// then asks for a tight, X/Grok-style inline explanation (with web search).
//
// These are PURE functions: no DOM/state/fetch. The caller owns the store
// and passes in a (id) -> comment accessor.

// Hard cap on how far up the reply/quote chain we walk. A dozen ancestors
// is plenty of context for "explain THIS message"; deeper than that and the
// context is the whole conversation, not the thread, so the explanation
// drifts from the target. Also a belt-and-suspenders bound against a
// pathological chain even with the cycle guard below.
export const EXPLAIN_MAX_ANCESTORS = 12;

// Walk a message's parent_id / quote_id chain upward and return the thread
// as an ordered array [oldest ancestor, …, target]. The target is ALWAYS
// the last element so the caller can mark "the message to explain" without
// re-finding it.
//
//   targetId:   id of the clicked message
//   getComment: (id) => comment | undefined  (live store accessor)
//   opts.maxAncestors: override the EXPLAIN_MAX_ANCESTORS cap
//
// Both edges (parent_id AND quote_id) are followed, preferring parent_id
// when both are present (parent_id is the threaded-reply edge; quote_id is
// the quote-reply edge — a message rarely has both, but if it does the
// threaded parent is the more direct ancestor). Cycle-safe via a visited
// Set, mirroring commentMatchesFocus in lib/focus.js. Returns [] if the
// target id resolves to nothing.
export function collectThreadForExplain(targetId, getComment, opts = {}) {
  const maxAncestors =
    typeof opts.maxAncestors === "number" && opts.maxAncestors >= 0
      ? opts.maxAncestors
      : EXPLAIN_MAX_ANCESTORS;
  const get = typeof getComment === "function" ? getComment : () => undefined;
  const target = get(targetId);
  if (!target) return [];

  const ancestors = [];
  const visited = new Set([targetId]);
  let current = target;
  while (ancestors.length < maxAncestors) {
    const pid = current.parent_id != null && current.parent_id !== ""
      ? current.parent_id
      : (current.quote_id != null && current.quote_id !== "" ? current.quote_id : null);
    if (pid == null) break;
    if (visited.has(pid)) break; // cycle — stop
    const parent = get(pid);
    if (!parent) break; // ancestor not in store (truncated / not loaded)
    visited.add(pid);
    ancestors.push(parent);
    current = parent;
  }
  // ancestors are nearest-first; reverse to oldest-first, then append target.
  ancestors.reverse();
  ancestors.push(target);
  return ancestors;
}

// Reply-target key for a comment: what message it's answering. Prefers the
// inline quote's id (the quoted-reply edge carries it directly), then the
// threaded-reply parent_id, then quote_id. Null when the message replies to
// nothing. The `q:` / `p:` prefixes keep an inline-quote id from colliding
// with a parent/quote_id pointer that happens to share the same numeric value
// (parent_id and quote_id both denote a parent pointer, so they share `p:`).
function explainReplyKey(c) {
  if (!c) return null;
  if (c.quote && c.quote.id != null && c.quote.id !== "") return `q:${c.quote.id}`;
  if (c.parent_id != null && c.parent_id !== "") return `p:${c.parent_id}`;
  if (c.quote_id != null && c.quote_id !== "") return `p:${c.quote_id}`;
  return null;
}

// Split one author-run (the items of a single .msg-group, already consecutive
// same-author + within the time-gap window) into LOGICAL sub-groups for the
// ✦ Explain affordance. A Substack user often types one thought as several
// back-to-back messages — those are one logical group and get ONE Explain
// button. But when the user replies to a DIFFERENT message mid-run, that
// starts a new logical group (and a new button).
//
// Rule: a new sub-group begins at the first item, and at any item whose
// reply target is non-null AND differs from the current sub-group's anchor.
// A message that replies to nothing (a plain continuation) stays in the
// current group; a message replying to the SAME target as the anchor also
// stays (consecutive replies to one person are one thought). This is a
// heuristic — not perfect, but it matches how the feed reads.
//
// Returns: [{ headId, items: [comment, …] }, …] in order. Each input item
// belongs to exactly one sub-group; the first item of each is its head.
export function segmentExplainGroups(items) {
  const groups = [];
  if (!Array.isArray(items)) return groups;
  let cur = null;
  let anchorKey = null;
  for (const c of items) {
    if (!c) continue;
    const rk = explainReplyKey(c);
    const startNew = cur === null || (rk !== null && rk !== anchorKey);
    if (startNew) {
      cur = { headId: c.id, items: [c] };
      groups.push(cur);
      anchorKey = rk; // null for a plain head, or the reply target it anchors on
    } else {
      cur.items.push(c);
    }
  }
  return groups;
}

// System prompt for Explain mode. The thread (ancestors + the target
// message) is in CHAT CONTEXT; the user-side message names which line is
// the one to explain. Output is deliberately short and scannable —
// X/Grok "explain this post" style — NOT the 3-section Ask format.
//
// opts.lensHint: overrides the trading-flavored default lens hint.
// opts.webSearchEnabled: when true, tell the model it may search the web to
// decode tickers/jargon/links/current events the chat references but does
// not explain; when false, tell it to stay strictly within the thread. This
// MUST track the actual web_search tool attachment on the request exactly —
// advertising the tool in prose while not attaching it (or vice versa) makes
// Anthropic reject the call.
export function buildExplainSystemPrompt(contextString, opts = {}) {
  const lensHint =
    typeof opts.lensHint === "string" && opts.lensHint.trim()
      ? opts.lensHint.trim()
      : DEFAULT_LENS_HINT;
  const webMode = opts.webSearchEnabled
    ? "You have access to a web_search tool. Use it ONLY when the message references something the thread doesn't explain — a ticker, an acronym, a person, a product, a news event, or a link whose content matters. Keep searches minimal; a couple is plenty. When a fact comes from the web, you may cite the source."
    : "You do NOT have access to web search. Explain using the thread below plus your general knowledge of markets and current events. When a person, deal, or event isn't named, infer the most likely real-world referent and label your confidence rather than refusing — but do not fabricate specific facts, numbers, or quotes you are unsure of.";
  const imageMode = opts.hasImages
    ? " One or more image attachments from the thread (e.g. charts, screenshots) are attached below in this message — read them and factor what they show into your explanation."
    : "";
  return `You are a seasoned professional trader explaining a SINGLE message from a private group chat to a reader who is catching up. Voice: sharp, plain-spoken desk-trader — no hedging filler, no "as an AI", no disclaimers. You're fluent in market structure, technical analysis, options flow, AND the macro / political / geopolitical backdrop traders actually track — elections, policy, central banks, wars, trade and peace deals, and the people driving them. You decode jargon AND work out who or what a message is about instead of hiding behind it. Always separate what's actually being claimed from your read of it, and never bury the risk. ${lensHint}

The CHAT CONTEXT below is the reply thread the message sits in (oldest → newest); the LAST line is usually the message you are asked to explain, but the user's message will name the exact target. ${webMode}${imageMode}

How to read the transcript:
- Each line is one message: [time] Author: text. A line marked (replying to X: "…") answers that quoted message — use it to ground what the target is responding to.
- Decode jargon, tickers ($XXXX), acronyms, and shorthand in plain language.
- Identify the real-world referent. Messages often name no one — an unnamed "he" / "she" / "they", "this deal", "the decision". Use the thread PLUS your knowledge of current events to infer the most likely person, company, deal, or event, NAME it, and label confidence (e.g. "almost certainly Trump", "likely the Fed", "unclear, best guess: …"). A trader following the news would know — don't abstract it to "someone".
- Not everything is a tradeable security. Plenty of messages are about politics, geopolitics, macro, or a specific person — not a stock. Explain the ACTUAL subject. Draw a market or trading implication ONLY when the message genuinely supports one; never invent a "public company", "underlying asset", or "stock price" angle that isn't there.
- Explain what the target message actually means, what it's responding to, and why it matters in this thread. If it makes a claim, trade call, or prediction, state it plainly and flag any caveat or uncertainty.
- Do NOT summarize the whole chat. Stay focused on the one target message.

Format: open with ONE short sentence of plain-language gist, then 2-4 tight bullets. No preamble, no "Here's an explanation". Be concrete and brief — this renders inline under the message.

CHAT CONTEXT (oldest → newest):
---
${contextString}
---`;
}

// User-side message for Explain mode. Names the exact target line (author +
// a snippet of its body) so the model can't mistake an ancestor for the
// thing to explain. The body snippet is length-capped via the same snippet()
// helper used elsewhere so a pasted wall of text can't blow up the prompt.
// opts.links: optional array of URLs referenced in the target (and its
// thread). They're surfaced explicitly so the model reads them via web
// search rather than glossing over a bare URL in the body text. Capped +
// deduped by the caller.
// opts.continuations: optional array of follow-up message bodies from the
// SAME author that are part of this logical group (the user typed one thought
// as several back-to-back messages). They're presented as "(cont'd)" lines so
// the model explains the whole group, not just the first line.
export function buildExplainUserMessage(targetComment, opts = {}) {
  const c = targetComment || {};
  const who = authorName(c.author) || "Unknown";
  const body = snippet(c.body, 400);
  const conts = Array.isArray(opts.continuations)
    ? opts.continuations
        .filter((b) => typeof b === "string" && b.trim())
        .map((b) => `\n${who} (cont'd): "${snippet(b, 400)}"`)
        .join("")
    : "";
  const target = conts
    ? `${who} posted this as a sequence of messages (one logical thought):\n\n${who}: "${body}"${conts}`
    : `${who}: "${body}"`;
  const links = Array.isArray(opts.links)
    ? opts.links.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
    : [];
  const linkBlock = links.length
    ? `\n\nLinks referenced — read them with web search if they're relevant to the explanation:\n${links.map((u) => `- ${u}`).join("\n")}`
    : "";
  return `Explain this specific message from the thread above:\n\n${target}\n\nWhat does it mean and why does it matter here?${linkBlock}`;
}

// Effectively-unbounded char budget for Ask mode. We don't want to drop
// older messages just to fit a budget the user didn't set; instead we let
// formatMessagesForLLM truncate ONLY when the chat itself exceeds the
// provider's context window. 750k chars ≈ 187k tokens; fits Anthropic
// 200K with ~13K headroom for the system prompt + response. OpenAI
// gpt-4o-mini's 128K window may still need truncation on very long chats
// — formatMessagesForLLM's oldest-first truncation handles that.
export const ASK_DEFAULT_BUDGET_CHARS = 750_000;

// Parse a model's Ask-mode response into the 3 sections we asked for.
// The system prompt instructs the model to use **From the chat**,
// **From the web**, and **Synthesis** as bold headers. We split on
// those markers, tolerant of: missing sections (model omits one
// because it has nothing to say), extra whitespace, alternate
// punctuation (the model sometimes adds a colon or em-dash). Anything
// BEFORE the first recognized header is treated as a preamble and
// returned as such — usually empty, but the model occasionally opens
// with a one-sentence framing.
//
// Returns: { preamble, fromChat, fromWeb, synthesis }
// Each string is the raw markdown for that section's body (NOT the
// header itself). Empty string means the section was absent.
export function parseAskSections(text) {
  const out = { preamble: "", fromChat: "", fromWeb: "", synthesis: "" };
  if (!text || typeof text !== "string") return out;

  // Match **From the chat** / **From the web** / **Synthesis** (case-
  // insensitive, optional trailing colon or em-dash on the same line as
  // the header). We DON'T match a plain hyphen here — bullets often
  // open with "- " and a hyphen-as-separator would swallow the leading
  // dash of the very first bullet under the section.
  const headerRe = /\*\*(from the chat|from the web|synthesis)\*\*[ \t]*[:—]?[ \t]*\n?/gi;
  const matches = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    matches.push({
      kind: m[1].toLowerCase(),
      headerStart: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  if (!matches.length) {
    // Whole response is preamble (model ignored the format). Caller
    // falls back to rendering as a single block.
    out.preamble = text.trim();
    return out;
  }
  // Preamble = everything before the first header.
  if (matches[0].headerStart > 0) {
    out.preamble = text.slice(0, matches[0].headerStart).trim();
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].bodyStart;
    const end = i + 1 < matches.length ? matches[i + 1].headerStart : text.length;
    const body = text.slice(start, end).trim();
    if (matches[i].kind === "from the chat") out.fromChat = body;
    else if (matches[i].kind === "from the web") out.fromWeb = body;
    else if (matches[i].kind === "synthesis") out.synthesis = body;
  }
  return out;
}
