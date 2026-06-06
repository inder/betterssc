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
  // Open WebSocket (best-effort — protocol issues, see below).
  await connectRealtime();
  // Start polling fallback for live updates. WS is unreliable in v0.1
  // (Substack's protocol rejects our subscribe frames with Invalid message
  // for reasons we haven't pinned down). Polling matches what Substack's
  // own native client does anyway (~10s interval with ?after=<ISO>).
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
    const replies = (res && res.replies) || [];
    if (!replies.length) return;
    const before = state.comments.size;
    for (const r of replies) ingestComment(r);
    const added = state.comments.size - before;
    if (added > 0) {
      renderAll();
      incrementUnreadWhileHidden(added);
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
    const unwrappedReplies = (res.replies || [])
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
    // Same unwrap fix as loadInitial.
    const unwrappedReplies = (res.replies || [])
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
    if (!prev || prev.lastSeenAt < t) {
      state.authors.set(unwrapped.author.id, {
        profile: unwrapped.author,
        lastSeenAt: t,
      });
    }
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
  el.querySelector(".dot").className = `dot dot-${s}`;
  el.querySelector(".ws-label").textContent = s;
  el.title = `WebSocket: ${s}`;
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
  renderMessages();
  renderMembers();
  renderFooterStats();
  if (state.searchQuery) applySearch();
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

  // Avatar
  const avatar = document.createElement(group.author?.photo_url ? "img" : "div");
  avatar.className = "msg-avatar";
  if (group.author?.photo_url) {
    avatar.src = group.author.photo_url;
    avatar.alt = group.author.name || "";
  } else {
    avatar.classList.add("msg-avatar-placeholder");
    avatar.textContent = (group.author?.name || "?").charAt(0).toUpperCase();
  }
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
      const img = document.createElement("img");
      img.className = "msg-attachment-img";
      img.src = url;
      img.alt = (raw && (raw.alt || raw.filename || raw.name)) || "image";
      img.loading = "lazy";
      img.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(url);
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
  const arr = Array.from(state.authors.values()).sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt
  );
  const frag = document.createDocumentFragment();
  for (const a of arr.slice(0, 80)) {
    const li = document.createElement("li");
    li.className = "member";
    li.dataset.userId = String(a.profile.id);
    li.title = `Filter to ${a.profile.name}'s messages`;
    li.addEventListener("click", (e) => {
      e.preventDefault();
      if (a.profile.name) filterByAuthorName(a.profile.name);
    });
    const av = document.createElement(a.profile.photo_url ? "img" : "div");
    av.className = "member-avatar";
    if (a.profile.photo_url) {
      av.src = a.profile.photo_url;
      av.alt = a.profile.name;
    } else {
      av.textContent = (a.profile.name || "?").charAt(0).toUpperCase();
    }
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
    li.appendChild(av);
    li.appendChild(info);
    frag.appendChild(li);
  }
  list.replaceChildren(frag);
}

function renderFooterStats() {
  const wsStateText =
    state.wsStatus === "connected" ? "ws+poll" : "poll only";
  document.getElementById(
    "footerStats"
  ).textContent = `${state.comments.size} messages · ${state.authors.size} authors · live: ${wsStateText}`;
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
  // shown + highlighted; every group with zero matches is HIDDEN. This
  // matches the natural intent of "I typed @Jordan — show me Jordan's
  // messages, not all messages with Jordan highlighted."
  document.querySelectorAll(".msg-group").forEach((group) => {
    const ids = Array.from(group.querySelectorAll("[data-id]")).map(
      (n) => n.dataset.id
    );
    const groupHasHit = ids.some((id) => hitIds.has(id));
    if (groupHasHit) {
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
function parseSearchQuery(raw) {
  const lower = raw.toLowerCase();
  if (lower === "/help" || lower === "/?") return { kind: "", help: true };

  // /me — current user's own messages
  if (lower === "/me") {
    const myId = state.user && state.user.id;
    return {
      kind: "from you",
      test: (c) => myId != null && c.user_id === myId,
    };
  }

  // /from:<name>
  if (lower.startsWith("/from:")) {
    const name = lower.slice(6).trim();
    if (!name) return { kind: "matches", test: () => false };
    return {
      kind: "from author",
      test: (c) =>
        ((c.author && c.author.name) || "").toLowerCase().startsWith(name),
    };
  }

  // /has:link, /has:image, /has:reaction
  if (lower === "/has:link") {
    return {
      kind: "with link",
      test: (c) => /https?:\/\//i.test(c.body || ""),
    };
  }
  if (lower === "/has:image" || lower === "/has:img") {
    return {
      kind: "with image",
      test: (c) =>
        hasAttachment(c.media_uploads) ||
        hasAttachment(c.threadMediaUploads) ||
        hasAttachment(c.mediaAttachments) ||
        hasAttachment(c.attachments),
    };
  }
  if (lower === "/has:reaction") {
    return {
      kind: "with reaction",
      test: (c) =>
        c.reactions &&
        Object.values(c.reactions).some(
          (v) => (typeof v === "number" ? v : (v && v.count) || 0) > 0
        ),
    };
  }

  // /since:<iso-or-relative-day-count>
  if (lower.startsWith("/since:")) {
    const arg = lower.slice(7).trim();
    let sinceTs;
    if (/^\d+d?$/.test(arg)) {
      // bare number = N days ago
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
      <dt>@boz</dt><dd>Show messages from authors whose name starts with "boz"</dd>
      <dt>/from:boz</dt><dd>Same as above</dd>
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
      <dt>g g</dt><dd>Jump to top</dd>
      <dt>Shift+G</dt><dd>Jump to bottom</dd>
      <dt>n / Shift+N</dt><dd>Next / previous search match</dd>
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

function setActiveGroup(group) {
  document
    .querySelectorAll(".msg-group.vi-active")
    .forEach((n) => n.classList.remove("vi-active"));
  if (!group) return;
  group.classList.add("vi-active");
  _viActiveId = group.dataset.firstId || null;
  group.scrollIntoView({ behavior: "smooth", block: "center" });
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

function jumpToStreamEdge(edge) {
  const groups = getVisibleGroups();
  if (!groups.length) return;
  const target = edge === "top" ? groups[0] : groups[groups.length - 1];
  setActiveGroup(target);
  if (edge === "top") loadOlder();
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
  const current = document.documentElement.getAttribute("data-theme") || "dark";
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

    // Escape — clear active overlays then input.
    if (e.key === "Escape") {
      const overlay = document.querySelector(".help-overlay, .lightbox");
      if (overlay) {
        overlay.remove();
        return;
      }
      if (document.activeElement === searchInput) {
        searchInput.value = "";
        state.searchQuery = "";
        applySearch();
        searchInput.blur();
      }
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
      handleGKey();
    } else if (e.key === "G") {
      e.preventDefault();
      jumpToStreamEdge("bottom");
    } else if (e.key === "n") {
      e.preventDefault();
      cycleSearchHit(1);
    } else if (e.key === "N") {
      e.preventDefault();
      cycleSearchHit(-1);
    } else if (e.key === "?") {
      e.preventDefault();
      showHelpOverlay();
    } else if (e.key === "t" && (e.ctrlKey || e.metaKey)) {
      // Cmd/Ctrl+T would normally open a new tab — only intercept if alt'd.
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
      // Clear any active filter so the jump actually lands at the newest msg.
      const input = document.getElementById("searchInput");
      if (input && input.value) {
        input.value = "";
        state.searchQuery = "";
        applySearch();
      }
      scrollToBottom();
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
