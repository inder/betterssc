// REST client for Substack's chat API.
//
// All endpoints below were confirmed in the v0.0.3 / v0.0.4 / v0.0.5 probes —
// see ~/.claude/projects/.../memory/project_betterssc_substack_dom.md for the
// full protocol notes.
//
// CROSS-ORIGIN AUTH NOTE (v0.1.2)
// -------------------------------
// Direct fetch() from the extension page (chrome-extension://) to
// substack.com sends the request but does NOT attach the user's session
// cookie, even with `credentials: "include"` and host_permissions for
// substack.com. (SameSite=Lax/Strict cookies are not first-party from an
// extension origin.) The publication-public endpoint works without auth so
// it looked fine in v0.1, but the comments/inbox/realtime-token endpoints
// returned reduced-scope responses, causing empty chats and chat-tier WS
// subscription failures.
//
// Fix: every API call is proxied through an open substack.com tab via
// chrome.scripting.executeScript in the MAIN world. The fetch runs in the
// page's own origin context, where the session cookie is first-party.
// Substack's own React app makes the same calls the same way; we're just
// piggy-backing on its execution context.

// Tab query has to enumerate both the apex domain AND publication
// subdomains — manifest host_permissions covers both, but
// chrome.tabs.query needs explicit patterns. Without the wildcard
// pattern, a user whose only Substack tab is on bestpub.substack.com
// would look "no tab open" to us even though the manifest can access it.
const TAB_QUERY = ["https://substack.com/*", "https://*.substack.com/*"];
const SUBSTACK_URL_RE = /^https:\/\/(?:[^/]+\.)?substack\.com\//;

let cachedProxyTabId = null;

const findProxyTab = async () => {
  // Prefer the cached tab if it's still on substack.com (apex or sub).
  if (cachedProxyTabId != null) {
    try {
      const tab = await chrome.tabs.get(cachedProxyTabId);
      if (tab && tab.url && SUBSTACK_URL_RE.test(tab.url)) {
        return tab;
      }
    } catch (_) {
      cachedProxyTabId = null;
    }
    cachedProxyTabId = null;
  }
  const tabs = await chrome.tabs.query({ url: TAB_QUERY });
  if (!tabs || !tabs.length) {
    throw new Error(
      "No substack.com tab open. Open https://substack.com/chat in another tab and try again."
    );
  }
  // Prefer a chat tab over any other substack.com tab.
  const chatTab = tabs.find((t) => t.url && /\/chat\//.test(t.url));
  const tab = chatTab || tabs[0];
  cachedProxyTabId = tab.id;
  return tab;
};

const runProxyFetchOn = async (tabId, path, init) => {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [path, init],
    func: async (path, init) => {
      const url = "https://substack.com" + path;
      const t0 = performance.now();
      try {
        const r = await fetch(url, {
          credentials: "include",
          ...init,
        });
        const text = await r.text();
        return {
          ok: r.ok,
          status: r.status,
          text,
          ms: Math.round(performance.now() - t0),
        };
      } catch (e) {
        return {
          ok: false,
          status: 0,
          error: String((e && e.message) || e),
          ms: Math.round(performance.now() - t0),
        };
      }
    },
  });
  return result;
};

// Generic proxy-fetch for non-Substack absolute URLs. Same tab-context
// pattern but lets the caller specify the full URL. Used by the Yahoo
// Finance price fetcher in lib/yahoo.js — running yahoo.com requests
// from substack.com origin via the proxy tab avoids needing a new
// host_permissions grant on user upgrade. Returns the raw response
// envelope ({ok, status, text}) so the caller can handle failures
// without throwing.
export const proxyFetchAbsolute = async (url, init = {}) => {
  let tab = await findProxyTab();
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        args: [url, init],
        func: async (url, init) => {
          const t0 = performance.now();
          try {
            const r = await fetch(url, init);
            const text = await r.text();
            return {
              ok: r.ok,
              status: r.status,
              text,
              ms: Math.round(performance.now() - t0),
            };
          } catch (e) {
            return {
              ok: false,
              status: 0,
              error: String((e && e.message) || e),
              ms: Math.round(performance.now() - t0),
            };
          }
        },
      });
      return result || { ok: false, status: 0, error: "no result" };
    } catch (e) {
      cachedProxyTabId = null;
      if (attempts >= 2) {
        return {
          ok: false,
          status: 0,
          error: `executeScript failed: ${(e && e.message) || e}`,
        };
      }
      tab = await findProxyTab();
    }
  }
};

const proxyFetch = async (path, init = {}) => {
  let tab = await findProxyTab();
  let result;
  let attempts = 0;
  // Up to 2 attempts: the first may fail if the cached tab navigated
  // off substack.com between findProxyTab() and executeScript() (TOCTOU),
  // or if Chrome briefly lost permission on a backgrounded tab. After
  // invalidating the cache and re-querying we get a fresh tab.
  for (;;) {
    attempts++;
    try {
      result = await runProxyFetchOn(tab.id, path, init);
      break;
    } catch (e) {
      cachedProxyTabId = null;
      if (attempts >= 2) {
        throw new Error(
          `executeScript failed (tab closed?): ${(e && e.message) || e}`
        );
      }
      tab = await findProxyTab();
    }
  }
  if (!result) {
    cachedProxyTabId = null;
    throw new Error("Proxy returned no result — tab may have been closed");
  }
  if (result.error) {
    throw new Error(`Network error: ${result.error}`);
  }
  if (!result.ok) {
    throw new Error(
      `${result.status} on ${path} — ${(result.text || "").slice(0, 200)}`
    );
  }
  try {
    return JSON.parse(result.text);
  } catch (e) {
    throw new Error(
      `Invalid JSON from ${path}: ${(result.text || "").slice(0, 200)}`
    );
  }
};

const get = (path) =>
  proxyFetch(path, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

const post = (path, body) =>
  proxyFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

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
// matching `${idx}` placeholders in `body`. Pass null/undefined/empty for
// `mentions` if none — the field is OMITTED from the payload in that case.
// Substack's validator rejects `mentions: {}` with a 400 "Invalid value",
// so we must not send the empty form.
export const postComment = (
  postUuid,
  { id, body, mentions, parentId, quote }
) => {
  const payload = { id, body };
  if (mentions && Object.keys(mentions).length > 0) {
    payload.mentions = mentions;
  }
  if (parentId !== undefined && parentId !== null)
    payload.parent_id = parentId;
  if (quote !== undefined && quote !== null) payload.quote = quote;
  return post(
    `/api/v1/community/posts/${postUuid}/comments`,
    payload
  );
};

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
