import { describe, it, expect } from "vitest";
import {
  parseSubstackChatUrl,
  buildSubstackChatUrl,
  isChannelId,
} from "../lib/chat-url.js";
import { pickLiveliestPost, formatThreadRailRows } from "../lib/util.js";

// Vite resolves JSON imports, so the committed capture loads as a module —
// no fs/import.meta.url dance that behaves differently under the test runner.
import CAPTURE from "./fixtures/channel-posts-page1.json";

const CH = "aeb6bcb1-60c2-4531-be48-1a08b43d6416";
const POST = "d5ecab54-8114-4613-9f04-5a7c77fc8365";

describe("parseSubstackChatUrl — post-migration channel URLs", () => {
  it("parses /chat/group/<channelId>/post/<postUuid>", () => {
    expect(
      parseSubstackChatUrl(`https://substack.com/chat/group/${CH}/post/${POST}`)
    ).toEqual({
      publicationId: null,
      postUuid: POST,
      channelId: CH,
      targetReplyId: null,
    });
  });

  it("parses a bare /chat/group/<channelId> — no post is normal, not a failure", () => {
    expect(parseSubstackChatUrl(`https://substack.com/chat/group/${CH}`)).toEqual({
      publicationId: null,
      postUuid: null,
      channelId: CH,
      targetReplyId: null,
    });
  });

  it("keeps targetReplyId for deep links", () => {
    const parsed = parseSubstackChatUrl(
      `https://substack.com/chat/group/${CH}/post/${POST}?targetReplyId=99`
    );
    expect(parsed.targetReplyId).toBe("99");
  });

  it("tolerates a trailing slash", () => {
    expect(parseSubstackChatUrl(`https://substack.com/chat/group/${CH}/`).channelId).toBe(CH);
  });
});

describe("parseSubstackChatUrl — legacy URLs still parse", () => {
  it("parses /chat/<pubId>/post/<postUuid>", () => {
    expect(
      parseSubstackChatUrl(`https://substack.com/chat/6459287/post/${POST}`)
    ).toEqual({
      publicationId: "6459287",
      postUuid: POST,
      channelId: null,
      targetReplyId: null,
    });
  });

  it("parses a publication subdomain", () => {
    expect(
      parseSubstackChatUrl("https://bestpub.substack.com/chat/6459287").publicationId
    ).toBe("6459287");
  });
});

describe("parseSubstackChatUrl — rejects", () => {
  // The parser runs on the URL of whatever tab the toolbar button was clicked
  // from, and its output feeds API paths. Host confusion here would let an
  // arbitrary page steer our requests, so these are adversarial, not cosmetic.
  it.each([
    ["a lookalike suffix host", `https://notsubstack.com/chat/group/${CH}`],
    ["a substack.com-prefixed attacker domain", `https://substack.com.evil.io/chat/group/${CH}`],
    ["an unrelated host", `https://evil.com/chat/group/${CH}`],
    ["plain http", `http://substack.com/chat/group/${CH}`],
    ["the chat index with no target", "https://substack.com/chat"],
    ["a non-chat substack page", "https://substack.com/home"],
    ["a non-uuid group segment", "https://substack.com/chat/group/12345"],
    ["extra path after the post", `https://substack.com/chat/group/${CH}/post/${POST}/edit`],
    ["garbage", "not a url"],
    ["nothing", null],
  ])("rejects %s", (_label, url) => {
    expect(parseSubstackChatUrl(url)).toBeNull();
  });
});

describe("buildSubstackChatUrl", () => {
  it("prefers the channel form when a channel id is known", () => {
    expect(buildSubstackChatUrl({ channelId: CH, publicationId: "6459287", postUuid: POST })).toBe(
      `https://substack.com/chat/group/${CH}/post/${POST}`
    );
  });

  it("falls back to the legacy form when only a publication is known", () => {
    expect(buildSubstackChatUrl({ publicationId: "6459287", postUuid: POST })).toBe(
      `https://substack.com/chat/6459287/post/${POST}`
    );
  });

  it("degrades to the chat index rather than emitting an undefined path", () => {
    expect(buildSubstackChatUrl({})).toBe("https://substack.com/chat");
    expect(buildSubstackChatUrl()).toBe("https://substack.com/chat");
  });

  it("appends Substack's own comment-permalink params when a targetReplyId is given (live-verified 2026-09-18)", () => {
    expect(buildSubstackChatUrl({ channelId: CH, postUuid: POST, targetReplyId: "7d8c61a6-9323-4d88-a298-8c082f211250" })).toBe(
      `https://substack.com/chat/group/${CH}/post/${POST}?target_reply_id=7d8c61a6-9323-4d88-a298-8c082f211250&showTarget=true`
    );
    expect(buildSubstackChatUrl({ publicationId: "6459287", postUuid: POST, targetReplyId: "x y" })).toBe(
      `https://substack.com/chat/6459287/post/${POST}?target_reply_id=x%20y&showTarget=true`
    );
    // No post → no anchor (a comment id is meaningless without its thread).
    expect(buildSubstackChatUrl({ channelId: CH, targetReplyId: "abc" })).toBe(`https://substack.com/chat/group/${CH}`);
  });

  it("parses target_reply_id (Substack's spelling) as well as the legacy camelCase", () => {
    const native = parseSubstackChatUrl(`https://substack.com/chat/group/${CH}/post/${POST}?target_reply_id=abc&showTarget=true`);
    expect(native && native.targetReplyId).toBe("abc");
    const camel = parseSubstackChatUrl(`https://substack.com/chat/group/${CH}/post/${POST}?targetReplyId=def`);
    expect(camel && camel.targetReplyId).toBe("def");
  });

  it("round-trips a parsed channel URL", () => {
    const url = `https://substack.com/chat/group/${CH}/post/${POST}`;
    expect(buildSubstackChatUrl(parseSubstackChatUrl(url))).toBe(url);
  });
});

describe("pickLiveliestPost", () => {
  const thread = (id, fields) => ({ communityPost: { id, ...fields } });

  it("picks the newest REPLY, not the newest post", () => {
    // Shape captured live from a real channel: today's link post has zero
    // replies while the conversation lives in an older thread. Choosing by
    // created_at would open the empty one.
    const threads = [
      thread("link-today", {
        created_at: "2026-09-06T12:31:53.206Z",
        most_recent_comment_created_at: null,
      }),
      thread("conversation", {
        created_at: "2026-09-04T10:46:50.115Z",
        most_recent_comment_created_at: "2026-09-06T13:52:43.579Z",
      }),
    ];
    expect(pickLiveliestPost(threads).id).toBe("conversation");
  });

  it("falls back to max_comment_created_at, then created_at", () => {
    expect(
      pickLiveliestPost([
        thread("a", { created_at: "2026-09-01T00:00:00.000Z" }),
        thread("b", { created_at: "2026-08-01T00:00:00.000Z", max_comment_created_at: "2026-09-05T00:00:00.000Z" }),
      ]).id
    ).toBe("b");
  });

  it("returns null for an empty or absent feed", () => {
    expect(pickLiveliestPost([])).toBeNull();
    expect(pickLiveliestPost(null)).toBeNull();
    expect(pickLiveliestPost(undefined)).toBeNull();
  });

  it("skips malformed entries but still returns a usable post", () => {
    const threads = [
      null,
      {},
      { communityPost: null },
      { communityPost: { created_at: "2026-09-09T00:00:00.000Z" } }, // no id
      thread("real", { created_at: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(pickLiveliestPost(threads).id).toBe("real");
  });

  it("still returns a post when every timestamp is unparseable", () => {
    const threads = [thread("only", { created_at: "not-a-date" })];
    expect(pickLiveliestPost(threads).id).toBe("only");
  });
});

describe("pickLiveliestPost — against the committed live capture", () => {
  // Hand-built fixtures pin the RANKING but cannot pin the FIELD NAMES: if
  // Substack renames or drops the reply timestamps, the picker's `||` chain
  // silently degrades to created_at, selects the newest zero-reply broadcast
  // post, and renders an empty stream — with every hand-built test still
  // green. That is this project's most expensive recurring failure shape
  // (see the v0.1 WebSocket chase). These assertions run against a redacted
  // real response so drift fails here instead of in the user's face.
  it("selects the thread Substack's own client had open", () => {
    expect(pickLiveliestPost(CAPTURE.threads).id).toBe(CAPTURE._expected_pick);
  });

  it("does NOT select the newest post, which is a zero-reply broadcast", () => {
    const newestByCreatedAt = [...CAPTURE.threads].sort(
      (a, b) =>
        Date.parse(b.communityPost.created_at) -
        Date.parse(a.communityPost.created_at)
    )[0].communityPost;
    expect(newestByCreatedAt.comment_count).toBe(0);
    expect(pickLiveliestPost(CAPTURE.threads).id).not.toBe(newestByCreatedAt.id);
  });

  it("the reply-timestamp fields the picker depends on are actually present", () => {
    // Fails loudly on a rename rather than degrading silently.
    for (const t of CAPTURE.threads) {
      expect(t.communityPost).toHaveProperty("most_recent_comment_created_at");
      expect(t.communityPost).toHaveProperty("max_comment_created_at");
      expect(t.communityPost).toHaveProperty("created_at");
    }
    expect(
      CAPTURE.threads.filter(
        (t) => t.communityPost.most_recent_comment_created_at
      ).length
    ).toBeGreaterThan(0);
  });

  it("the capture really is created_at-descending — the assumption behind reading only page 1", () => {
    const times = CAPTURE.threads.map((t) =>
      Date.parse(t.communityPost.created_at)
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("isChannelId", () => {
  // app.html is a web_accessible_resource on substack.com, so any page on that
  // origin can open it with a `chan` of its choosing, and the value lands in an
  // API path. Shape validation is the gate, not a formality.
  it("accepts a real channel uuid in either case", () => {
    expect(isChannelId(CH)).toBe(true);
    expect(isChannelId(CH.toUpperCase())).toBe(true);
  });

  it.each([
    ["a path-traversal attempt", "../../api/v1/admin"],
    ["a uuid with a trailing path segment", `${CH}/../evil`],
    ["a uuid with a query tacked on", `${CH}?x=1`],
    ["a bare number", "6459287"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a non-string", 12345],
  ])("rejects %s", (_label, v) => {
    expect(isChannelId(v)).toBe(false);
  });
});

describe("formatThreadRailRows", () => {
  const thread = (id, fields) => ({ communityPost: { id, ...fields } });

  it("orders rows liveliest-first, same as pickLiveliestPost", () => {
    const rows = formatThreadRailRows(CAPTURE.threads, null);
    expect(rows[0].id).toBe(CAPTURE._expected_pick);
    const times = rows.map((r) => r.activityAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("flags exactly the active row, and only it", () => {
    const rows = formatThreadRailRows(CAPTURE.threads, CAPTURE._expected_pick);
    const active = rows.filter((r) => r.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(CAPTURE._expected_pick);
  });

  it("flags no row active when activePostUuid matches none", () => {
    const rows = formatThreadRailRows(CAPTURE.threads, "not-a-real-id");
    expect(rows.some((r) => r.isActive)).toBe(false);
  });

  it("flags no row active when activePostUuid is null/undefined", () => {
    expect(formatThreadRailRows(CAPTURE.threads, null).some((r) => r.isActive)).toBe(false);
    expect(formatThreadRailRows(CAPTURE.threads).some((r) => r.isActive)).toBe(false);
  });

  it("truncates the snippet and collapses whitespace", () => {
    const long = "a".repeat(200);
    const rows = formatThreadRailRows([thread("x", { body: long, created_at: "2026-01-01T00:00:00.000Z" })], null);
    expect(rows[0].snippet.length).toBeLessThanOrEqual(80);
  });

  it("collapses internal whitespace/newlines in the snippet", () => {
    const rows = formatThreadRailRows(
      [thread("x", { body: "line one\n\n  line   two", created_at: "2026-01-01T00:00:00.000Z" })],
      null
    );
    expect(rows[0].snippet).toBe("line one line two");
  });

  it("falls back to a placeholder for a post with no body text", () => {
    const rows = formatThreadRailRows([thread("x", { created_at: "2026-01-01T00:00:00.000Z" })], null);
    expect(rows[0].snippet).toBe("(no text)");
  });

  it("strips raw HTML tags when body_html is the only text field present", () => {
    const rows = formatThreadRailRows(
      [thread("x", { body_html: "<p>Hello <b>world</b></p>", created_at: "2026-01-01T00:00:00.000Z" })],
      null
    );
    expect(rows[0].snippet).toBe("Hello world");
  });

  it("does NOT touch angle brackets in plain-text bodies (only body_html is stripped)", () => {
    const rows = formatThreadRailRows(
      [thread("x", { body: "I <3 this ticker <TSLA>", created_at: "2026-01-01T00:00:00.000Z" })],
      null
    );
    expect(rows[0].snippet).toBe("I <3 this ticker <TSLA>");
  });

  it("reads comment_count, defaulting to 0", () => {
    const rows = formatThreadRailRows(
      [
        thread("a", { created_at: "2026-01-01T00:00:00.000Z", comment_count: 42 }),
        thread("b", { created_at: "2026-01-02T00:00:00.000Z" }),
      ],
      null
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.commentCount]));
    expect(byId.a).toBe(42);
    expect(byId.b).toBe(0);
  });

  it("returns [] for an empty or absent feed — matches pickLiveliestPost's null", () => {
    expect(formatThreadRailRows([], null)).toEqual([]);
    expect(formatThreadRailRows(null, null)).toEqual([]);
    expect(formatThreadRailRows(undefined, null)).toEqual([]);
  });

  it("skips malformed entries, same shape as pickLiveliestPost", () => {
    const threads = [
      null,
      {},
      { communityPost: null },
      { communityPost: { created_at: "2026-09-09T00:00:00.000Z" } }, // no id
      thread("real", { created_at: "2026-09-01T00:00:00.000Z" }),
    ];
    const rows = formatThreadRailRows(threads, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("real");
  });

  describe("hideEmpty option", () => {
    const threads = [
      thread("live", { created_at: "2026-09-03T00:00:00.000Z", comment_count: 5 }),
      thread("empty-1", { created_at: "2026-09-02T00:00:00.000Z", comment_count: 0 }),
      thread("empty-2", { created_at: "2026-09-01T00:00:00.000Z" }), // comment_count absent -> 0
    ];

    it("defaults to false — unfiltered, same as calling with no options at all", () => {
      const withOptions = formatThreadRailRows(threads, null, {});
      const withoutOptions = formatThreadRailRows(threads, null);
      expect(withOptions).toEqual(withoutOptions);
      expect(withOptions).toHaveLength(3);
    });

    it("filters out 0-reply threads when true", () => {
      const rows = formatThreadRailRows(threads, null, { hideEmpty: true });
      expect(rows.map((r) => r.id)).toEqual(["live"]);
    });

    it("keeps the active thread even at 0 replies — never hides the thread you're looking at", () => {
      const rows = formatThreadRailRows(threads, "empty-1", { hideEmpty: true });
      expect(rows.map((r) => r.id).sort()).toEqual(["empty-1", "live"]);
    });

    it("keeps ordering (liveliest-first) after filtering", () => {
      const withReplies = [
        thread("newer-empty", { created_at: "2026-09-05T00:00:00.000Z", comment_count: 0 }),
        thread("older-live", {
          created_at: "2026-09-01T00:00:00.000Z",
          most_recent_comment_created_at: "2026-09-04T00:00:00.000Z",
          comment_count: 3,
        }),
        thread("newest-live", {
          created_at: "2026-09-06T00:00:00.000Z",
          most_recent_comment_created_at: "2026-09-06T00:00:00.000Z",
          comment_count: 1,
        }),
      ];
      const rows = formatThreadRailRows(withReplies, null, { hideEmpty: true });
      expect(rows.map((r) => r.id)).toEqual(["newest-live", "older-live"]);
    });

    it("against the real capture: hides the 6 zero-reply broadcasts, keeps the 5 live ones", () => {
      const rows = formatThreadRailRows(CAPTURE.threads, null, { hideEmpty: true });
      expect(rows.every((r) => r.commentCount > 0)).toBe(true);
      expect(rows).toHaveLength(
        CAPTURE.threads.filter((t) => t.communityPost.comment_count > 0).length
      );
    });

    it("legitimately returns [] when every thread is empty and none is active — the exact case renderThreadRail must fall back on", () => {
      // All-empty-page + an active id that isn't among them is exactly
      // "the open thread is paged out and page 1 is all broadcast links" —
      // the scenario that made renderThreadRail's hideEmpty branch capable
      // of rendering a visible rail with zero rows before that fallback was
      // added. This test locks in that the PURE function still returns []
      // here (it's the correct, unopinionated answer) — the empty-list
      // recovery is app.js's job, not this function's.
      const allEmpty = [
        thread("a", { created_at: "2026-01-01T00:00:00.000Z", comment_count: 0 }),
        thread("b", { created_at: "2026-01-02T00:00:00.000Z" }),
      ];
      expect(formatThreadRailRows(allEmpty, "not-on-this-page", { hideEmpty: true })).toEqual([]);
    });
  });
});
