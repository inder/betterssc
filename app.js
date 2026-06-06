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

  // Initial comments.
  await loadInitial();
  // Mark as viewed.
  scheduleMarkViewed();
  // Open WebSocket.
  await connectRealtime();
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
              return {
                id: cfg.user.id,
                name: cfg.user.name,
                email: cfg.user.email,
                anonymousId: cfg.anonymousId,
              };
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
    document.getElementById("postTitle").textContent =
      (res.post && res.post.communityPost && res.post.communityPost.body
        ? res.post.communityPost.body.slice(0, 80)
        : "");
    const replies = (res.replies || []).slice();
    // The asc endpoint returns oldest first by name, but verify and sort
    // defensively.
    replies.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    for (const c of replies) ingestComment(c, { silent: true });
    state.moreBefore = res.moreBefore !== false;
    if (replies.length) {
      state.earliestISO = replies[0].created_at;
    }
    renderAll();
    scrollToBottom();
  } catch (e) {
    showError(`Failed to load chat: ${e.message}`);
  }
}

async function loadOlder() {
  if (state.loadingHistory || !state.moreBefore || !state.earliestISO) return;
  state.loadingHistory = true;
  document.getElementById("historyLoading").style.display = "block";
  const prevScrollHeight = document.getElementById("stream").scrollHeight;
  const prevScrollTop = document.getElementById("stream").scrollTop;
  try {
    const res = await fetchCommentsBefore(state.postUuid, state.earliestISO);
    const replies = (res.replies || []).slice();
    replies.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    let count = 0;
    for (const c of replies) {
      if (!state.comments.has(c.id)) {
        ingestComment(c, { silent: true });
        count++;
      }
    }
    if (replies.length) {
      state.earliestISO = replies[0].created_at;
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
    document.getElementById("historyLoading").style.display = "none";
  }
}

function ingestComment(c, { silent = false } = {}) {
  if (!c || !c.id) return;
  const isNew = !state.comments.has(c.id);
  state.comments.set(c.id, c);
  if (isNew) {
    insertInOrder(c);
  } else {
    // already present — order doesn't change for edits
  }
  // Track author seen-at.
  if (c.author && c.author.id) {
    const prev = state.authors.get(c.author.id);
    const t = new Date(c.created_at).getTime();
    if (!prev || prev.lastSeenAt < t) {
      state.authors.set(c.author.id, { profile: c.author, lastSeenAt: t });
    }
  }
  // Notification check on truly new live messages.
  if (isNew && !silent) {
    maybeNotifyMention({ comment: c, user: state.user, settings: {} });
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
  // First fetch a probe token to discover channel permissions.
  let probe;
  try {
    probe = await fetchRealtimeToken([
      `user:${state.user ? state.user.id : "0"}`,
      `chat:${state.publicationId}:all_subscribers`,
      `chat:${state.publicationId}:only_paid`,
      `chat:${state.publicationId}:only_founding`,
    ]);
  } catch (e) {
    setWsStatus("error");
    showError(`Realtime token fetch failed: ${e.message}`);
    return;
  }

  // From the granted permissions list, pick all subscribe-allowed channels.
  const chatChannels = detectChatChannels(probe, state.publicationId);
  const channels = [];
  if (state.user) channels.push(`user:${state.user.id}`);
  channels.push(...chatChannels);
  if (!channels.length) {
    showError(
      "No accessible chat channels for this publication. Are you a subscriber?"
    );
    setWsStatus("error");
    return;
  }

  state.ws = new SubstackRealtime({
    channels,
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

const scheduleMarkViewed = () => {
  markViewed();
  setInterval(() => {
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
  // Reuse existing nodes when count matches; simplest correct: replace.
  // Performance optimization deferred (virtualized list in v0.2).
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    frag.appendChild(renderGroup(g));
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

  // Quote preview if reply.
  if (c.quote && (c.quote.body || c.quote.author)) {
    const q = document.createElement("div");
    q.className = "msg-quote";
    const qAuthor = document.createElement("div");
    qAuthor.className = "msg-quote-author";
    qAuthor.textContent = c.quote.author?.name || "Reply";
    const qBody = document.createElement("div");
    qBody.className = "msg-quote-body";
    qBody.textContent = (c.quote.body || "").slice(0, 200);
    q.appendChild(qAuthor);
    q.appendChild(qBody);
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

  // Reactions row.
  if (c.reactions && Object.keys(c.reactions).length) {
    const reactionsEl = document.createElement("div");
    reactionsEl.className = "msg-reactions";
    for (const [reactionType, info] of Object.entries(c.reactions)) {
      const pill = document.createElement("span");
      pill.className = "msg-reaction";
      pill.appendChild(document.createTextNode(reactionEmojiFor(reactionType)));
      const count = document.createElement("span");
      count.className = "msg-reaction-count";
      count.textContent = String((info && info.count) || 0);
      pill.appendChild(count);
      reactionsEl.appendChild(pill);
    }
    wrap.appendChild(reactionsEl);
  }

  return wrap;
}

// Minimal emoji map for the most common reaction names. Substack ships
// hundreds; missing ones render as the underscore name.
const REACTION_EMOJI = {
  thumbs_up: "👍",
  upvote: "👍",
  face_with_tears_of_joy: "😂",
  rolling_on_the_floor_laughing: "🤣",
  double_exclamation_mark: "‼️",
  hundred_points: "💯",
  folded_hands: "🙏",
  rocket: "🚀",
  broken_heart: "💔",
  thinking_face: "🤔",
  clapping_hands: "👏",
  cowboy_hat_face: "🤠",
  bear: "🐻",
  ox: "🐂",
  waving_hand: "👋",
  raised_hand: "✋",
  raising_hands: "🙌",
  party_popper: "🎉",
  smiling_face_with_sunglasses: "😎",
  eyes: "👀",
  smiling_face_with_heart_eyes: "😍",
  smirking_face: "😏",
  star_struck: "🤩",
  sparkles: "✨",
  red_question_mark: "❓",
  fire: "🔥",
  grinning_face: "😀",
  grinning_face_with_big_eyes: "😃",
  grinning_face_with_smiling_eyes: "😄",
  beaming_face_with_smiling_eyes: "😁",
  grinning_squinting_face: "😆",
  grinning_face_with_sweat: "😅",
  slightly_smiling_face: "🙂",
  upside_down_face: "🙃",
  melting_face: "🫠",
  red_heart: "❤️",
};
const reactionEmojiFor = (name) => REACTION_EMOJI[name] || `:${name}:`;

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
    li.title = a.profile.name;
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
  // Highlight matching groups; show count.
  const q = state.searchQuery.trim().toLowerCase();
  const hits = [];
  document.querySelectorAll(".msg-group").forEach((node) => {
    node.classList.remove("search-hit", "search-active");
  });
  if (!q) {
    document.getElementById("searchCount").textContent = "";
    state.searchHits = [];
    return;
  }
  // Linear scan; v0.1 acceptable up to a few thousand messages.
  for (const id of state.order) {
    const c = state.comments.get(id);
    if (!c) continue;
    const body = (c.body || "").toLowerCase();
    const author = (c.author && c.author.name) || "";
    if (body.includes(q) || author.toLowerCase().includes(q)) {
      hits.push(id);
    }
  }
  state.searchHits = hits;
  // Mark all hit groups.
  for (const id of hits) {
    const groupNode = document.querySelector(
      `.msg-group [data-id="${cssEscape(id)}"]`
    );
    if (groupNode) {
      groupNode.closest(".msg-group").classList.add("search-hit");
    }
  }
  document.getElementById("searchCount").textContent = `${hits.length} match${
    hits.length !== 1 ? "es" : ""
  }`;
  if (hits.length) {
    state.searchActiveIdx = 0;
    focusSearchHit(0);
  }
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
    if (e.key === "/" && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = "";
      state.searchQuery = "";
      applySearch();
      searchInput.blur();
    }
  });

  // Background can send us "focusMessage" when a notification is clicked.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "focusMessage" && msg.messageId) {
      resetUnreadMentions();
      const node = document.querySelector(
        `[data-id="${cssEscape(msg.messageId)}"]`
      );
      if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  window.addEventListener("focus", resetUnreadMentions);

  window.addEventListener("beforeunload", () => {
    if (state.ws) state.ws.close();
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
