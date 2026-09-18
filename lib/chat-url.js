// Substack chat URL parsing.
//
// PROTOCOL NOTE (2026-09-06 migration)
// -----------------------------------
// Substack moved publication chat from a per-publication post list to a
// persistent CHANNEL model. Captured live on 2026-09-06:
//
//   old  https://substack.com/chat/<pubId>
//   old  https://substack.com/chat/<pubId>/post/<postUuid>
//   new  https://substack.com/chat/group/<channelUuid>
//   new  https://substack.com/chat/group/<channelUuid>/post/<postUuid>
//
// Substack 301-redirects both old forms to their new equivalents, so a tab
// the user left open on an old URL is now on a `/chat/group/...` URL. The
// old parser only matched `/chat/<digits>`, so after the migration EVERY
// chat tab looked unparseable and the toolbar button opened the app with no
// publication and no post — the "BetterSSC stopped working" symptom.
//
// The new form carries a channel uuid, NOT a publication id. Publication id
// is resolved at runtime from GET /api/v1/chat/channels/<channelUuid>
// (`channel.publication_id`); see fetchChatChannel in ./api.js. We keep the
// legacy branch because the old shape still parses from bookmarks, history
// entries, and the app's own stored links.
//
// Publication SUBDOMAIN chat (bestpub.substack.com/chat) is gone — it now
// 302s to substack.com/@handle — but *.substack.com stays accepted so a
// stale subdomain tab still parses. The host check is load-bearing: this
// parser runs on the URL of whatever tab the toolbar button was clicked
// from, which can be any site, and its output feeds API paths.

const SUBSTACK_HOST_RE = /^(?:[a-z0-9-]+\.)*substack\.com$/i;

const UUID_SRC = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_RE = UUID_SRC;

// app.html is a web_accessible_resource matched to substack.com, so any page
// on that origin can open it with a query string of its choosing. `chan` is
// interpolated straight into an API path, so validate the shape here rather
// than trusting the opener. Exported (not just used internally) because the
// app reads the param from its OWN url, never from parseSubstackChatUrl.
const CHANNEL_ID_RE = new RegExp(`^${UUID_SRC}$`);
export const isChannelId = (v) => typeof v === "string" && CHANNEL_ID_RE.test(v);

// `/chat/group/<channelUuid>` optionally followed by `/post/<postUuid>`.
const GROUP_RE = new RegExp(`^/chat/group/(${UUID_RE})(?:/post/(${UUID_RE}))?/?$`);
// Legacy `/chat/<pubId>` optionally followed by `/post/<postUuid>`.
const LEGACY_RE = new RegExp(`^/chat/(\\d+)(?:/post/(${UUID_RE}))?/?$`);

// Returns null when the URL is not a Substack chat URL we understand.
// Otherwise { publicationId, postUuid, channelId, targetReplyId }, with
// null for whatever the URL doesn't carry. Callers must handle a result
// that has a channelId but no publicationId — that is the normal shape
// for every post-migration URL.
export const parseSubstackChatUrl = (url) => {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!SUBSTACK_HOST_RE.test(u.hostname)) return null;
  // Substack's own permalinks ("Copy link" on a message) carry
  // `target_reply_id` (+ `showTarget=true`); the camelCase spelling is what
  // this parser read before the live capture of 2026-09-18 showed the real
  // form. Accept both — a native permalink pasted into the toolbar flow must
  // land on the comment.
  const targetReplyId =
    u.searchParams.get("target_reply_id") || u.searchParams.get("targetReplyId");

  const group = u.pathname.match(GROUP_RE);
  if (group) {
    return {
      publicationId: null,
      postUuid: group[2] || null,
      channelId: group[1],
      targetReplyId,
    };
  }

  const legacy = u.pathname.match(LEGACY_RE);
  if (legacy) {
    return {
      publicationId: legacy[1],
      postUuid: legacy[2] || null,
      channelId: null,
      targetReplyId,
    };
  }
  return null;
};

// Deep link back into Substack's own client. Prefer the channel form —
// it is what Substack serves today; the legacy form only survives as a
// 301 and we have no guarantee that redirect outlives the migration.
// `targetReplyId` (a comment id) appends Substack's own comment-permalink
// params — `?target_reply_id=<id>&showTarget=true` — which the live client
// honours by scrolling to and highlighting `#comment-<id>` (verified
// 2026-09-18 against a real channel; the camelCase `targetReplyId` param
// does nothing). Only meaningful with a post; ignored otherwise.
export const buildSubstackChatUrl = ({
  channelId,
  publicationId,
  postUuid,
  targetReplyId,
} = {}) => {
  const anchor =
    postUuid && targetReplyId
      ? `?target_reply_id=${encodeURIComponent(String(targetReplyId))}&showTarget=true`
      : "";
  if (channelId) {
    return postUuid
      ? `https://substack.com/chat/group/${channelId}/post/${postUuid}${anchor}`
      : `https://substack.com/chat/group/${channelId}`;
  }
  if (publicationId) {
    return postUuid
      ? `https://substack.com/chat/${publicationId}/post/${postUuid}${anchor}`
      : `https://substack.com/chat/${publicationId}`;
  }
  return "https://substack.com/chat";
};
