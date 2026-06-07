// BetterSSC v0.1 — main controller.
//
// Reads ?pub=<pubId>&post=<postUuid> from the URL, loads the chat via the
// confirmed REST endpoints, opens a WebSocket for live updates, and renders
// in a Discord-style two-pane layout.
//
// Read-only in v0.1. Send + react land in v0.2.

import {
  fetchCommentsInitial,
  fetchCommentsBefore,
  fetchCommentsAfter,
  fetchPublication,
  fetchRealtimeToken,
  detectChatChannels,
  postChatViewed,
} from "./lib/api.js";
import { SubstackRealtime } from "./lib/ws.js";
import {
  formatRelativeTime,
  formatAbsoluteTime,
  segmentBody,
  linkifyText,
  groupByAuthor,
  escapeHtml,
  throttle,
  debounce,
} from "./lib/util.js";
import {
  maybeNotifyMention,
  resetUnreadMentions,
} from "./lib/notify.js";
import { reactionEmojiFor } from "./lib/emojis.js";

// ============================================================
// SVG ICONS (inline so they inherit currentColor + scale crisply)
// ============================================================

const ICON_PIN_OFF = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <path d="M12 17v5"/>
  <path d="M9 10.76V6h6v4.76l3.5 4.24H5.5L9 10.76z"/>
</svg>`;

const ICON_PIN_ON = `<svg viewBox="0 0 24 24" width="14" height="14"
  fill="currentColor" aria-hidden="true">
  <path d="M12 17v5"/>
  <path d="M9 10.76V6h6v4.76l3.5 4.24H5.5L9 10.76z"/>
</svg>`;

const ICON_BELL_ON = `<svg viewBox="0 0 24 24" width="14" height="14"
  fill="currentColor" aria-hidden="true">
  <path d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22z"/>
  <path d="M18 16v-5a6 6 0 0 0-5-5.91V4a1 1 0 0 0-2 0v1.09A6 6 0 0 0 6 11v5l-2
    2v1h16v-1z"/>
</svg>`;

const ICON_BELL_OFF = `<svg viewBox="0 0 24 24" width="14" height="14"
  fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M18 8a6 6 0 0 0-9.33-5"/>
  <path d="M6.26 6.26A6 6 0 0 0 6 8v5l-2 2v1h12.74"/>
  <path d="M18 14v-1l2-2"/>
  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  <path d="M2 2l20 20"/>
</svg>`;

// ============================================================
// STATE
// ============================================================

const state = {
  publicationId: null,
  postUuid: null,
  targetReplyId: null,
  user: null, // {id, name, handle} from _analyticsConfig (via background)
  publication: null, // /api/v1/publication/public/<id> response
  comments: new Map(), // id → comment
  order: [], // ordered list of comment ids, oldest → newest
  authors: new Map(), // userId → {profile, lastSeenAt}
  moreBefore: true, // pagination flag
  loadingHistory: false,
  earliestISO: null,
  ws: null,
  wsStatus: "idle",
  searchQuery: "",
  searchHits: [], // ordered list of comment ids matching query
  searchActiveIdx: 0,
  isAtBottom: true,
  pendingNewMessages: 0,
  watchedUserIds: new Set(),
  pinnedUserIds: new Set(),
  memberSort: "active", // "active" (most messages) or "name"
  threadFilter: null, // { parentId } when user clicked a 💬 thread icon
};

// ============================================================
// BOOT
// ============================================================

const params = new URLSearchParams(location.search);
state.publicationId = params.get("pub");
state.postUuid = params.get("post");
state.targetReplyId = params.get("reply");

const landingEl = document.getElementById("landing");
const appEl = document.getElementById("app");

if (!state.publicationId || !state.postUuid) {
  showLanding();
} else {
  appEl.classList.remove("hidden");
  init();
}

function showLanding() {
  landingEl.classList.remove("hidden");
  appEl.classList.add("hidden");
  if (state.publicationId && !state.postUuid) {
    document.getElementById("landing-msg").textContent =
      "I have the publication, but not a specific chat post — open one in Substack and click BetterSSC again.";
  }
}

async function init() {
  bindEventHandlers();
  restoreWatchedUsers();

  // Identity comes from background which inspects an open Substack tab.
  // Fallback: try to read from a known route once we hit the API.
  try {
    state.user = await fetchUserIdentity();
  } catch (_) {}

  // Load the publication header for chrome.
  try {
    const pubRes = await fetchPublication(state.publicationId);
    state.publication = pubRes && pubRes.pub;
  } catch (_) {}

  // Reflect into the header.
  document.getElementById("pubName").textContent =
    (state.publication && state.publication.name) ||
    `Publication ${state.publicationId}`;
  document.getElementById(
    "openNativeChat"
  ).href = `https://substack.com/chat/${state.publicationId}/post/${state.postUuid}`;
  updateBaseTitle();

  // Initial comments.
  await loadInitial();
  // Mark as viewed.
  scheduleMarkViewed();
  // WS is OFF by default in v0.1.16. Substack's wss://zyncrealtime protocol
  // rejects our subscribe frames with `Invalid message` after auth OK, and
  // we can't reverse-engineer the right shape from one-sided traces. To stop
  // log noise and a wasted ~5s of open-then-error per page load, the
  // attempt is gated behind a debug flag. Polling is the live mechanism.
  // To re-enable for debugging:
  //   chrome.storage.local.set({ bssc_ws_enabled: true })
  try {
    chrome.storage &&
      chrome.storage.local &&
      chrome.storage.local.get(["bssc_ws_enabled"], async (res) => {
        if (res && res.bssc_ws_enabled) {
          await connectRealtime();
        } else {
          setWsStatus("disabled");
        }
      });
  } catch (_) {
    setWsStatus("disabled");
  }
  startPollingFallback();
}

const POLL_INTERVAL_MS = 12_000;
let _pollTimer = null;
let _pollInflight = false;

function startPollingFallback() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(pollNewMessages, POLL_INTERVAL_MS);
  // First poll fires after one interval — initial load already covers t=0.
}

async function pollNewMessages() {
  if (_pollInflight) return;
  if (document.hidden) return; // don't poll when tab is in background
  const since = getNewestCommentISO();
  if (!since) return;
  _pollInflight = true;
  try {
    const res = await fetchCommentsAfter(state.postUuid, since);
    // Flatten threaded replies so in-thread comments come through.
    const replies = flattenReplies(res && res.replies);
    if (!replies.length) return;
    const before = state.comments.size;
    const newlyAdded = [];
    for (const r of replies) {
      const sizeBefore = state.comments.size;
      ingestComment(r);
      if (state.comments.size > sizeBefore) {
        newlyAdded.push(unwrapComment(r) || r);
      }
    }
    const added = state.comments.size - before;
    if (added > 0) {
      renderAll();
      incrementUnreadWhileHidden(added);
      // Fire per-user alerts on every truly-new comment (originals and
      // threaded replies).
      for (const c of newlyAdded) maybeAlertOnWatchedUser(c);
      if (state.isAtBottom) {
        scrollToBottom();
      } else {
        state.pendingNewMessages += added;
        showNewMessageJump();
      }
    }
  } catch (e) {
    console.warn("[BetterSSC POLL] failed:", e && e.message);
  } finally {
    _pollInflight = false;
  }
}

function getNewestCommentISO() {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const c = state.comments.get(state.order[i]);
    if (c && c.created_at) return c.created_at;
  }
  return null;
}

// ============================================================
// IDENTITY (best-effort)
// ============================================================

// We can't read window._analyticsConfig directly from this page (it's the
// extension's own origin). Instead, ask any open Substack tab via the
// content-script bridge. If none is open we fall back to deriving identity
// from the first API response that includes the calling user.
async function fetchUserIdentity() {
  // Try /api/v1/messages/inbox/unread-count won't tell us identity.
  // Try /api/v1/blocks/ids — returns blocks but not own ID.
  // The reliable answer: ask the content script in a Substack tab.
  return new Promise((resolve, reject) => {
    chrome.tabs.query(
      { url: ["https://substack.com/*", "https://*.substack.com/*"] },
      async (tabs) => {
        if (chrome.runtime.lastError || !tabs || !tabs.length) {
          return resolve(null);
        }
        // Inject a tiny query into the first tab's content script context.
        try {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            world: "MAIN",
            func: () => {
              const cfg = window._analyticsConfig;
              if (!cfg || !cfg.user) return null;
              // Capture ONLY what the extension needs (id + name). Email and
              // anonymousId are PII we don't use anywhere; not caching them.
              return { id: cfg.user.id, name: cfg.user.name };
            },
          });
          if (result && result.id) return resolve(result);
          resolve(null);
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

// ============================================================
// DATA LOAD
// ============================================================

async function loadInitial() {
  try {
    const res = await fetchCommentsInitial(state.postUuid, {
      targetReplyId: state.targetReplyId,
    });
    // Harvest user info from anywhere we can find it in the response.
    if (res && Array.isArray(res.users)) {
      registerUserObjects(res.users);
    }
    if (res && res.post) {
      registerUserObjects([res.post.communityPost?.author].filter(Boolean));
      registerUserObjects(res.post.users);
      registerUserObjects(res.post.recent_commenters);
    }
    if (res && Array.isArray(res.replies)) {
      for (const r of res.replies) {
        if (r && Array.isArray(r.recent_commenters)) {
          registerUserObjects(r.recent_commenters);
        }
      }
    }

    document.getElementById("postTitle").textContent =
      (res.post && res.post.communityPost && res.post.communityPost.body
        ? res.post.communityPost.body.slice(0, 80)
        : "");
    // v0.1.11: unwrap replies BEFORE reading created_at — REST replies are
    // wrapped (`{comment: {...}, user: {...}}`), so the outer object's
    // `created_at` is undefined and our pagination cursor was never set.
    // v0.1.20: flatten threaded replies so in-thread comments are ingested
    // too (they're nested under their parent in the response, not at top).
    const unwrappedReplies = flattenReplies(res.replies || [])
      .map((r) => unwrapComment(r) || r)
      .filter((r) => r && r.created_at);
    unwrappedReplies.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    for (const c of unwrappedReplies) ingestComment(c, { silent: true });
    state.moreBefore = res.moreBefore !== false;
    if (unwrappedReplies.length) {
      state.earliestISO = unwrappedReplies[0].created_at;
    } else {
      showError(
        "Loaded 0 messages. Check DevTools → Network → /comments request and share what you see."
      );
    }
    renderAll();
    scrollToBottom();
  } catch (e) {
    console.error("[BetterSSC] loadInitial failed:", e);
    showError(`Failed to load chat: ${e.message}`);
  }
}

async function loadOlder() {
  if (state.loadingHistory || !state.moreBefore || !state.earliestISO) return;
  state.loadingHistory = true;
  document.getElementById("historyLoading").classList.remove("hidden");
  const prevScrollHeight = document.getElementById("stream").scrollHeight;
  const prevScrollTop = document.getElementById("stream").scrollTop;
  try {
    const res = await fetchCommentsBefore(state.postUuid, state.earliestISO);
    // Same unwrap + flatten fixes as loadInitial.
    const unwrappedReplies = flattenReplies(res.replies || [])
      .map((r) => unwrapComment(r) || r)
      .filter((r) => r && r.created_at && r.id);
    unwrappedReplies.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    let count = 0;
    for (const c of unwrappedReplies) {
      if (!state.comments.has(c.id)) {
        ingestComment(c, { silent: true });
        count++;
      }
    }
    if (unwrappedReplies.length) {
      state.earliestISO = unwrappedReplies[0].created_at;
    }
    state.moreBefore = res.moreBefore !== false && count > 0;
    renderAll();
    // Preserve scroll position so we don't yank the user.
    const stream = document.getElementById("stream");
    stream.scrollTop = prevScrollTop + (stream.scrollHeight - prevScrollHeight);
  } catch (e) {
    showError(`Failed to load older messages: ${e.message}`);
  } finally {
    state.loadingHistory = false;
    document.getElementById("historyLoading").classList.add("hidden");
  }
}

// Unwraps the various shapes a Substack comment can arrive in.
//
// REST /comments shape (v0.1.7 dump):
//   { comment: { id, user_id, body, ... }, user: { id, name, handle, photo_url }, quote: {comment, user}, pub_roles, user_status }
//
// WS chat:new-comment shape (v0.0.5):
//   { type: "chat:new-comment", comment: { id, ..., author: {...} } }
//
// Both wrap the actual comment under `comment`, but REST puts the author as
// a sibling `user` while WS nests it as `comment.author`. This unwrap
// normalizes both into a single shape with `author` populated.
function unwrapComment(raw) {
  if (!raw) return null;
  // `raw.id == null` instead of `!raw.id` so a legitimate id of 0 doesn't
  // accidentally trigger unwrap, and so wrapped replies whose outer object
  // *also* has an id field still get unwrapped via the `raw.type` branch.
  if (raw.comment && (raw.type || raw.id == null)) {
    const c = raw.comment;
    // Attach sibling `user` as the canonical author.
    if (raw.user && !c.author) c.author = raw.user;
    // Same for the quoted comment (replies).
    if (c.quote == null && raw.quote && raw.quote.comment) {
      const q = raw.quote.comment;
      if (raw.quote.user && !q.author) q.author = raw.quote.user;
      c.quote = q;
    }
    return c;
  }
  return raw;
}

function commentId(c) {
  if (!c) return null;
  return c.id || c.comment_id || c._id || c.uuid || null;
}

// v0.1.20: flatten threaded reply trees. Substack returns top-level
// comments in `replies[]`, but a comment that REPLIES to another
// (parent_id set) lives nested under the parent. Without this walker we
// silently drop every in-thread reply — which is why "X minutes ago" in
// the Active rail and bell alerts both froze on a user's last top-level
// message.
function flattenReplies(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const walk = (node) => {
    if (!node) return;
    out.push(node);
    // Two shapes we've seen: nested at the wrapper level, or under
    // wrapper.comment. Try both.
    if (Array.isArray(node.replies)) for (const r of node.replies) walk(r);
    if (node.comment && Array.isArray(node.comment.replies)) {
      for (const r of node.comment.replies) walk(r);
    }
    if (Array.isArray(node.children)) for (const r of node.children) walk(r);
  };
  for (const r of items) walk(r);
  return out;
}

// v0.1.6 found: Substack's REST /comments response gives flat user_id only,
// no name/handle/photo_url inline. v0.1.7 looks up display info from the
// response-wide user-table the controller maintains.
const _userTable = new Map(); // user_id → {id, name, handle, photo_url}

function registerUserObjects(arr) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const u of arr) {
    if (u && (u.id != null || u.user_id != null)) {
      const id = u.id ?? u.user_id;
      if (!_userTable.has(id)) {
        _userTable.set(id, {
          id,
          name: u.name || u.handle || `User ${id}`,
          handle: u.handle || null,
          photo_url: u.photo_url || null,
        });
        n++;
      }
    }
  }
  return n;
}

function syntheticAuthor(c) {
  if (c.author && typeof c.author === "object" && c.author.name) return c.author;
  const uid = c.user_id ?? c.author_id ?? c.userId;
  // First: look up in cumulative user table (populated from recent_commenters,
  // post.author, mentions, etc).
  if (uid != null && _userTable.has(uid)) {
    return { ..._userTable.get(uid) };
  }
  // Second: try the comment's own `recent_commenters` if it looks like users.
  if (Array.isArray(c.recent_commenters)) {
    const match = c.recent_commenters.find(
      (u) => u && (u.id === uid || u.user_id === uid)
    );
    if (match) {
      const obj = {
        id: match.id ?? match.user_id,
        name: match.name || `User ${uid}`,
        handle: match.handle || null,
        photo_url: match.photo_url || null,
      };
      _userTable.set(obj.id, obj);
      return obj;
    }
  }
  // Last resort: show user_id so the user sees SOMETHING distinguishing.
  return {
    id: uid != null ? uid : "unknown",
    name: uid != null ? `User #${uid}` : "Unknown",
    handle: null,
    photo_url: null,
  };
}

function ingestComment(c, { silent = false } = {}) {
  const unwrapped = unwrapComment(c);
  if (!unwrapped) return;
  const id = commentId(unwrapped);
  if (!id) return;
  if (!unwrapped.id) unwrapped.id = id;

  // Normalize author shape — REST flat → synthesized object that matches
  // what render code (and the WS event shape) expects.
  if (!unwrapped.author) {
    unwrapped.author = syntheticAuthor(unwrapped);
  }

  const isNew = !state.comments.has(id);
  state.comments.set(id, unwrapped);
  if (isNew) {
    insertInOrder(unwrapped);
  }
  if (unwrapped.author && unwrapped.author.id != null) {
    const prev = state.authors.get(unwrapped.author.id);
    const t = new Date(unwrapped.created_at).getTime() || 0;
    const next = prev || {
      profile: unwrapped.author,
      lastSeenAt: 0,
      messageCount: 0,
    };
    // Update profile only if not already set (preserves first non-null fields).
    if (!next.profile || !next.profile.name) next.profile = unwrapped.author;
    if (t > next.lastSeenAt) next.lastSeenAt = t;
    // Count each unique message ID once. isNew guarantees that.
    if (isNew) next.messageCount = (next.messageCount || 0) + 1;
    state.authors.set(unwrapped.author.id, next);
  }
  if (isNew && !silent) {
    maybeNotifyMention({
      comment: unwrapped,
      user: state.user,
      settings: {},
    });
  }
}

function insertInOrder(c) {
  const t = new Date(c.created_at).getTime();
  if (
    !state.order.length ||
    new Date(state.comments.get(state.order[state.order.length - 1]).created_at).getTime() <=
      t
  ) {
    state.order.push(c.id);
    return;
  }
  // Binary search insert.
  let lo = 0;
  let hi = state.order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midT = new Date(
      state.comments.get(state.order[mid]).created_at
    ).getTime();
    if (midT < t) lo = mid + 1;
    else hi = mid;
  }
  state.order.splice(lo, 0, c.id);
}

// ============================================================
// REALTIME
// ============================================================

async function connectRealtime() {
  // v0.1.7: match what the native client does — request just one chat tier
  // in the probe. Substack's server returns perms for ALL tiers the user
  // has access to, not just the one requested.
  let probe;
  try {
    probe = await fetchRealtimeToken([
      `user:${state.user ? state.user.id : "0"}`,
      `chat:${state.publicationId}:all_subscribers`,
    ]);
  } catch (e) {
    setWsStatus("error");
    showError(`Realtime token fetch failed: ${e.message}`);
    return;
  }
  const allChatChannels = detectChatChannels(probe, state.publicationId);
  const tierOrder = ["only_founding", "only_paid", "all_subscribers"];
  const bestTier = tierOrder.find((t) =>
    allChatChannels.includes(`chat:${state.publicationId}:${t}`)
  );
  const chatChannels = bestTier
    ? [`chat:${state.publicationId}:${bestTier}`]
    : [];

  if (!chatChannels.length && !state.user) {
    showError(
      "No accessible chat channels for this publication. Are you a subscriber?"
    );
    setWsStatus("error");
    return;
  }

  // For the auth-then-subscribe handshake we provide TWO channel groups.
  // First connects with user-only perms (auth). Second pushes a fresh token
  // scoped to user + the highest accessible chat tier (subscribe).
  const userChannels = state.user ? [`user:${state.user.id}`] : [];
  const chatPlusUserChannels = [...userChannels, ...chatChannels];

  state.ws = new SubstackRealtime({
    channels: userChannels.length ? userChannels : chatChannels,
    secondaryChannels: chatPlusUserChannels,
    onStatusChange: setWsStatus,
  });
  state.ws.addEventListener("chat-event", (e) => handleChatEvent(e.detail));
  state.ws.addEventListener("server-error", (e) => {
    console.warn("[BetterSSC] WS server error:", e.detail);
  });
  state.ws.connect();
}

function handleChatEvent(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === "chat:new-comment" && ev.comment) {
    // Only ingest if for our current post.
    if (ev.comment.post_id !== state.postUuid) return;
    ingestComment(ev.comment, { silent: false });
    renderAll();
    if (state.isAtBottom) {
      scrollToBottom();
    } else {
      state.pendingNewMessages++;
      showNewMessageJump();
    }
  } else if (ev.type === "chat:updated-comment" && ev.comment) {
    if (ev.comment.post_id !== state.postUuid) return;
    ingestComment(ev.comment, { silent: true });
    renderAll();
  } else if (ev.type === "chat:updated-post" && ev.post) {
    // Post metadata changed. We don't currently render anything that depends
    // on it; pass for now.
  }
}

function setWsStatus(s) {
  state.wsStatus = s;
  const el = document.getElementById("wsStatus");
  if (!el) return;
  // v0.1.26: the badge now reflects the LIVE-update mechanism the app is
  // actually using, not the raw WS state. When WS is "disabled" we're
  // still very much live via polling — show that as a green "live poll".
  let label, dotState, title;
  switch (s) {
    case "connected":
      label = "ws on";
      dotState = "connected";
      title = "Live updates via WebSocket (preferred)";
      break;
    case "connecting":
      label = "connecting";
      dotState = "connecting";
      title = "Opening WebSocket…";
      break;
    case "error":
      label = "error · polling";
      dotState = "warning";
      title = "WebSocket error — polling is still active";
      break;
    case "disconnected":
      label = "reconnecting · polling";
      dotState = "warning";
      title = "WebSocket disconnected, retrying — polling is still active";
      break;
    case "disabled":
    case "idle":
    default:
      label = "live poll";
      dotState = "connected"; // green — polling delivers updates
      title = "Live updates via 12s polling (WebSocket is off)";
      break;
  }
  el.querySelector(".dot").className = `dot dot-${dotState}`;
  el.querySelector(".ws-label").textContent = label;
  el.title = title;
}

// ============================================================
// MARK VIEWED
// ============================================================

let _markViewedTimer = null;
const scheduleMarkViewed = () => {
  markViewed();
  if (_markViewedTimer) clearInterval(_markViewedTimer);
  _markViewedTimer = setInterval(() => {
    if (!document.hidden) markViewed();
  }, 30_000);
};

const markViewed = throttle(async () => {
  try {
    await postChatViewed(
      state.publicationId,
      state.postUuid,
      new Date().toISOString()
    );
  } catch (_) {}
}, 5000);

// ============================================================
// RENDER
// ============================================================

function renderAll() {
  buildThreadIndex();
  renderMessages();
  renderMembers();
  renderFooterStats();
  if (state.searchQuery || state.threadFilter) applySearch();
}

// Build a client-side index of which messages reply to which others.
// Substack chat has TWO reply patterns:
//   - threaded reply (parent_id points at parent — server tracks via reply_count)
//   - quote reply (quote_id points at parent — server does NOT increment reply_count)
// Most chats lean heavily on quote-replies, so reply_count is often 0
// even when the message clearly has follow-ups. The index unifies both.
function buildThreadIndex() {
  const idx = new Map(); // parentId → Set<childId>
  for (const id of state.order) {
    const c = state.comments.get(id);
    if (!c) continue;
    const parents = [c.parent_id, c.quote_id].filter(Boolean);
    for (const p of parents) {
      if (!idx.has(p)) idx.set(p, new Set());
      idx.get(p).add(id);
    }
  }
  state.threadIndex = idx;
}

function renderMessages() {
  const msgs = state.order.map((id) => state.comments.get(id)).filter(Boolean);
  const groups = groupByAuthor(msgs);
  const container = document.getElementById("messages");
  if (!container) return;
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    try {
      frag.appendChild(renderGroup(g));
    } catch (e) {
      console.error("[BetterSSC] renderGroup failed:", e);
    }
  }
  container.replaceChildren(frag);

  // v0.1.15: restore the vi-active marker so j/k navigation doesn't get
  // teleported back to the first visible group every time polling triggers
  // a re-render. _viActiveId is the first-id of the previously active group.
  if (_viActiveId) {
    const restored = container.querySelector(
      `.msg-group[data-first-id="${cssEscape(_viActiveId)}"]`
    );
    if (restored && !restored.classList.contains("search-hidden")) {
      restored.classList.add("vi-active");
    }
  }
}

function renderGroup(group) {
  const root = document.createElement("div");
  root.className = "msg-group";
  root.dataset.authorId = String(group.author && group.author.id);
  root.dataset.firstId = group.items[0].id;

  // Mark whole group with mention class if any item mentions current user.
  if (state.user) {
    for (const c of group.items) {
      if (commentMentionsUser(c, state.user)) {
        root.classList.add("mention-row");
        break;
      }
    }
  }

  // Avatar — referrerpolicy="no-referrer" stops Substack's S3 from 403'ing
  // because we don't have a matching Referer header. onerror falls back to a
  // letter placeholder so broken-image icons don't flicker into the stream.
  const avatar = makeAvatar(group.author, "msg-avatar");
  root.appendChild(avatar);

  // Body
  const body = document.createElement("div");
  body.className = "msg-body";

  const header = document.createElement("div");
  header.className = "msg-header";
  const authorEl = document.createElement("span");
  authorEl.className = "msg-author";
  authorEl.textContent = group.author?.name || "Unknown";
  if (group.author?.name) {
    authorEl.title = `Filter to ${group.author.name}'s messages`;
    authorEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      filterByAuthorName(group.author.name);
    });
  }
  const timeEl = document.createElement("span");
  timeEl.className = "msg-time";
  timeEl.title = formatAbsoluteTime(group.items[0].created_at);
  timeEl.textContent = formatRelativeTime(group.items[0].created_at);
  header.appendChild(authorEl);
  header.appendChild(timeEl);

  // Thread badge — sits at the right end of the header row. If any
  // message in the group has replies (threaded or quote), show one badge
  // for the first such message + count = max reply_count in the group.
  let firstWithReplies = null;
  let totalReplies = 0;
  for (const item of group.items) {
    const localRefs =
      (state.threadIndex && state.threadIndex.get(item.id)) || null;
    const localCount = localRefs ? localRefs.size : 0;
    const n = Math.max(item.reply_count || 0, localCount);
    if (n > 0) {
      if (!firstWithReplies) firstWithReplies = item;
      totalReplies = Math.max(totalReplies, n);
    }
  }
  if (firstWithReplies) {
    const threadBtn = document.createElement("button");
    threadBtn.type = "button";
    threadBtn.className = "msg-thread-btn";
    threadBtn.textContent = `💬 ${totalReplies}`;
    threadBtn.title = `Open thread (${totalReplies} repl${
      totalReplies === 1 ? "y" : "ies"
    })`;
    threadBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openThreadFilter(firstWithReplies.id);
    });
    header.appendChild(threadBtn);
  }
  body.appendChild(header);

  for (const c of group.items) {
    body.appendChild(renderMessageItem(c));
  }

  root.appendChild(body);
  return root;
}

function renderMessageItem(c) {
  const wrap = document.createElement("div");
  wrap.className = "msg-item";
  wrap.dataset.id = c.id;

  // Thread badge moved to renderGroup (above) so it sits in the header
  // row next to the author name + timestamp, rather than overlapping the
  // message text.

  // Quote preview if reply — Substack-style accent-tinted block, clickable
  // to jump to the original.
  if (c.quote && (c.quote.body || c.quote.author)) {
    const q = document.createElement("div");
    q.className = "msg-quote";
    if (c.quote.id) {
      q.dataset.quoteId = c.quote.id;
      q.title = "Jump to original message";
    }
    const qAuthor = document.createElement("div");
    qAuthor.className = "msg-quote-author";
    qAuthor.textContent = c.quote.author?.name || "Reply";
    const qBody = document.createElement("div");
    qBody.className = "msg-quote-body";
    qBody.textContent = (c.quote.body || "").slice(0, 200);
    q.appendChild(qAuthor);
    q.appendChild(qBody);
    q.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (c.quote && c.quote.id) jumpToMessage(c.quote.id);
    });
    wrap.appendChild(q);
  }

  // Body with mention + URL expansion.
  const segments = segmentBody(c.body, c.mentions);
  for (const seg of segments) {
    if (seg.type === "mention") {
      const span = document.createElement("span");
      span.className = "msg-mention";
      span.textContent = seg.value;
      if (seg.userId) span.dataset.userId = seg.userId;
      wrap.appendChild(span);
    } else {
      for (const part of linkifyText(seg.value)) {
        if (part.type === "link") {
          const a = document.createElement("a");
          a.href = part.value;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = part.value;
          wrap.appendChild(a);
        } else {
          wrap.appendChild(document.createTextNode(part.value));
        }
      }
    }
  }

  // Attachments (images and files). v0.1.13: defensively handle the three
  // fields Substack exposes — media_uploads, threadMediaUploads,
  // mediaAttachments — since we haven't fully captured every shape they
  // can take.
  appendAttachments(wrap, c);

  // Reactions row. v0.1.11: REST shape is {name: <count number>}; WS event
  // shape might be {name: {count, has_reacted}}. Handle both, and filter
  // out zero-count entries (we were rendering "👍 0" pills).
  if (c.reactions && typeof c.reactions === "object") {
    const entries = Object.entries(c.reactions)
      .map(([name, v]) => {
        const count = typeof v === "number" ? v : (v && v.count) || 0;
        return [name, count];
      })
      .filter(([, count]) => count > 0);
    if (entries.length) {
      const reactionsEl = document.createElement("div");
      reactionsEl.className = "msg-reactions";
      for (const [reactionType, count] of entries) {
        const pill = document.createElement("span");
        pill.className = "msg-reaction";
        pill.title = `:${reactionType}: ×${count}`;
        pill.appendChild(
          document.createTextNode(reactionEmojiFor(reactionType))
        );
        const countEl = document.createElement("span");
        countEl.className = "msg-reaction-count";
        countEl.textContent = String(count);
        pill.appendChild(countEl);
        reactionsEl.appendChild(pill);
      }
      wrap.appendChild(reactionsEl);
    }
  }

  return wrap;
}

// Cache of image URLs we already know are 403/dead. Prevents the 12s poll
// cycle from re-firing failed requests forever. v0.1.19.
const _failedImageUrls = new Set();

// Substack's media bucket (bucketeer-XXX.s3.amazonaws.com) blocks direct
// client-side access. Their own UI fetches through substackcdn.com with a
// server-generated signature. We try the unsigned form as a long shot —
// works if Cloudinary is configured to allow it for this account.
function rewriteImageUrl(url) {
  if (!url) return url;
  if (url.startsWith("https://substackcdn.com/")) return url;
  if (/\.s3\.amazonaws\.com\/public\/images\//.test(url)) {
    return (
      "https://substackcdn.com/image/fetch/f_auto,q_auto:good,fl_progressive:steep/" +
      encodeURIComponent(url)
    );
  }
  return url;
}

function makeAvatarPlaceholder(initial, cssClass) {
  const div = document.createElement("div");
  div.className = cssClass + " msg-avatar-placeholder";
  div.textContent = initial;
  return div;
}

function makeAvatar(author, cssClass) {
  const initial = ((author && author.name) || "?").charAt(0).toUpperCase();
  if (!author || !author.photo_url) {
    return makeAvatarPlaceholder(initial, cssClass);
  }
  const url = rewriteImageUrl(author.photo_url);
  // Already-failed URLs go straight to placeholder — no more re-fetch storms.
  if (_failedImageUrls.has(url)) {
    return makeAvatarPlaceholder(initial, cssClass);
  }
  const img = document.createElement("img");
  img.className = cssClass;
  img.src = url;
  img.alt = author.name || "";
  img.loading = "lazy";
  img.addEventListener("error", () => {
    _failedImageUrls.add(url);
    img.replaceWith(makeAvatarPlaceholder(initial, cssClass));
  });
  return img;
}

// Extract image/file URL from one of Substack's various attachment shapes.
// We don't have an exhaustive capture; this is defensive against:
//   string URL, { url }, { src }, { image_url }, { imageUrl }, { href }
function extractAttachmentUrl(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  return (
    a.url ||
    a.src ||
    a.image_url ||
    a.imageUrl ||
    a.href ||
    a.signed_url ||
    a.signedUrl ||
    null
  );
}

function isImageUrl(url) {
  if (!url) return false;
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|$)/i.test(url) ||
    /substack-post-media|substackcdn|substack-cdn|cloudfront|s3\.amazonaws/.test(url);
}

function appendAttachments(wrap, c) {
  const buckets = [
    c.media_uploads,
    c.threadMediaUploads,
    c.mediaAttachments,
    c.attachments,
  ];
  const urls = [];
  const seen = new Set();
  for (const b of buckets) {
    if (Array.isArray(b)) {
      for (const a of b) {
        const u = extractAttachmentUrl(a);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        urls.push({ url: u, raw: a });
      }
    }
  }
  if (!urls.length) return;
  const container = document.createElement("div");
  container.className = "msg-attachments";
  for (const { url, raw } of urls) {
    if (isImageUrl(url)) {
      const finalUrl = rewriteImageUrl(url);
      const fallbackLink = () => {
        const a = document.createElement("a");
        a.className = "msg-attachment-file";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "📎 image (click to open in new tab)";
        return a;
      };
      if (_failedImageUrls.has(finalUrl)) {
        container.appendChild(fallbackLink());
        continue;
      }
      const img = document.createElement("img");
      img.className = "msg-attachment-img";
      img.src = finalUrl;
      img.alt = (raw && (raw.alt || raw.filename || raw.name)) || "image";
      img.loading = "lazy";
      img.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(finalUrl);
      });
      img.addEventListener("error", () => {
        _failedImageUrls.add(finalUrl);
        img.replaceWith(fallbackLink());
      });
      container.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.className = "msg-attachment-file";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent =
        "📎 " + ((raw && (raw.filename || raw.name)) || url.split("/").pop());
      container.appendChild(link);
    }
  }
  wrap.appendChild(container);
}

function openLightbox(url) {
  const existing = document.querySelector(".lightbox");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  const img = document.createElement("img");
  img.src = url;
  overlay.appendChild(img);
  overlay.addEventListener("click", () => overlay.remove());
  document.addEventListener(
    "keydown",
    function onKey(e) {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
      }
    },
    { once: true }
  );
  document.body.appendChild(overlay);
}

function commentMentionsUser(c, user) {
  if (!user) return false;
  if (c.mentions) {
    for (const m of Object.values(c.mentions)) {
      if (m && m.user_id === user.id) return true;
    }
  }
  return false;
}

function renderMembers() {
  const list = document.getElementById("memberList");
  if (!list) return;
  const all = Array.from(state.authors.values());
  const pinned = all.filter((a) => state.pinnedUserIds.has(a.profile.id));
  const rest = all.filter((a) => !state.pinnedUserIds.has(a.profile.id));
  const cmp =
    state.memberSort === "name"
      ? (a, b) =>
          (a.profile.name || "").localeCompare(b.profile.name || "")
      : (a, b) =>
          (b.messageCount || 0) - (a.messageCount || 0) ||
          (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  pinned.sort(cmp);
  rest.sort(cmp);

  // Update header with the sort toggle (rebuild each render so the
  // active option stays in sync).
  renderMembersHeader();

  const frag = document.createDocumentFragment();
  if (pinned.length) {
    const sub = document.createElement("li");
    sub.className = "member-subheader";
    sub.textContent = "Pinned";
    frag.appendChild(sub);
    for (const a of pinned) frag.appendChild(buildMemberRow(a, true));
    const sub2 = document.createElement("li");
    sub2.className = "member-subheader";
    sub2.textContent =
      state.memberSort === "name" ? "All (A→Z)" : "Most active";
    frag.appendChild(sub2);
  }
  for (const a of rest.slice(0, 80)) frag.appendChild(buildMemberRow(a, false));
  list.replaceChildren(frag);
}

function renderMembersHeader() {
  const header = document.getElementById("membersHeader");
  if (!header) return;
  header.innerHTML = "";
  const label = document.createElement("span");
  label.className = "members-header-label";
  label.textContent = "Active";
  header.appendChild(label);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "members-sort-toggle";
  toggle.title =
    state.memberSort === "active"
      ? "Sorted by most active (most messages) — click to sort A→Z"
      : "Sorted alphabetically — click to sort by most active";
  toggle.textContent = state.memberSort === "active" ? "Most active" : "A→Z";
  toggle.addEventListener("click", () => {
    state.memberSort = state.memberSort === "active" ? "name" : "active";
    persistMembersUiPrefs();
    renderMembers();
  });
  header.appendChild(toggle);
}

function buildMemberRow(a, isPinned) {
  const li = document.createElement("li");
  li.className = "member";
  li.dataset.userId = String(a.profile.id);
  const isWatched = state.watchedUserIds.has(a.profile.id);
  if (isWatched) li.classList.add("watched");
  if (isPinned) li.classList.add("pinned");
  const av = makeAvatar(a.profile, "member-avatar");
    const info = document.createElement("div");
    info.className = "member-info";
    const name = document.createElement("div");
    name.className = "member-name";
    name.textContent = a.profile.name || "Unknown";
    const last = document.createElement("div");
    last.className = "member-last";
    last.textContent = formatRelativeTime(new Date(a.lastSeenAt).toISOString());
  info.appendChild(name);
  info.appendChild(last);

  // Pin toggle — SVG icon, filled state when active.
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "member-pin" + (isPinned ? " on" : "");
  pin.innerHTML = isPinned ? ICON_PIN_ON : ICON_PIN_OFF;
  pin.title = isPinned
    ? `Unpin ${a.profile.name}`
    : `Pin ${a.profile.name} to the top of the Active rail`;
  pin.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePinUser(a.profile.id);
  });

  // Bell toggle — SVG icon, filled-ringing when watched, struck-through when off.
  const bell = document.createElement("button");
  bell.type = "button";
  bell.className = "member-bell" + (isWatched ? " on" : "");
  bell.innerHTML = isWatched ? ICON_BELL_ON : ICON_BELL_OFF;
  bell.title = isWatched
    ? `Disable alerts for ${a.profile.name}`
    : `Alert when ${a.profile.name} posts (only when tab is unfocused)`;
  bell.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWatchUser(a.profile.id, a.profile.name);
  });

  // Clicking the name (or avatar/info area) filters the stream.
  const nameClickable = document.createElement("div");
  nameClickable.className = "member-clickable";
  nameClickable.title = `Filter to ${a.profile.name}'s messages`;
  nameClickable.addEventListener("click", (e) => {
    e.preventDefault();
    if (a.profile.name) filterByAuthorName(a.profile.name);
  });
  nameClickable.appendChild(av);
  nameClickable.appendChild(info);

  li.appendChild(nameClickable);
  li.appendChild(pin);
  li.appendChild(bell);
  return li;
}

// ============================================================
// PER-USER ALERTS ("watch this person")
// ============================================================

function toggleWatchUser(userId, userName) {
  if (state.watchedUserIds.has(userId)) {
    state.watchedUserIds.delete(userId);
  } else {
    state.watchedUserIds.add(userId);
  }
  persistWatchedUsers();
  renderMembers();
}

function persistWatchedUsers() {
  try {
    chrome.storage &&
      chrome.storage.local &&
      chrome.storage.local.set({
        bssc_watched_users: Array.from(state.watchedUserIds),
      });
  } catch (_) {}
}

function restoreWatchedUsers() {
  try {
    chrome.storage &&
      chrome.storage.local &&
      chrome.storage.local.get(
        ["bssc_watched_users", "bssc_pinned_users", "bssc_member_sort"],
        (res) => {
          if (res) {
            state.watchedUserIds = new Set(res.bssc_watched_users || []);
            state.pinnedUserIds = new Set(res.bssc_pinned_users || []);
            if (res.bssc_member_sort === "name" || res.bssc_member_sort === "active") {
              state.memberSort = res.bssc_member_sort;
            }
          }
          renderMembers();
        }
      );
  } catch (_) {}
}

function togglePinUser(userId) {
  if (state.pinnedUserIds.has(userId)) {
    state.pinnedUserIds.delete(userId);
  } else {
    state.pinnedUserIds.add(userId);
  }
  persistMembersUiPrefs();
  renderMembers();
}

function persistMembersUiPrefs() {
  try {
    chrome.storage &&
      chrome.storage.local &&
      chrome.storage.local.set({
        bssc_pinned_users: Array.from(state.pinnedUserIds),
        bssc_member_sort: state.memberSort,
      });
  } catch (_) {}
}

// Called from pollNewMessages / handleChatEvent when a new comment arrives.
// Fires a chrome notification when:
//   - tab is hidden (background) AND
//   - the comment is from a watched user
function maybeAlertOnWatchedUser(comment) {
  if (!comment) return;
  if (!document.hidden) return; // only when user is away
  const uid = comment.user_id;
  if (uid == null || !state.watchedUserIds.has(uid)) return;
  const name = (comment.author && comment.author.name) || "Someone";
  const preview = (comment.body || "").slice(0, 200);
  try {
    chrome.runtime.sendMessage({
      type: "notify",
      title: `New from ${name}`,
      message: preview || "(message)",
      mentionRef: comment.id,
    });
  } catch (_) {}
}

function renderFooterStats() {
  // v0.1.26: live-mechanism string moved into the header status badge
  // (more prominent, with a colored dot). Footer now just shows counts.
  document.getElementById(
    "footerStats"
  ).textContent = `${state.comments.size} messages · ${state.authors.size} authors`;
}

// ============================================================
// SCROLLING
// ============================================================

function scrollToBottom() {
  const stream = document.getElementById("stream");
  stream.scrollTop = stream.scrollHeight;
  state.isAtBottom = true;
  hideNewMessageJump();
}

function showNewMessageJump() {
  const jump = document.getElementById("newMessageJump");
  jump.classList.remove("hidden");
  jump.querySelector(
    "button"
  ).textContent = `↓ ${state.pendingNewMessages} new message${state.pendingNewMessages > 1 ? "s" : ""}`;
}

function hideNewMessageJump() {
  state.pendingNewMessages = 0;
  document.getElementById("newMessageJump").classList.add("hidden");
}

// ============================================================
// SEARCH
// ============================================================

function applySearch() {
  const raw = state.searchQuery.trim();
  const q = raw.toLowerCase();

  // Reset all groups to default state.
  document.querySelectorAll(".msg-group").forEach((node) => {
    node.classList.remove("search-hit", "search-active", "search-hidden");
  });

  // Thread filter takes precedence — when active, hide every group whose
  // messages aren't either the thread parent or a direct reply.
  if (state.threadFilter) {
    applyThreadFilter();
    if (!q) {
      // No search query — just keep the thread filter intact.
      return;
    }
  }

  if (!q) {
    document.getElementById("searchCount").textContent = "";
    state.searchHits = [];
    return;
  }

  // Slash command syntax: /from:<name>, /me, /has:link, /has:image,
  // /has:reaction, /since:<iso-or-relative>, /help. Otherwise `@<name>` is
  // the author-prefix filter, anything else is full-text on body+author.
  const matcher = parseSearchQuery(raw);
  if (matcher.help) {
    showHelpOverlay();
    return;
  }

  const hits = [];
  const hitIds = new Set();
  for (const id of state.order) {
    const c = state.comments.get(id);
    if (!c) continue;
    if (matcher.test(c)) {
      hits.push(id);
      hitIds.add(id);
    }
  }
  state.searchHits = hits;

  // Filter: every group that contains at least one matching message is
  // shown + highlighted; every group with zero matches is HIDDEN.
  // When a thread filter is also active, INTERSECT — a group is shown
  // only if it's both in the thread AND matches the query. (Without
  // this, the text-search loop would overwrite the thread filter and
  // any out-of-thread match would become visible.)
  const threadParentId = state.threadFilter
    ? state.threadFilter.parentId
    : null;
  const threadMemberIds = threadParentId
    ? new Set([
        threadParentId,
        ...((state.threadIndex && state.threadIndex.get(threadParentId)) || []),
      ])
    : null;
  document.querySelectorAll(".msg-group").forEach((group) => {
    const ids = Array.from(group.querySelectorAll("[data-id]")).map(
      (n) => n.dataset.id
    );
    const groupHasHit = ids.some((id) => hitIds.has(id));
    const inThread =
      !threadMemberIds || ids.some((id) => threadMemberIds.has(id));
    if (groupHasHit && inThread) {
      group.classList.add("search-hit");
    } else {
      group.classList.add("search-hidden");
    }
  });

  const label = hits.length
    ? `${hits.length} ${matcher.kind} · Esc to clear`
    : `no ${matcher.kind} · Esc to clear`;
  document.getElementById("searchCount").textContent = label;
  if (hits.length) {
    state.searchActiveIdx = 0;
    focusSearchHit(0);
  }
}

// Parse the search input into a {kind, test, help?} object.
// v0.1.18: commands work with or without a leading `/` — the `:` in
// `has:image` / `from:elon` / `since:3` already makes the intent
// unambiguous, so `/` becomes optional sugar.
function parseSearchQuery(raw) {
  const lower = raw.toLowerCase();
  // Strip the optional leading slash for command matching, but keep `raw`
  // intact for @-prefix and plain-text fallbacks below.
  const cmd = lower.startsWith("/") ? lower.slice(1) : lower;

  if (cmd === "help" || cmd === "?") return { kind: "", help: true };

  if (cmd === "me") {
    const myId = state.user && state.user.id;
    return {
      kind: "from you",
      test: (c) => myId != null && c.user_id === myId,
    };
  }

  if (cmd.startsWith("from:")) {
    const name = cmd.slice(5).trim();
    if (!name) return { kind: "matches", test: () => false };
    return {
      kind: "from author",
      test: (c) =>
        ((c.author && c.author.name) || "").toLowerCase().startsWith(name),
    };
  }

  if (cmd === "has:link") {
    return {
      kind: "with link",
      test: (c) => /https?:\/\//i.test(c.body || ""),
    };
  }
  if (cmd === "has:image" || cmd === "has:img") {
    return {
      kind: "with image",
      test: (c) =>
        hasAttachment(c.media_uploads) ||
        hasAttachment(c.threadMediaUploads) ||
        hasAttachment(c.mediaAttachments) ||
        hasAttachment(c.attachments),
    };
  }
  if (cmd === "has:reaction") {
    return {
      kind: "with reaction",
      test: (c) =>
        c.reactions &&
        Object.values(c.reactions).some(
          (v) => (typeof v === "number" ? v : (v && v.count) || 0) > 0
        ),
    };
  }

  if (cmd.startsWith("since:")) {
    const arg = cmd.slice(6).trim();
    let sinceTs;
    if (/^\d+d?$/.test(arg)) {
      sinceTs = Date.now() - parseInt(arg, 10) * 86400_000;
    } else {
      sinceTs = new Date(arg).getTime();
    }
    if (isNaN(sinceTs)) {
      return { kind: "matches", test: () => false };
    }
    return {
      kind: "since " + arg,
      test: (c) => new Date(c.created_at).getTime() >= sinceTs,
    };
  }

  // @<name> — author name prefix
  if (raw.startsWith("@")) {
    const name = lower.slice(1);
    if (!name) return { kind: "matches", test: () => false };
    return {
      kind: "from author",
      test: (c) =>
        ((c.author && c.author.name) || "").toLowerCase().startsWith(name),
    };
  }

  // Default: full-text on body + author name (case-insensitive substring).
  return {
    kind: "matches",
    test: (c) => {
      const body = (c.body || "").toLowerCase();
      const name = ((c.author && c.author.name) || "").toLowerCase();
      return body.includes(lower) || name.includes(lower);
    },
  };
}

function hasAttachment(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

function showHelpOverlay() {
  const existing = document.querySelector(".help-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "help-overlay";
  const card = document.createElement("div");
  card.className = "help-card";
  card.innerHTML = `
    <h2>BetterSSC commands</h2>
    <dl>
      <dt>@elon</dt><dd>Show messages from authors whose name starts with "elon"</dd>
      <dt>/from:elon</dt><dd>Same as above</dd>
      <dt>/me</dt><dd>Show your own messages</dd>
      <dt>/has:link</dt><dd>Messages containing a URL</dd>
      <dt>/has:image</dt><dd>Messages with an image attachment</dd>
      <dt>/has:reaction</dt><dd>Messages that have ≥1 reaction</dd>
      <dt>/since:3</dt><dd>Messages from the last 3 days</dd>
      <dt>/since:2026-06-01</dt><dd>Messages on or after a date</dd>
      <dt>/help</dt><dd>This screen</dd>
    </dl>
    <h2 style="margin-top:18px">Keyboard</h2>
    <dl>
      <dt>/</dt><dd>Focus search</dd>
      <dt>Esc</dt><dd>Clear search / close overlay</dd>
      <dt>j / k</dt><dd>Next / previous message</dd>
      <dt>PageDn / PageUp</dt><dd>Full page down / up</dd>
      <dt>⌘D / ⌘U</dt><dd>Half page down / up (vim style)</dd>
      <dt>g</dt><dd>Jump to top (+ load older history)</dd>
      <dt>Shift+G</dt><dd>Jump to bottom (latest)</dd>
      <dt>n / Shift+N</dt><dd>Next / previous search match</dd>
      <dt>r</dt><dd>Refresh now (polls for new messages)</dd>
    </dl>
    <div class="close-hint">click anywhere or press Esc to close</div>
  `;
  overlay.appendChild(card);
  card.addEventListener("click", (e) => e.stopPropagation());
  overlay.addEventListener("click", () => {
    overlay.remove();
    const input = document.getElementById("searchInput");
    if (input.value === "/help") {
      input.value = "";
      state.searchQuery = "";
      applySearch();
    }
  });
  document.body.appendChild(overlay);
}

// ============================================================
// THREAD FILTER (click the 💬 badge on a message with replies)
// ============================================================

function openThreadFilter(parentId) {
  state.threadFilter = { parentId };
  // Clear any active search so the user sees just the thread.
  const input = document.getElementById("searchInput");
  if (input) {
    input.value = "";
    state.searchQuery = "";
  }
  renderThreadBanner();
  applySearch();
  // Scroll the parent message into view + flash it.
  setTimeout(() => jumpToMessage(parentId), 50);
}

function closeThreadFilter() {
  state.threadFilter = null;
  renderThreadBanner();
  document.querySelectorAll(".msg-group").forEach((node) => {
    node.classList.remove("search-hit", "search-active", "search-hidden");
  });
  applySearch();
  // Per user request: closing a thread should land at the latest message,
  // not stay at the thread parent position (which was usually mid-history).
  scrollToBottom();
}

function applyThreadFilter() {
  if (!state.threadFilter) return;
  const parentId = state.threadFilter.parentId;
  // Parent + every direct reply (threaded via parent_id OR quote via
  // quote_id). One level only — replies-of-replies are NOT included.
  const idsInThread = new Set([parentId]);
  const localRefs =
    state.threadIndex && state.threadIndex.get(parentId);
  if (localRefs) for (const id of localRefs) idsInThread.add(id);
  // Hide every group whose messages aren't in the thread.
  document.querySelectorAll(".msg-group").forEach((group) => {
    const ids = Array.from(group.querySelectorAll("[data-id]")).map(
      (n) => n.dataset.id
    );
    const inThread = ids.some((id) => idsInThread.has(id));
    if (!inThread) {
      group.classList.add("search-hidden");
    } else {
      group.classList.add("search-hit");
    }
  });
}

function renderThreadBanner() {
  let banner = document.getElementById("threadBanner");
  if (!state.threadFilter) {
    if (banner) banner.remove();
    return;
  }
  const parent = state.comments.get(state.threadFilter.parentId);
  const preview = parent
    ? `${(parent.author && parent.author.name) || "Unknown"}: ${(parent.body || "").slice(0, 60)}`
    : "thread";
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "threadBanner";
    banner.className = "thread-banner";
    const stream = document.getElementById("stream");
    if (stream) stream.prepend(banner);
  }
  banner.innerHTML = "";
  const label = document.createElement("span");
  label.className = "thread-banner-label";
  label.textContent = `💬 Thread: ${preview}`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "thread-banner-close";
  close.textContent = "× close";
  close.title = "Close thread (Esc)";
  close.addEventListener("click", closeThreadFilter);
  banner.appendChild(label);
  banner.appendChild(close);
}

// Set the search input to "@<name>" and apply — used by the click-author
// affordance.
function filterByAuthorName(name) {
  if (!name) return;
  const input = document.getElementById("searchInput");
  input.value = "@" + name;
  state.searchQuery = input.value;
  applySearch();
}

// Scroll to a specific message id and flash it. Used by the quote
// click-to-jump and notification-click handlers.
function jumpToMessage(id) {
  const node = document.querySelector(`[data-id="${cssEscape(id)}"]`);
  if (!node) {
    showError(
      "Original message isn't loaded yet. Scroll up to load older history first."
    );
    return;
  }
  const group = node.closest(".msg-group");
  // If the target is hidden by an active search filter, clear the search
  // first so the user can actually see what they jumped to.
  if (group && group.classList.contains("search-hidden")) {
    document.getElementById("searchInput").value = "";
    state.searchQuery = "";
    applySearch();
  }
  if (group) {
    group.classList.remove("highlight-flash");
    void group.offsetWidth;
    group.classList.add("highlight-flash");
    setTimeout(() => group.classList.remove("highlight-flash"), 2800);
  }
  node.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ============================================================
// TAB-TITLE UNREAD TRACKING
// ============================================================
// While the BetterSSC tab is hidden, count new messages from polling. On
// return-to-visible, reset. Title format: "(N) <pub> · BetterSSC".

let _baseTitle = "BetterSSC";
let _unreadWhileHidden = 0;

function updateBaseTitle() {
  const pub =
    (state.publication && state.publication.name) ||
    (state.publicationId ? `Publication ${state.publicationId}` : "Chat");
  _baseTitle = `${pub} · BetterSSC`;
  document.title = _unreadWhileHidden
    ? `(${_unreadWhileHidden}) ${_baseTitle}`
    : _baseTitle;
}

function incrementUnreadWhileHidden(n) {
  if (!document.hidden) return;
  _unreadWhileHidden += n;
  document.title = `(${_unreadWhileHidden}) ${_baseTitle}`;
}

function resetUnreadWhileHidden() {
  _unreadWhileHidden = 0;
  document.title = _baseTitle;
}

function focusSearchHit(idx) {
  const id = state.searchHits[idx];
  if (!id) return;
  const node = document.querySelector(`[data-id="${cssEscape(id)}"]`);
  if (!node) return;
  document
    .querySelectorAll(".msg-group.search-active")
    .forEach((n) => n.classList.remove("search-active"));
  const groupNode = node.closest(".msg-group");
  if (groupNode) groupNode.classList.add("search-active");
  node.scrollIntoView({ behavior: "smooth", block: "center" });
}

const cssEscape = (s) =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"');

// ============================================================
// EVENT WIRING
// ============================================================

// ============================================================
// VI NAVIGATION
// ============================================================

let _viActiveId = null;
let _lastGKeyTime = 0;

function getVisibleGroups() {
  return Array.from(
    document.querySelectorAll(".msg-group:not(.search-hidden)")
  );
}

function setActiveGroup(group, opts = {}) {
  document
    .querySelectorAll(".msg-group.vi-active")
    .forEach((n) => n.classList.remove("vi-active"));
  if (!group) return;
  group.classList.add("vi-active");
  _viActiveId = group.dataset.firstId || null;
  if (opts.skipScroll) return;
  group.scrollIntoView({
    behavior: "smooth",
    block: opts.block || "center",
  });
}

function moveActive(direction) {
  const groups = getVisibleGroups();
  if (!groups.length) return;
  const currentIdx = groups.findIndex((g) => g.classList.contains("vi-active"));
  let nextIdx;
  if (currentIdx === -1) {
    nextIdx = direction > 0 ? 0 : groups.length - 1;
  } else {
    nextIdx = Math.min(
      groups.length - 1,
      Math.max(0, currentIdx + direction)
    );
  }
  setActiveGroup(groups[nextIdx]);
}

function handleGKey() {
  const now = Date.now();
  if (now - _lastGKeyTime < 500) {
    jumpToStreamEdge("top");
    _lastGKeyTime = 0;
  } else {
    _lastGKeyTime = now;
  }
}

async function jumpToStreamEdge(edge) {
  const groups = getVisibleGroups();
  if (!groups.length) return;
  const stream = document.getElementById("stream");
  if (edge === "top") {
    // Mark the current first-visible group, but don't let setActiveGroup
    // auto-center it (that's what was making `g` land in the middle of the
    // viewport instead of scrolling to the actual top).
    setActiveGroup(groups[0], { skipScroll: true });
    // Pull in older history if available, THEN scroll to absolute top.
    if (state.moreBefore) await loadOlder();
    if (stream) stream.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    setActiveGroup(groups[groups.length - 1], { skipScroll: true });
    if (stream)
      stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
  }
}

// Scroll the stream by a fraction of the viewport. amount=1 is one full
// page; 0.5 is half. If we're already near the top, also kick off
// loadOlder() so the user can keep paging up into history.
async function manualRefresh(btn) {
  if (btn) {
    btn.classList.remove("spinning");
    void btn.offsetWidth; // restart animation
    btn.classList.add("spinning");
    setTimeout(() => btn.classList.remove("spinning"), 600);
  }
  try {
    await pollNewMessages();
  } catch (_) {}
}

function pageScroll(amount) {
  const stream = document.getElementById("stream");
  if (!stream) return;
  const delta = stream.clientHeight * amount;
  stream.scrollBy({ top: delta, behavior: "smooth" });
  if (amount < 0 && stream.scrollTop < 400) loadOlder();
}

function cycleSearchHit(direction) {
  if (!state.searchHits.length) return;
  state.searchActiveIdx =
    (state.searchActiveIdx + direction + state.searchHits.length) %
    state.searchHits.length;
  focusSearchHit(state.searchActiveIdx);
}

// ============================================================
// THEME
// ============================================================

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "☀" : "☾";
  try {
    chrome.storage &&
      chrome.storage.local &&
      chrome.storage.local.set({ bssc_theme: theme });
  } catch (_) {}
}

function toggleTheme() {
  // Light is default in v0.1.15. Toggle behavior: light→dark→light.
  const current =
    document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "light" ? "dark" : "light");
}

// ============================================================

function bindEventHandlers() {
  const stream = document.getElementById("stream");
  stream.addEventListener(
    "scroll",
    throttle(() => {
      const nearBottom =
        stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
      state.isAtBottom = nearBottom;
      if (nearBottom) hideNewMessageJump();
      if (stream.scrollTop < 200) loadOlder();
    }, 100)
  );

  document.getElementById("newMessageJump").addEventListener("click", () => {
    scrollToBottom();
  });

  const searchInput = document.getElementById("searchInput");
  searchInput.addEventListener(
    "input",
    debounce((e) => {
      state.searchQuery = e.target.value || "";
      applySearch();
    }, 120)
  );

  document.addEventListener("keydown", (e) => {
    const inInput =
      document.activeElement === searchInput ||
      (document.activeElement &&
        document.activeElement.tagName === "TEXTAREA");

    // Escape — clear active overlays, then thread filter, then search.
    // v0.1.27: works from anywhere, not just when focused in the search box.
    if (e.key === "Escape") {
      const overlay = document.querySelector(".help-overlay, .lightbox");
      if (overlay) {
        overlay.remove();
        return;
      }
      if (state.threadFilter) {
        closeThreadFilter();
        return;
      }
      if (searchInput && searchInput.value) {
        searchInput.value = "";
        state.searchQuery = "";
        applySearch();
        if (document.activeElement === searchInput) searchInput.blur();
        return;
      }
      // Nothing to clear — make sure the input isn't focused after Esc
      // in case the user wants to start fresh with j/k navigation.
      if (document.activeElement === searchInput) searchInput.blur();
      return;
    }

    if (e.key === "/" && !inInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    // Vi navigation — gated to not interfere with typing.
    if (inInput) return;

    if (e.key === "j") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "k") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "g") {
      e.preventDefault();
      jumpToStreamEdge("top");
    } else if (e.key === "G") {
      e.preventDefault();
      jumpToStreamEdge("bottom");
    } else if (e.key === "PageUp") {
      e.preventDefault();
      pageScroll(-1.0);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      pageScroll(1.0);
    } else if (e.key === "u" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      pageScroll(-0.5);
    } else if (e.key === "d" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      pageScroll(0.5);
    } else if (e.key === "n") {
      e.preventDefault();
      cycleSearchHit(1);
    } else if (e.key === "N") {
      e.preventDefault();
      cycleSearchHit(-1);
    } else if (e.key === "?") {
      e.preventDefault();
      showHelpOverlay();
    } else if (e.key === "r") {
      e.preventDefault();
      manualRefresh(document.getElementById("refreshNow"));
    }
  });

  // Theme toggle.
  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", toggleTheme);
    try {
      chrome.storage &&
        chrome.storage.local &&
        chrome.storage.local.get(["bssc_theme"], (res) => {
          const stored = res && res.bssc_theme;
          if (stored === "light" || stored === "dark") applyTheme(stored);
        });
    } catch (_) {}
  }

  // "Latest" button — jump to the most recent message at any time.
  const latestBtn = document.getElementById("goLatest");
  if (latestBtn) {
    latestBtn.addEventListener("click", () => {
      const input = document.getElementById("searchInput");
      if (input && input.value) {
        input.value = "";
        state.searchQuery = "";
        applySearch();
      }
      scrollToBottom();
    });
  }

  // Manual refresh button — triggers an immediate poll. Spins briefly.
  const refreshBtn = document.getElementById("refreshNow");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      manualRefresh(refreshBtn);
    });
  }

  // Background can send us "focusMessage" when a notification is clicked.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    // Defense in depth: only accept messages from our own extension.
    if (!sender || sender.id !== chrome.runtime.id) return;
    if (msg && msg.type === "focusMessage" && msg.messageId) {
      resetUnreadMentions();
      const node = document.querySelector(
        `[data-id="${cssEscape(msg.messageId)}"]`
      );
      if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  window.addEventListener("focus", resetUnreadMentions);

  // Poll immediately when tab becomes visible again (covers the period
  // when document.hidden suppressed scheduled polls).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      resetUnreadWhileHidden();
      pollNewMessages();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (state.ws) state.ws.close();
    if (_pollTimer) clearInterval(_pollTimer);
    if (_markViewedTimer) clearInterval(_markViewedTimer);
  });
}

// ============================================================
// ERROR
// ============================================================

function showError(msg) {
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = msg;
  document.body.prepend(banner);
  setTimeout(() => banner.remove(), 8000);
}

// ============================================================
// COMPOSER (v0.2 write side)
// ============================================================
//
// Everything below this line is the v0.2 write-side wiring. It is appended
// to the END of app.js (not interleaved with v0.1 paths) on purpose: Track
// B is refactoring renderMessages in parallel, and any v0.2 edits up there
// would cause merge conflicts. State additions live under `state.composer`.

import {
  autoGrowTextarea,
  buildCommentBody,
  buildPendingComment,
  reconcilePending,
  markPendingFailed,
  findActiveMentionToken,
  replaceMentionToken,
} from "./lib/compose.js";
import {
  postComment as apiPostComment,
  fetchMentionSuggestions as apiFetchMentions,
} from "./lib/api.js";
import { uuid as composerUuid, debounce as composerDebounce } from "./lib/util.js";

// Composer-scoped state. Kept namespaced so it doesn't collide with any v0.1
// state path. Initialized lazily on first mount so a missing #composer (e.g.
// the landing screen) is a no-op.
state.composer = state.composer || {
  pending: null,         // outgoing send in flight (commit 2)
  mentions: {},          // @name → { user_id, text } map for the buffer
  replyingTo: null,      // {id, authorName, body} when replying (commit 6)
};

function mountComposer() {
  const composer = document.getElementById("composer");
  if (!composer) return;
  const input = document.getElementById("composerInput");
  const sendBtn = document.getElementById("composerSend");
  if (!input || !sendBtn) return;

  // Enable / disable the Send button based on input contents + in-flight.
  const refreshSendBtn = () => {
    const txt = input.value || "";
    const empty = txt.trim().length === 0;
    sendBtn.disabled = empty || !!state.composer.pending;
  };

  // Auto-grow on input, with the 4-line cap declared in CSS (max-height: 96px,
  // which matches lineHeight 22 * 4 = 88 + a bit of padding).
  input.addEventListener("input", () => {
    autoGrowTextarea(input, { lineHeight: 22, maxRows: 4 });
    // Typing dismisses the error state, restoring the "Send" affordance.
    if (state.composer._lastError) {
      clearComposerError();
      sendBtn.textContent = "Send";
    }
    refreshSendBtn();
    // Commit 4: mention autocomplete trigger.
    onMentionInput(input);
  });

  // Enter sends, Shift+Enter inserts a newline. We DON'T preventDefault on
  // Shift+Enter — the browser handles it natively. Arrow keys + Enter +
  // Esc are intercepted when the mention dropdown is active.
  input.addEventListener("keydown", (e) => {
    if (handleMentionKeydown(e, input)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitComposer();
    }
  });

  sendBtn.addEventListener("click", (e) => {
    e.preventDefault();
    submitComposer();
  });

  // Set initial height so the textarea starts at exactly one row.
  autoGrowTextarea(input, { lineHeight: 22, maxRows: 4 });
  refreshSendBtn();

  // Expose so submitComposer() can re-check after state changes.
  state.composer._refreshSendBtn = refreshSendBtn;
}

// ============================================================
// MENTION AUTOCOMPLETE (commit 4)
// ============================================================
//
// Composer-scoped mention dropdown. Driven by findActiveMentionToken on
// every input event — when the user's caret is inside a `@<query>` token
// we debounce-fetch suggestions from /api/v1/community/mention and render
// them in #composerMention. Arrow keys + Enter pick one; Esc closes.

state.composer._mention = state.composer._mention || {
  open: false,
  token: null,       // active token { query, start, end }
  results: [],
  activeIdx: 0,
  lastQuery: null,
};

const _fetchMentionsDebounced = composerDebounce(async (query, input) => {
  const m = state.composer._mention;
  if (!m.open) return;
  // Stale-query guard — only render the response if the user is still on
  // the same query they were when we fired.
  m.lastQuery = query;
  try {
    const res = await apiFetchMentions(
      state.publicationId,
      state.postUuid,
      query
    );
    if (m.lastQuery !== query || !m.open) return;
    const results = (res && res.results) || [];
    m.results = results;
    m.activeIdx = 0;
    renderMentionDropdown(input);
  } catch (e) {
    if (m.lastQuery !== query || !m.open) return;
    m.results = [];
    renderMentionDropdown(input);
  }
}, 300);

function onMentionInput(input) {
  const m = state.composer._mention;
  const value = input.value || "";
  const cursor = input.selectionStart;
  const token = findActiveMentionToken(value, cursor);
  if (!token) {
    closeMentionDropdown();
    return;
  }
  m.open = true;
  m.token = token;
  // Show the dropdown immediately (with a "typing…" hint while we debounce)
  // so the user has visual feedback they're in a mention context.
  if (!m.results.length) renderMentionDropdown(input);
  _fetchMentionsDebounced(token.query, input);
}

function renderMentionDropdown(input) {
  const m = state.composer._mention;
  const dropdown = document.getElementById("composerMention");
  if (!dropdown) return;
  if (!m.open) {
    dropdown.classList.add("hidden");
    dropdown.replaceChildren();
    return;
  }
  dropdown.classList.remove("hidden");
  dropdown.replaceChildren();
  if (!m.results.length) {
    const empty = document.createElement("div");
    empty.className = "composer-mention-empty";
    empty.textContent = m.lastQuery == null ? "Loading…" : "No matches.";
    dropdown.appendChild(empty);
    return;
  }
  m.results.forEach((u, idx) => {
    const item = document.createElement("div");
    item.className = "composer-mention-item";
    if (idx === m.activeIdx) item.classList.add("is-active");
    item.setAttribute("role", "option");
    item.dataset.idx = String(idx);
    const av = document.createElement("img");
    av.className = "composer-mention-avatar";
    av.alt = "";
    av.referrerPolicy = "no-referrer";
    if (u.photo_url) av.src = u.photo_url;
    item.appendChild(av);
    const name = document.createElement("span");
    name.className = "composer-mention-name";
    name.textContent = u.name || u.handle || `User ${u.user_id}`;
    item.appendChild(name);
    if (u.handle && u.handle !== u.name) {
      const handle = document.createElement("span");
      handle.className = "composer-mention-handle";
      handle.textContent = "@" + u.handle;
      item.appendChild(handle);
    }
    item.addEventListener("mousedown", (e) => {
      // mousedown so the textarea doesn't lose focus before we re-insert.
      e.preventDefault();
      selectMentionFromDropdown(input, idx);
    });
    dropdown.appendChild(item);
  });
}

function handleMentionKeydown(e, input) {
  const m = state.composer._mention;
  if (!m.open) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    closeMentionDropdown();
    return true;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (m.results.length) {
      m.activeIdx = (m.activeIdx + 1) % m.results.length;
      renderMentionDropdown(input);
    }
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (m.results.length) {
      m.activeIdx =
        (m.activeIdx - 1 + m.results.length) % m.results.length;
      renderMentionDropdown(input);
    }
    return true;
  }
  if ((e.key === "Enter" || e.key === "Tab") && m.results.length) {
    e.preventDefault();
    selectMentionFromDropdown(input, m.activeIdx);
    return true;
  }
  return false;
}

function selectMentionFromDropdown(input, idx) {
  const m = state.composer._mention;
  const user = m.results[idx];
  if (!user || !m.token) {
    closeMentionDropdown();
    return;
  }
  const displayName = user.name || user.handle || `User ${user.user_id}`;
  const { text, cursor } = replaceMentionToken(
    input.value || "",
    m.token,
    displayName
  );
  input.value = text;
  // Track the mention so buildCommentBody can convert it into a ${N} slot
  // at send time. Key is the literal token we inserted (`@<name>`).
  state.composer.mentions["@" + displayName] = {
    user_id: user.user_id,
    text: "@" + displayName,
  };
  closeMentionDropdown();
  // Restore the caret position to just after the inserted token + space.
  try {
    input.focus();
    input.setSelectionRange(cursor, cursor);
  } catch (_) {}
  autoGrowTextarea(input, { lineHeight: 22, maxRows: 4 });
  if (state.composer._refreshSendBtn) state.composer._refreshSendBtn();
}

function closeMentionDropdown() {
  const m = state.composer._mention;
  m.open = false;
  m.token = null;
  m.results = [];
  m.activeIdx = 0;
  m.lastQuery = null;
  const dropdown = document.getElementById("composerMention");
  if (dropdown) {
    dropdown.classList.add("hidden");
    dropdown.replaceChildren();
  }
}

async function submitComposer() {
  const input = document.getElementById("composerInput");
  const sendBtn = document.getElementById("composerSend");
  if (!input || !sendBtn) return;
  const text = (input.value || "").trim();
  if (!text) return;
  if (state.composer.pending) return; // already in flight
  if (!state.postUuid) {
    showComposerError("No chat post loaded — refresh and try again.");
    return;
  }

  const rawText = input.value;
  const sendingMentions = { ...state.composer.mentions };
  const { body, mentions } = buildCommentBody(rawText, sendingMentions);
  const clientId = composerUuid();

  // OPTIMISTIC: insert into the store and render IMMEDIATELY so the user
  // sees their message land without the 12s poll delay.
  const pending = buildPendingComment(clientId, state.user, body, mentions);
  state.comments.set(clientId, pending);
  insertInOrder(pending);
  renderAll();
  if (state.isAtBottom) scrollToBottom();

  // Clear the composer right away. If the send fails, the message stays in
  // the stream with a Retry button — we don't make the user re-type. The
  // text is preserved on the failed comment itself (via pending.body).
  input.value = "";
  state.composer.mentions = {};
  autoGrowTextarea(input, { lineHeight: 22, maxRows: 4 });

  // Loading state on the button.
  state.composer.pending = { id: clientId, text: rawText };
  sendBtn.classList.add("is-sending");
  sendBtn.classList.remove("is-error");
  sendBtn.textContent = "Sending…";
  sendBtn.disabled = true;
  clearComposerError();

  try {
    const res = await apiPostComment(state.postUuid, {
      id: clientId,
      body,
      mentions,
    });
    // Try to reconcile from the response itself. If we can find the freshly
    // created comment in the post payload, splice it into the stream right
    // away so we don't have to wait for the next poll cycle.
    const freshly = extractFreshComment(res, clientId, state.user);
    if (freshly) {
      reconcilePending(
        { comments: state.comments, order: state.order },
        freshly
      );
      renderAll();
    } else {
      // Fall back to a poll — ingestComment will overwrite the pending row
      // if the server preserved our client id, or we'll have a duplicate
      // (rare on Substack; their dedup honors client ids).
      try {
        await pollNewMessages();
      } catch (_) {}
    }
  } catch (e) {
    // Mark the optimistic message as failed in-place. The user can either
    // hit the Retry button on the message OR the Retry button next to the
    // composer (which re-sends the same text).
    markPendingFailed(
      { comments: state.comments, order: state.order },
      clientId,
      (e && e.message) || "Send failed"
    );
    renderAll();
    showComposerError(
      "Send failed: " + (e && e.message ? e.message : "unknown error") +
        " — click the message to retry."
    );
    state.composer._lastError = true;
    state.composer._lastFailedId = clientId;
  } finally {
    state.composer.pending = null;
    sendBtn.classList.remove("is-sending");
    if (!state.composer._lastError) {
      sendBtn.textContent = "Send";
    } else {
      sendBtn.classList.add("is-error");
      sendBtn.textContent = "Retry";
    }
    if (state.composer._refreshSendBtn) state.composer._refreshSendBtn();
    if (state.composer._lastError) sendBtn.disabled = false;
  }
}

// Walk a postComment response trying to find the just-created comment with
// our client id. Substack's response shape is `{post: {...}}` — the
// updated post object often (but not always) includes a `recent_comments`
// or similar list with the new comment at the tail. Best-effort.
function extractFreshComment(res, clientId, user) {
  if (!res || typeof res !== "object") return null;
  const candidates = [];
  const push = (x) => {
    if (!x) return;
    if (Array.isArray(x)) for (const it of x) push(it);
    else if (x.comment) candidates.push(unwrapComment(x) || x.comment);
    else if (x.body && x.id) candidates.push(x);
  };
  // Try every shape we've seen in the wild.
  push(res.comment);
  push(res.new_comment);
  push(res.replies);
  if (res.post) {
    push(res.post.recent_comments);
    push(res.post.replies);
    push(res.post.comment);
  }
  // Pick the comment whose id matches our client id (preferred), else the
  // most recent comment by this user (fallback).
  for (const c of candidates) {
    if (c && String(c.id) === String(clientId)) return c;
  }
  if (user && user.id != null) {
    let best = null;
    let bestT = 0;
    for (const c of candidates) {
      if (!c) continue;
      const uid = c.user_id ?? (c.author && c.author.id);
      if (uid !== user.id) continue;
      const t = new Date(c.created_at || 0).getTime() || 0;
      if (t >= bestT) {
        bestT = t;
        best = c;
      }
    }
    if (best) return best;
  }
  return null;
}

// After every render, decorate pending/failed messages with their state-
// specific UI. We do this as a post-render pass instead of editing the
// (frozen-for-track-B) renderMessageItem path.
function decoratePendingMessages() {
  const container = document.getElementById("messages");
  if (!container) return;
  for (const id of state.order) {
    const c = state.comments.get(id);
    if (!c) continue;
    if (!c._pending && !c._failed) continue;
    const node = container.querySelector(
      `.msg-item[data-id="${cssEscape(String(id))}"]`
    );
    if (!node) continue;
    if (c._pending) {
      node.classList.add("_pending");
    } else {
      node.classList.remove("_pending");
    }
    if (c._failed) {
      node.classList.add("_failed");
      // Add a retry bar if not already there.
      if (!node.querySelector(".msg-failed-bar")) {
        const bar = document.createElement("div");
        bar.className = "msg-failed-bar";
        const label = document.createElement("span");
        label.textContent = "Send failed.";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "msg-failed-retry";
        retry.textContent = "Retry";
        retry.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          retryFailedMessage(id);
        });
        bar.appendChild(label);
        bar.appendChild(retry);
        node.appendChild(bar);
      }
    } else {
      node.classList.remove("_failed");
    }
  }
}

async function retryFailedMessage(clientId) {
  const c = state.comments.get(clientId);
  if (!c || !c._failed) return;
  // Flip back to pending.
  c._failed = false;
  c._pending = true;
  c._error = null;
  renderAll();
  try {
    const res = await apiPostComment(state.postUuid, {
      id: clientId,
      body: c.body,
      mentions: c.mentions || {},
    });
    const freshly = extractFreshComment(res, clientId, state.user);
    if (freshly) {
      reconcilePending(
        { comments: state.comments, order: state.order },
        freshly
      );
    } else {
      // The reconciler will run again on the next poll if needed.
      c._pending = false;
    }
    renderAll();
  } catch (e) {
    markPendingFailed(
      { comments: state.comments, order: state.order },
      clientId,
      (e && e.message) || "Send failed"
    );
    renderAll();
  }
}

// Hook the post-render decorator. We patch renderAll once at mount time:
// every call routes through the original first, then runs our decorator.
let _renderAllPatched = false;
function patchRenderAllForComposer() {
  if (_renderAllPatched) return;
  _renderAllPatched = true;
  const orig = renderAll;
  // We can't reassign the top-level `renderAll` reference (it's a function
  // declaration), but we CAN wrap the post-render hook by monkey-patching
  // `renderMessages` instead — it's the one renderAll calls after the
  // ingest path settles. Subclasses below override window-level hook.
  // Simpler: just listen for the messages container to update via a
  // MutationObserver. Lightweight and unaware of internal render structure.
  const container = document.getElementById("messages");
  if (!container) return;
  const observer = new MutationObserver(() => {
    try {
      decoratePendingMessages();
    } catch (e) {
      console.warn("[BetterSSC] decorate failed:", e);
    }
  });
  observer.observe(container, { childList: true });
  // Run once immediately so any initial pending rows pick up styling.
  decoratePendingMessages();
  // Reference orig so the linter doesn't complain about unused vars.
  void orig;
}

function showComposerError(msg) {
  const composer = document.getElementById("composer");
  if (!composer) return;
  let err = document.getElementById("composerError");
  if (!err) {
    err = document.createElement("div");
    err.id = "composerError";
    err.className = "composer-error";
    composer.appendChild(err);
  }
  err.textContent = msg;
}

function clearComposerError() {
  const err = document.getElementById("composerError");
  if (err) err.remove();
  state.composer._lastError = false;
  const sendBtn = document.getElementById("composerSend");
  if (sendBtn) sendBtn.classList.remove("is-error");
}

// Mount when the app is visible. If we're on the landing screen, #composer
// doesn't exist and mountComposer is a no-op. If we're in the app, calling
// it here happens AFTER bindEventHandlers — fine, the composer's own
// listeners are scoped to its own elements.
if (typeof appEl !== "undefined" && appEl && !appEl.classList.contains("hidden")) {
  mountComposer();
  patchRenderAllForComposer();
}
