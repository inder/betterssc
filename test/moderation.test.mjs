// AI moderation review — prompt/parser tests.
//
// No live model outputs were captured (no network access here — this
// environment can't call real provider APIs) so this fixture set is
// hand-authored, not empirically sampled, per the project's usual
// "capture 3+ real replies" convention (see CLAUDE.md's Empirical
// sampling rule). To partially compensate, coverage below is organized
// by DISTINCT semantic failure MODE (missing fence, wrong type, invalid
// JSON syntax, mode-dependent field requirements, etc.) rather than
// variations on one mode, per the "adversarial near-positives must cover
// distinct failure modes" promoted lesson.

import { describe, it, expect } from "vitest";
import {
  buildModerationSystemPrompt,
  parseModerationResponse,
  MODERATION_USER_MESSAGE,
} from "../lib/moderation.js";

const validFull = JSON.stringify({
  offensive: false,
  needs_reword: true,
  reworded: "I disagree with that take, here's why.",
  political_reply: false,
  reasoning: "Blunt phrasing, softened for a public forum.",
});

describe("buildModerationSystemPrompt", () => {
  it("embeds the draft text and chat context", () => {
    const prompt = buildModerationSystemPrompt("some chat history", {
      draftText: "this take is garbage",
    });
    expect(prompt).toContain("this take is garbage");
    expect(prompt).toContain("some chat history");
  });

  it("includes REPLY CONTEXT only when replyingTo is set", () => {
    const withReply = buildModerationSystemPrompt("ctx", {
      draftText: "no it isn't",
      replyingTo: { authorName: "Alex", body: "the election was rigged" },
    });
    expect(withReply).toContain("REPLY CONTEXT");
    expect(withReply).toContain("Alex");
    expect(withReply).toContain("the election was rigged");

    const noReply = buildModerationSystemPrompt("ctx", { draftText: "hi" });
    // "REPLY CONTEXT" appears in the fixed instructional prose either way
    // (dimension 3 explains the field) — check for the actual injected
    // reply BLOCK specifically, not just the phrase.
    expect(noReply).not.toContain("REPLY CONTEXT —");
  });

  it("instructs a narrow bar for offensive and needs_reword as the default tone verdict", () => {
    const prompt = buildModerationSystemPrompt("ctx", { draftText: "x" });
    expect(prompt).toMatch(/narrow/i);
    expect(prompt).toMatch(/default verdict/i);
  });

  it("always requests the fenced JSON block format", () => {
    const prompt = buildModerationSystemPrompt("ctx", { draftText: "x" });
    expect(prompt).toContain("```json");
    expect(prompt).toContain("offensive");
    expect(prompt).toContain("needs_reword");
    expect(prompt).toContain("political_reply");
  });

  // Live dogfooding caught the model turning "Elon is pumping SpaceX
  // stock" into "Elon is buying SpaceX stock" — a factually different
  // claim (hyping/promoting vs. an actual purchase), not just a tone
  // change. A prompt-text assertion can't verify live model compliance,
  // but it does guarantee the guardrail can't be silently deleted by a
  // future edit without a test noticing.
  it("explicitly forbids changing the underlying claim when rewording, with the pumping/buying failure as a named example", () => {
    const prompt = buildModerationSystemPrompt("ctx", { draftText: "x" });
    expect(prompt).toMatch(/only tone and word choice, never the underlying claim/i);
    expect(prompt).toContain("pumping SpaceX stock");
    expect(prompt).toContain("buying SpaceX stock");
    expect(prompt).toMatch(/prefer needs_reword: false over inventing a different claim/i);
  });
});

describe("MODERATION_USER_MESSAGE", () => {
  it("is a non-empty instruction string", () => {
    expect(typeof MODERATION_USER_MESSAGE).toBe("string");
    expect(MODERATION_USER_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("parseModerationResponse — happy paths", () => {
  it("parses a fenced ```json block", () => {
    const r = parseModerationResponse("```json\n" + validFull + "\n```");
    expect(r.ok).toBe(true);
    expect(r.result.needsReword).toBe(true);
    expect(r.result.reworded).toBe("I disagree with that take, here's why.");
    expect(r.result.offensive).toBe(false);
    expect(r.result.politicalReply).toBe(false);
  });

  it("parses a bare ``` fence with no language tag", () => {
    const r = parseModerationResponse("```\n" + validFull + "\n```");
    expect(r.ok).toBe(true);
  });

  it("parses a fence surrounded by extra prose (preamble/epilogue)", () => {
    const r = parseModerationResponse(
      "Sure, here's my review:\n```json\n" + validFull + "\n```\nLet me know if you need anything else!"
    );
    expect(r.ok).toBe(true);
    expect(r.result.reworded).toBe("I disagree with that take, here's why.");
  });

  it("falls back to parsing the whole trimmed text as JSON when there's no fence at all", () => {
    const r = parseModerationResponse(validFull);
    expect(r.ok).toBe(true);
  });

  it("needs_reword:false with an empty reworded string is valid", () => {
    const clean = JSON.stringify({
      offensive: false,
      needs_reword: false,
      reworded: "",
      political_reply: false,
      reasoning: "Reads fine as-is, no changes needed.",
    });
    const r = parseModerationResponse(clean);
    expect(r.ok).toBe(true);
    expect(r.result.needsReword).toBe(false);
    expect(r.result.reworded).toBe("");
  });

  it("offensive:true is valid on its own, independent of needs_reword", () => {
    const offensive = JSON.stringify({
      offensive: true,
      needs_reword: false,
      reworded: "",
      political_reply: false,
      reasoning: "Contains a slur.",
    });
    const r = parseModerationResponse(offensive);
    expect(r.ok).toBe(true);
    expect(r.result.offensive).toBe(true);
  });

  it("political_reply:true is valid", () => {
    const political = JSON.stringify({
      offensive: false,
      needs_reword: false,
      reworded: "",
      political_reply: true,
      reasoning: "The parent message is about the election.",
    });
    const r = parseModerationResponse(political);
    expect(r.ok).toBe(true);
    expect(r.result.politicalReply).toBe(true);
  });

  it("terminates at the first closing fence, not swallowed by a later ``` in trailing prose", () => {
    const r = parseModerationResponse(
      "```json\n" + validFull + "\n```\nBy the way, use `backticks` for code."
    );
    expect(r.ok).toBe(true);
  });
});

describe("parseModerationResponse — full mode requires a valid reword when needed", () => {
  it("FAILS when needs_reword is true but reworded is missing entirely", () => {
    const bad = JSON.stringify({
      offensive: false,
      needs_reword: true,
      political_reply: false,
      reasoning: "Needs work.",
    });
    const r = parseModerationResponse(bad, "full");
    expect(r.ok).toBe(false);
  });

  it("FAILS when needs_reword is true but reworded is an empty string", () => {
    const bad = JSON.stringify({
      offensive: false,
      needs_reword: true,
      reworded: "",
      political_reply: false,
      reasoning: "Needs work.",
    });
    const r = parseModerationResponse(bad, "full");
    expect(r.ok).toBe(false);
  });
});

describe("parseModerationResponse — block-only mode ignores needs_reword/reworded", () => {
  const blockOnlyRelevant = JSON.stringify({
    offensive: false,
    political_reply: true,
    reasoning: "Replying to a political message.",
    // needs_reword/reworded intentionally omitted — an attachment-only
    // reply has no text to reword, so block-only must not require them.
  });

  it("succeeds without needs_reword/reworded present at all", () => {
    const r = parseModerationResponse(blockOnlyRelevant, "block-only");
    expect(r.ok).toBe(true);
    expect(r.result.politicalReply).toBe(true);
    expect(r.result.needsReword).toBe(false);
    expect(r.result.reworded).toBe("");
  });

  it("succeeds even when needs_reword:true has an empty reworded (would fail in full mode)", () => {
    const wouldFailFull = JSON.stringify({
      offensive: false,
      needs_reword: true,
      reworded: "",
      political_reply: false,
      reasoning: "x",
    });
    expect(parseModerationResponse(wouldFailFull, "full").ok).toBe(false);
    expect(parseModerationResponse(wouldFailFull, "block-only").ok).toBe(true);
  });
});

describe("parseModerationResponse — distinct failure modes", () => {
  it("empty response string", () => {
    expect(parseModerationResponse("").ok).toBe(false);
    expect(parseModerationResponse("   ").ok).toBe(false);
  });

  it("non-string input", () => {
    expect(parseModerationResponse(null).ok).toBe(false);
    expect(parseModerationResponse(undefined).ok).toBe(false);
  });

  it("the model ignored instructions and returned plain prose, no JSON at all", () => {
    const r = parseModerationResponse(
      "This message seems fine to me, no changes needed!"
    );
    expect(r.ok).toBe(false);
  });

  it("unterminated fence (opening ``` with no closing ```)", () => {
    const r = parseModerationResponse("```json\n" + validFull);
    expect(r.ok).toBe(false);
  });

  it("single-quoted JSON (invalid per strict JSON.parse)", () => {
    const bad = "{'offensive': false, 'needs_reword': false, 'reworded': '', 'political_reply': false, 'reasoning': 'x'}";
    expect(parseModerationResponse(bad).ok).toBe(false);
  });

  it("trailing comma (invalid per strict JSON.parse)", () => {
    const bad = '{"offensive": false, "needs_reword": false, "reworded": "", "political_reply": false, "reasoning": "x",}';
    expect(parseModerationResponse(bad).ok).toBe(false);
  });

  it("missing a required key (reasoning)", () => {
    const bad = JSON.stringify({
      offensive: false,
      needs_reword: false,
      reworded: "",
      political_reply: false,
    });
    expect(parseModerationResponse(bad).ok).toBe(false);
  });

  it("wrong type — offensive as a string instead of a boolean", () => {
    const bad = JSON.stringify({
      offensive: "false",
      needs_reword: false,
      reworded: "",
      political_reply: false,
      reasoning: "x",
    });
    expect(parseModerationResponse(bad).ok).toBe(false);
  });

  it("wrong type — political_reply as a string instead of a boolean", () => {
    const bad = JSON.stringify({
      offensive: false,
      needs_reword: false,
      reworded: "",
      political_reply: "true",
      reasoning: "x",
    });
    expect(parseModerationResponse(bad).ok).toBe(false);
  });

  it("the fenced content is a JSON array, not an object", () => {
    const r = parseModerationResponse("```json\n[false, false, \"\", false, \"x\"]\n```");
    expect(r.ok).toBe(false);
  });

  it("reasoning present but blank/whitespace-only", () => {
    const bad = JSON.stringify({
      offensive: false,
      needs_reword: false,
      reworded: "",
      political_reply: false,
      reasoning: "   ",
    });
    expect(parseModerationResponse(bad).ok).toBe(false);
  });
});
