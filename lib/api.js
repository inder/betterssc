// REST client for Substack's chat API.
//
// All endpoints below were confirmed in the v0.0.3 / v0.0.4 / v0.0.5 probes —
// see ~/.claude/projects/.../memory/project_betterssc_substack_dom.md for the
// full protocol notes. The extension has host_permissions for
// https://substack.com, so cross-origin fetch() from the extension page is
// allowed AND the user's session cookie is attached when we set
// `credentials: "include"`.

const BASE = "https://substack.com";

const get = async (path) => {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
};

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
};

// ---- Read ----

export const fetchInbox = () => get("/api/v1/messages/inbox?tab=all");

export const fetchUnreadCount = () => get("/api/v1/messages/unread-count");

export const fetchBlocks = () => get("/api/v1/blocks/ids");

export const fetchReactionsLibrary = () => get("/api/v1/threads/reactions");

export const fetchPublication = (publicationId) =>
  get(`/api/v1/publication/public/${publicationId}`);

export const fetchUserProfile = (userId, handle) =>
  get(`/api/v1/user/${userId}-${handle}/public_profile/self`);

// Initial chat load. Use targetReplyId when deep-linking; otherwise omit.
export const fetchCommentsInitial = (postUuid, { targetReplyId } = {}) => {
  const qs = new URLSearchParams({ order: "asc", initial: "true" });
  if (targetReplyId) qs.set("targetReplyId", targetReplyId);
  return get(`/api/v1/community/posts/${postUuid}/comments?${qs.toString()}`);
};

// Paginate backward to load older messages.
export const fetchCommentsBefore = (postUuid, beforeISO) => {
  const qs = new URLSearchParams({ order: "desc", before: beforeISO });
  return get(`/api/v1/community/posts/${postUuid}/comments?${qs.toString()}`);
};

// Poll forward for new messages (fallback if WS drops).
export const fetchCommentsAfter = (postUuid, afterISO) => {
  const qs = new URLSearchParams({ order: "asc", after: afterISO });
  return get(`/api/v1/community/posts/${postUuid}/comments?${qs.toString()}`);
};

// List of chat posts within a publication. Used to find the most recent chat
// post when the user enters a publication without a specific post.
export const fetchPublicationChatPosts = (publicationId) =>
  get(`/api/v1/community/publications/${publicationId}/posts`);

// Realtime token for WS auth. Channels arg is the channels list, e.g.
// ["user:9024475", "chat:6459287:all_subscribers"]. Returns
// { token, expiry, permissions, endpoint }.
export const fetchRealtimeToken = (channels) => {
  const encoded = channels.map(encodeURIComponent).join("%2C");
  return get(`/api/v1/realtime/token?channels=${encoded}`);
};

// ---- Write ----

// Send a chat message. `mentions` is an object of {idx: {user_id, text}}
// matching `${idx}` placeholders in `body`. Pass null for `mentions` if none.
// `parentId` and `quote` are for replies (v0.2 territory).
export const postComment = (postUuid, { id, body, mentions, parentId, quote }) =>
  post(`/api/v1/community/posts/${postUuid}/comments`, {
    id,
    body,
    mentions: mentions || {},
    ...(parentId !== undefined ? { parent_id: parentId } : {}),
    ...(quote !== undefined ? { quote } : {}),
  });

// Add a reaction to a comment.
export const postReaction = (commentId, reactionType) =>
  post(`/api/v1/community/comments/${commentId}/reaction`, {
    reaction: reactionType,
  });

// Mark a chat as viewed up to a timestamp.
export const postChatViewed = (publicationId, postUuid, isoTimestamp) =>
  post(`/api/v1/community/chat/${publicationId}/view`, {
    community_post_id: postUuid,
    last_viewed_timestamp: isoTimestamp,
  });

// Mention autocomplete.
export const fetchMentionSuggestions = (publicationId, postUuid, query) => {
  const qs = new URLSearchParams({
    publication_id: publicationId,
    community_post_id: postUuid,
    query,
  });
  return get(`/api/v1/community/mention?${qs.toString()}`);
};

// ---- Tier detection ----
//
// The WS channel tier (all_subscribers / only_paid / only_founding) is
// dictated by what the JWT permissions list contains. We just try the
// broadest token request and let the server tell us which we're allowed.
// Returns the list of permitted publish/subscribe channels for this chat.
export const detectChatChannels = (token, publicationId) => {
  const perms = (token && token.permissions) || [];
  const tiers = ["all_subscribers", "only_paid", "only_founding"];
  const subscribed = [];
  for (const tier of tiers) {
    if (perms.includes(`subscribe|chat:${publicationId}:${tier}`)) {
      subscribed.push(`chat:${publicationId}:${tier}`);
    }
  }
  return subscribed;
};
