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
  fetchUserProfile,
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
  chatNameAcronym,
  PREFETCH_BASE_DELAY_MS,
  PREFETCH_SLOT_POLL_MS,
  PREFETCH_PILL_VISIBLE_MS,
  PREFETCH_PILL_REMOVE_MS,
  computeRetryDelay,
} from "./lib/util.js";
import {
  maybeNotifyMention,
  resetUnreadMentions,
  incrementUnreadMentions,
} from "./lib/notify.js";
import { reactionEmojiFor } from "./lib/emojis.js";
import {
  PROVIDERS,
  callProvider,
  MODEL_CATALOG,
  getModelInfo,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_OPTIONS,
  supportsWebSearch,
  VISION_IMAGE_TYPES,
} from "./lib/ai-providers.js";
import {
  formatMessagesForLLM,
  buildSystemPrompt,
  buildPreviewUserMessage,
  buildAskSystemPrompt,
  buildAskUserMessage,
  parseAskSections,
  collectThreadForExplain,
  segmentExplainGroups,
  buildExplainSystemPrompt,
  buildExplainUserMessage,
  ASK_DEFAULT_BUDGET_CHARS,
  DEFAULT_LENS_HINT,
  DEFAULT_FORMAT_TEMPLATE,
} from "./lib/ai-context.js";
import {
  commentMatchesFocus,
  isFocusEmpty,
  buildFocusFilter,
  splitTerms,
} from "./lib/focus.js";
import { extractTrending } from "./lib/trending.js";

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

// Header notify-all-messages toggle uses bigger 18px versions of the same icons.
const ICON_BELL_ON_LG = `<svg viewBox="0 0 24 24" width="18" height="18"
  fill="currentColor" aria-hidden="true">
  <path d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22z"/>
  <path d="M18 16v-5a6 6 0 0 0-5-5.91V4a1 1 0 0 0-2 0v1.09A6 6 0 0 0 6 11v5l-2
    2v1h16v-1z"/>
</svg>`;

const ICON_BELL_OFF_LG = `<svg viewBox="0 0 24 24" width="18" height="18"
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
  // Background full-history prefetch — kicks off after loadInitial
  // completes, sequentially walks older pages until moreBefore=false or
  // user disables it via Chat preferences. ON by default. Persisted as
  // bssc_auto_load_all. bgPrefetchActive guards re-entry; bgPrefetchStop
  // is the cancel flag the toggle flips mid-run. bgPrefetchDone latches
  // once the prefetch completes so we never re-kick it within a session.
  autoLoadAll: true,
  bgPrefetchActive: false,
  bgPrefetchStop: false,
  bgPrefetchDone: false,
  // Set true across the smooth-scroll window inside pageUpWithFocus so
  // the scroll handler doesn't fire loadOlder mid-animation and yank
  // scrollTop — that's the cancellation bug we kept hitting on `g`.
  suppressScrollLoadOlder: false,
  earliestISO: null,
  ws: null,
  wsStatus: "idle",
  searchQuery: "",
  searchHits: [], // ordered list of comment ids matching query
  searchActiveIdx: 0,
  isAtBottom: true,
  pendingNewMessages: 0,
  // New messages that arrived while a filter was active AND don't
  // match the filter. Surfaced in the pill's secondary "elsewhere"
  // suffix so the user can see off-filter activity without losing
  // their filter context. Always 0 when no filter is active.
  pendingNewMessagesOffFilter: 0,
  watchedUserIds: new Set(),
  pinnedUserIds: new Set(),
  memberSort: "active", // "active" (most messages) or "name"
  threadFilter: null, // { parentId } when user clicked a 💬 thread icon
  // Focus mode — { terms: string[], userIds: string[] } | null. When set,
  // the feed hides every message group that doesn't match the terms/people,
  // INCLUDING ancestor-walk (a reply to a matching message passes). See
  // lib/focus.js. _focusMemo caches per-comment verdicts for one filter
  // generation; cleared whenever focusFilter changes (appends keep it valid
  // since new messages are leaves, never ancestors of older cached rows).
  focusFilter: null,
  _focusMemo: null,
  notifyAllMessages: false, // header bell toggle — alert on every new msg
  consecutivePollFailures: 0, // resets to 0 on success; banner shows at >=2
  proxyDisconnected: false,
  // AI Insights — see "AI INSIGHTS" section below. BYOK: chat content
  // goes browser → provider with the user's own API key. Never proxied.
  aiProvider: null, // "openai" | "anthropic" | "google" | null
  aiKeys: {}, // {openai?: string, anthropic?: string, google?: string}
  aiBusy: false,
  // Output token cap for summary mode. null = use provider default (2048).
  // Persisted as bssc_ai_max_tokens. Tune dialog offers 1024 / 2048 / 4096.
  aiMaxTokens: null,
  // Ask mode runs concurrently with summary mode — separate busy flag so
  // they don't disable each other's buttons. Commit 5 adds tunable Ask
  // output cap + web-search toggle; for now we use generous defaults.
  aiAskBusy: false,
  aiAskMaxTokens: null, // commit 5 wires the Tune dialog row
  aiAskWebSearch: null, // commit 5; null = default-on at call site
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
    try {
      console.log("[BetterSSC identity] " + JSON.stringify(state.user));
    } catch (_) {
      console.log("[BetterSSC identity]", state.user);
    }
    ensureSelfDefaults();
  } catch (_) {}
  // If we got id+name but no photo_url AND we know the handle, hit
  // the public profile endpoint. Skip when handle is missing: Substack's
  // path requires <id>-<handle> and substituting "self" returns 404.
  // (We catch the photo via state.comments scan in getResolvedSelf
  //  once the user has any message in the loaded window.)
  if (
    state.user &&
    state.user.id != null &&
    state.user.handle &&
    !state.user.photo_url
  ) {
    try {
      const profile = await fetchUserProfile(state.user.id, state.user.handle);
      const userObj = profile && (profile.user || profile);
      const photo =
        userObj &&
        (userObj.photo_url ||
          userObj.photoUrl ||
          userObj.profile_image_url ||
          userObj.avatar_url ||
          null);
      if (photo) {
        state.user.photo_url = photo;
        console.log("[BetterSSC identity] profile photo resolved");
      }
    } catch (e) {
      console.warn("[BetterSSC identity] profile fetch failed:", e && e.message);
    }
  }

  // Load the publication header for chrome.
  try {
    const pubRes = await fetchPublication(state.publicationId);
    state.publication = pubRes && pubRes.pub;
  } catch (_) {}

  // Reflect into the header (renderChatHeader handles pub avatar +
  // user avatar + collapsible body panel; loadInitial calls it again
  // once state.post is populated).
  renderChatHeader();
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

// "User is away" — fires alerts when EITHER the tab is hidden in its own
// window OR the window/app is not focused. document.hidden alone misses
// the case where you switched to another browser window or another app
// (Slack, Terminal, etc.) — the tab is still the active one in its window
// so document.hidden stays false. That was the v0.2-A live bug: alerts
// never fired even after switching tabs because the BetterSSC tab was in
// a different window than the one being focused.
function isUserAway() {
  return document.hidden || !document.hasFocus();
}

async function pollNewMessages() {
  if (_pollInflight) return;
  // Keep polling even when the tab is hidden — otherwise we'd never
  // see new messages while the user is away, which means no alerts.
  // Chrome will throttle hidden-tab timers, but the polls still go
  // through eventually (within ~minutes).
  const since = getNewestCommentISO();
  if (!since) return;
  _pollInflight = true;
  try {
    const res = await fetchCommentsAfter(state.postUuid, since);
    // Successful poll → reset failure counter + clear "can't reach
    // Substack" banner if it was up. Done BEFORE the rest of the
    // ingest path so a downstream render exception doesn't strand
    // the banner.
    if (state.consecutivePollFailures > 0 || state.proxyDisconnected) {
      state.consecutivePollFailures = 0;
      state.proxyDisconnected = false;
      renderProxyBanner();
    }
    // Feed any user objects from the new payload into _userTable so
    // photo upgrades land + already-rendered placeholder avatars get
    // repainted on the next tick.
    if (res) {
      if (Array.isArray(res.users)) registerUserObjects(res.users);
      if (Array.isArray(res.recent_commenters))
        registerUserObjects(res.recent_commenters);
    }
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
      // For each new comment pick at most ONE alert in priority order:
      // reply-to-me → watched-user. (@mentions fire separately from
      // ingestComment, so a reply that also @mentions you fires both —
      // acceptable since both signals are important.)
      for (const c of newlyAdded) {
        if (maybeAlertOnReplyToMe(c)) continue;
        maybeAlertOnWatchedUser(c);
      }
      // Fire a single batched alert if "notify on all messages" is on,
      // using a stable id per chat post so subsequent polls REPLACE the
      // previous notification instead of stacking.
      maybeAlertAllMessages(newlyAdded);
      if (state.isAtBottom) {
        scrollToBottom();
      } else {
        // Bucket each new comment by whether it matches the active
        // filter. The pill's main count is filter-matching; the
        // "elsewhere" suffix carries the rest. When no filter is
        // active, every new message matches, so off-filter stays 0.
        for (const c of newlyAdded) {
          if (commentMatchesActiveFilter(c)) {
            state.pendingNewMessages++;
          } else {
            state.pendingNewMessagesOffFilter++;
          }
        }
        showNewMessageJump();
      }
    }
  } catch (e) {
    console.warn("[BetterSSC POLL] failed:", e && e.message);
    state.consecutivePollFailures += 1;
    // Two consecutive failures (~24s) is enough signal that the
    // substack proxy tab is gone or unreachable. Show the banner so
    // the user knows what's wrong instead of silently failing.
    if (state.consecutivePollFailures >= 2 && !state.proxyDisconnected) {
      state.proxyDisconnected = true;
      renderProxyBanner();
    }
  } finally {
    _pollInflight = false;
  }
}

function getNewestCommentISO() {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const c = state.comments.get(state.order[i]);
    // AI messages are local-only synthetic rows — skip them so the poll
    // cursor stays anchored to real Substack-side timestamps. Otherwise
    // a fresh AI message would advance the cursor past any unloaded
    // real messages.
    if (c && c.created_at && !c._aiGenerated) return c.created_at;
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
              // Capture id, name, AND photo_url so the top-right avatar
              // can render even before any comments are ingested. Email
              // / anonymousId are PII we don't use; not caching them.
              const u = cfg.user;
              return {
                id: u.id,
                name: u.name,
                handle: u.handle || u.username || null,
                photo_url:
                  u.photo_url ||
                  u.photoUrl ||
                  u.profile_image_url ||
                  u.avatar_url ||
                  null,
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

    state.post = (res.post && res.post.communityPost) || null;
    // First render with what we have now.
    renderChatHeader();
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
    // Re-render the header now that comments have populated _userTable
    // — the user's own photo_url usually lands via a comment from them,
    // and the post author's avatar may also have been upgraded.
    renderChatHeader();
    scrollToBottom();
    // Background-prefetch the rest of the chat history so `g` is
    // instant from here on. Fire-and-forget: runChatBgPrefetch handles
    // its own errors, pacing, and rate-limit backoff. Toggle in kebab
    // → Chat preferences. Default ON.
    void runChatBgPrefetch();
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
    // Older-history payload also carries user objects — feed them in
    // so scrolling up repaints stuck placeholder avatars too.
    if (res) {
      if (Array.isArray(res.users)) registerUserObjects(res.users);
      if (Array.isArray(res.recent_commenters))
        registerUserObjects(res.recent_commenters);
    }
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
    // Termination follows the API's moreBefore + whether THIS page
    // returned any rows at all — NOT the local dedup count. With bg
    // prefetch running, a user-`g` post-completion will routinely fetch
    // pages whose rows are all already in state.comments (count=0); if
    // we drove moreBefore off `count > 0`, that single user `g` would
    // permanently latch moreBefore=false and silently disable `g` for
    // the rest of the session.
    state.moreBefore = res.moreBefore !== false && unwrappedReplies.length > 0;
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

// ============================================================
// BACKGROUND CHAT PREFETCH
// ============================================================
//
// Once loadInitial settles, we silently walk older pages until the
// API says we're out (moreBefore=false) or the user disables it via
// the Chat preferences toggle. The point is to make `g` (scroll-up
// history) feel instant on dense chats: every page is already in
// state.comments, so `g` just re-renders from memory instead of
// stuttering on each network round trip.
//
// Key design choices that keep this clean:
// - Reuses the existing pagination cursor (state.earliestISO) and
//   the existing fetchCommentsBefore / ingestComment plumbing.
//   No parallel data path.
// - Calls renderAll() exactly ONCE per session — at completion. While
//   prefetching, ingestComment runs with {silent: true} so the feed
//   never reflows mid-read. The user's scroll position stays put.
// - Waits for state.loadingHistory to clear before each fetch, so a
//   user-initiated `g` always wins the slot. `g` and the bg loop never
//   issue overlapping requests against the same cursor.
// - Dedupe is automatic via the existing state.comments.has() guard
//   in loadOlder + bgPrefetchOnePage — if `g` already grabbed a page
//   the bg loop would have hit, count comes back 0 and the loop ends.
// - 429 backoff via the pure computeRetryDelay helper. Three attempts
//   max, then we give up silently — this is best-effort prefetch, not
//   load-bearing UX. A failed prefetch just means `g` is slower for
//   that user, which is the prior behavior anyway.

// Wait until state.loadingHistory clears, polling at a slow cadence so
// the user's `g` keypress has full priority. Returns when the slot is
// free OR when bgPrefetchStop flips (user disabled the toggle mid-run).
function waitForHistorySlot() {
  return new Promise((resolve) => {
    const tick = () => {
      if (state.bgPrefetchStop) return resolve();
      if (!state.loadingHistory) return resolve();
      setTimeout(tick, PREFETCH_SLOT_POLL_MS);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch one page older silently — no DOM touch, no renderAll, no scroll
// adjustment. Returns { count, more, rateLimited } so the orchestrator
// can decide what to do next. Throws only on network/programmer errors;
// rate limits come back as { rateLimited: true } so the loop can back
// off without unwinding.
//
// MUTEX: we hold state.loadingHistory across the fetch + ingest the
// same way loadOlder does. Without it, a user-`g` keypress mid-fetch
// would read the SAME stale earliestISO and issue a duplicate request
// against the same cursor — waitForHistorySlot is one-way priority,
// not mutual exclusion, unless both ends acquire the lock.
async function bgPrefetchOnePage() {
  if (!state.earliestISO) return { count: 0, more: false, rateLimited: false };
  if (state.loadingHistory) {
    // Defensive — should not happen because runChatBgPrefetch awaits
    // waitForHistorySlot() before calling us, but a misuse from
    // elsewhere should fail open rather than silently double-fetch.
    // Surface to console so a real recurrence is visible (the
    // orchestrator would otherwise busy-loop calling us at slot-poll
    // speed since waitForHistorySlot was already awaited above the
    // call site).
    console.warn("[BetterSSC] bgPrefetchOnePage called while loadingHistory is true; skipping");
    return { count: 0, more: true, rateLimited: false };
  }
  state.loadingHistory = true;
  let res;
  try {
    try {
      res = await fetchCommentsBefore(state.postUuid, state.earliestISO);
    } catch (e) {
      // The proxy fetch wrapper in lib/api.js throws Error messages of
      // the form "<status> on <path> — <body>". Anchor on the leading
      // status code with /^429\b/ so we both (a) skip the false-positive
      // case where "429" appears in the path / body and (b) catch the
      // real case where Substack returns 429 with arbitrary body text.
      if (e && typeof e.message === "string" && /^429\b/.test(e.message)) {
        return { count: 0, more: true, rateLimited: true };
      }
      throw e;
    }
    if (res) {
      if (Array.isArray(res.users)) registerUserObjects(res.users);
      if (Array.isArray(res.recent_commenters))
        registerUserObjects(res.recent_commenters);
    }
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
    // Termination is driven by the API's moreBefore signal and whether
    // we got any rows at all — NOT by dedup count. Tying termination to
    // count > 0 would prematurely set moreBefore=false on an empty-but-
    // not-final page, permanently disabling user-initiated `g` for the
    // rest of the session.
    const more = res.moreBefore !== false && unwrappedReplies.length > 0;
    return { count, more, rateLimited: false };
  } finally {
    state.loadingHistory = false;
  }
}

// Top-level orchestrator. Idempotent across the session: bgPrefetchDone
// latches once we complete, so a stray re-call (e.g. from a future
// retry mechanism) doesn't re-walk pages that are already in state.
async function runChatBgPrefetch() {
  if (state.bgPrefetchActive || state.bgPrefetchDone) return;
  if (!state.autoLoadAll) return;
  if (!state.moreBefore || !state.earliestISO) {
    state.bgPrefetchDone = true;
    return;
  }
  state.bgPrefetchActive = true;
  state.bgPrefetchStop = false;
  const startSize = state.comments.size;
  let totalLoaded = 0;
  let retryDelay = null;
  try {
    while (state.moreBefore && !state.bgPrefetchStop) {
      await waitForHistorySlot();
      if (state.bgPrefetchStop) break;
      let result;
      try {
        result = await bgPrefetchOnePage();
      } catch (e) {
        console.warn("[BetterSSC] bg prefetch aborted:", e && e.message);
        break;
      }
      if (result.rateLimited) {
        const nextDelay = computeRetryDelay(retryDelay);
        if (nextDelay == null) {
          console.warn("[BetterSSC] bg prefetch hit 429 ceiling; giving up");
          break;
        }
        retryDelay = nextDelay;
        await sleep(nextDelay);
        continue;
      }
      retryDelay = null; // reset on success
      totalLoaded += result.count;
      state.moreBefore = result.more;
      // Live counter: the footer's "N messages · M authors" indicator
      // refreshes after each page so the user can watch the chat fill
      // up in real time. Cheap — single textContent write, no chat-feed
      // reflow. The feed itself stays silent (renderMessages doesn't
      // fire until completion's renderAll).
      renderFooterStats();
      if (!result.more) break;
      await sleep(PREFETCH_BASE_DELAY_MS);
    }
  } finally {
    state.bgPrefetchActive = false;
    // Only latch as "done for this session" if we completed naturally
    // (moreBefore=false, 429-give-up, or fetch-error). A user-stop
    // mid-run MUST NOT latch — otherwise re-enabling via the Chat
    // preferences toggle within the same session would treat the
    // partial prefetch as final and never resume the remaining pages.
    if (!state.bgPrefetchStop) {
      state.bgPrefetchDone = true;
    }
    if (totalLoaded > 0 && !state.bgPrefetchStop) {
      // Big-bang reveal: renderAll rebuilds the message DOM with all
      // silently-ingested rows. The browser preserves scrollTop (the
      // pixel value) but scrollHeight just grew dramatically, so a
      // user who was anchored at the bottom of the 25-message initial
      // render is now visually somewhere mid-chat. state.isAtBottom
      // also stays stale because the scroll handler only fires on
      // user-initiated scroll, not on programmatic DOM changes. We
      // honor the user's pre-reveal intent: if they were at the
      // bottom, snap to the NEW bottom; otherwise preserve their
      // visible content (the loadOlder pattern) and re-evaluate the
      // at-bottom tracker so the "↓ Latest" pill surfaces immediately
      // instead of waiting for the user to scroll a few pixels first.
      const stream = document.getElementById("stream");
      const wasAtBottom = state.isAtBottom;
      const prevScrollHeight = stream ? stream.scrollHeight : 0;
      const prevScrollTop = stream ? stream.scrollTop : 0;
      renderAll();
      if (stream) {
        if (wasAtBottom) {
          scrollToBottom();
        } else {
          stream.scrollTop =
            prevScrollTop + (stream.scrollHeight - prevScrollHeight);
          const nearBottom =
            stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
          state.isAtBottom = nearBottom;
          if (nearBottom) hideNewMessageJump();
          else showNewMessageJump();
        }
      }
      // The delta is how many net-new rows appeared in state.comments
      // (post-dedup), which is what the user actually sees added to the
      // feed. totalLoaded is the dedup count from the loop — they agree
      // when nothing else mutated state.comments mid-run, but the size
      // delta is the more honest "how big did the chat just get" figure.
      const delta = state.comments.size - startSize;
      showBgPrefetchPill(delta);
    }
  }
}

// Completion pill that lives INSIDE the .stream sticky-bottom zone
// right next to the "↓ Latest" button. Reads "+N loaded" so it pairs
// naturally with Latest when the user is scrolled up at completion
// time. We don't create the node on the fly — it's a permanent #stream
// child marked .hidden so the same sticky layout machinery that holds
// .new-message-jump in place handles the prefetch pill for free.
//
// Timer IDs are stored on the DOM node so a second completion landing
// inside the lifetime window (or a manual teardown) can cancel the
// pending fade/remove timers. Otherwise the prior call's timers would
// fire on a still-attached element that the caller had already reset,
// flipping the pill state back to hidden mid-flash.
function showBgPrefetchPill(delta) {
  // No-op on zero delta — "✓ +0 loaded" is a confusing success signal,
  // and the only path that produces it is an empty completion (no rows
  // were ever fetched). The user gains nothing from seeing the pill.
  if (!delta || delta <= 0) return;
  const pill = document.getElementById("bgPrefetchPill");
  if (!pill) return;
  if (pill._fadeTimer) clearTimeout(pill._fadeTimer);
  if (pill._removeTimer) clearTimeout(pill._removeTimer);
  pill.classList.remove("is-leaving");
  pill.classList.remove("hidden");
  pill.textContent = `✓ +${delta.toLocaleString()} loaded`;
  pill.title = `Background prefetch loaded ${delta.toLocaleString()} older message${delta === 1 ? "" : "s"}`;
  pill._fadeTimer = setTimeout(
    () => pill.classList.add("is-leaving"),
    PREFETCH_PILL_VISIBLE_MS
  );
  pill._removeTimer = setTimeout(() => {
    pill.classList.add("hidden");
    pill.classList.remove("is-leaving");
  }, PREFETCH_PILL_REMOVE_MS);
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
const _avatarMissLogged = new Set(); // diagnostic: one log per user_id

function registerUserObjects(arr) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  // Track ids whose photo_url just upgraded from null → real. Used by
  // refreshAvatarsForUsers to repaint already-rendered .msg-group
  // avatars whose original render baked in a letter placeholder.
  const photoUpgradedIds = [];
  for (const u of arr) {
    if (!u) continue;
    const id = u.id ?? u.user_id;
    if (id == null) continue;
    const existing = _userTable.get(id);
    if (!existing) {
      _userTable.set(id, {
        id,
        name: u.name || u.handle || `User ${id}`,
        handle: u.handle || null,
        photo_url: u.photo_url || null,
      });
      n++;
    } else {
      // Upgrade null fields when a later payload provides them. Avatars
      // in particular tend to be missing from `recent_commenters` but
      // present once we hit the user's own messages.
      let upgraded = false;
      if (!existing.photo_url && u.photo_url) {
        existing.photo_url = u.photo_url;
        upgraded = true;
        photoUpgradedIds.push(id);
      }
      if (!existing.handle && u.handle) {
        existing.handle = u.handle;
        upgraded = true;
      }
      if (
        u.name &&
        (existing.name === `User ${id}` || !existing.name)
      ) {
        existing.name = u.name;
        upgraded = true;
      }
      if (upgraded) n++;
    }
  }
  if (photoUpgradedIds.length) {
    // Defer so the caller's render pass (if any) finishes first.
    setTimeout(() => refreshAvatarsForUsers(photoUpgradedIds), 0);
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
  // Feed the comment's author into _userTable so its photo_url (when
  // present) triggers upgrade + repaint of placeholder avatars. The
  // WS chat:new-comment events come through this path too, so live
  // pushes contribute to avatar healing in real time.
  if (unwrapped.author && (unwrapped.author.id != null || unwrapped.author.user_id != null)) {
    registerUserObjects([unwrapped.author]);
    // Avatar-miss diagnostic was here. Confirmed via live dump
    // (commit a2a64fb logs) that Substack sends photo_url: null
    // for users who never set a profile photo — Vandy, Nicho,
    // Jp, Blair, PKR, V J, Kyle, Bernelius, tcy908, Chris, JD,
    // jrock452. Native Substack UI renders them as letter
    // placeholders too. Not a bug; we're rendering correctly.
  }

  const isNew = !state.comments.has(id);
  // Carry forward client-only ✦ Explain markers across poll/WS re-ingests.
  // A poll response re-parses every visible comment into a fresh server
  // shape that carries none of our _explain* fields; without this the
  // inline explanation (or an in-flight pending placeholder) silently
  // vanishes the next time the message is re-ingested. Mirrors the
  // pending-row carry-forward discipline in reconcilePending.
  if (!isNew) {
    const prevComment = state.comments.get(id);
    if (prevComment) {
      for (const k of [
        "_explain",
        "_explainPending",
        "_explainError",
        "_explainCitations",
        "_explainContextInfo",
        "_explainProvider",
        "_explainGroupItems",
      ]) {
        if (k in prevComment) unwrapped[k] = prevComment[k];
      }
    }
  }
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
    const wasNew = !state.comments.has(ev.comment.id);
    ingestComment(ev.comment, { silent: false });
    renderAll();
    // Mirror the polling-path alert fan-out so notifications fire when
    // WS is the live mechanism. Previously only @mention alerts fired
    // here (via ingestComment → maybeNotifyMention); reply-to-me,
    // watched-user, and notify-all-messages alerts were silently
    // skipped whenever WS was connected.
    if (wasNew) {
      const c = state.comments.get(ev.comment.id);
      if (c) {
        if (!maybeAlertOnReplyToMe(c)) {
          maybeAlertOnWatchedUser(c);
        }
        maybeAlertAllMessages([c]);
        if (isUserAway()) incrementUnreadWhileHidden(1);
      }
    }
    if (state.isAtBottom) {
      scrollToBottom();
    } else {
      const c = state.comments.get(ev.comment.id);
      if (c && commentMatchesActiveFilter(c)) {
        state.pendingNewMessages++;
      } else if (c) {
        state.pendingNewMessagesOffFilter++;
      }
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
  // The label text used to render next to the dot in the header but
  // was removed in v0.2.4 to reclaim header width. The full status
  // still lands in the title attribute so hovering the dot reveals
  // the current mechanism (matches the ws-second-capitulation memory:
  // mechanism + indicator must move together — the title attribute
  // IS the indicator now).
  const labelEl = el.querySelector(".ws-label");
  if (labelEl) labelEl.textContent = label;
  el.title = `${title} · ${label}`;
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
  // Re-render the header so the top-right user avatar can pick up the
  // user's own photo once it lands via a new comment (state.user.photo_url
  // is null when analytics-config doesn't carry it; getResolvedSelf scans
  // state.comments to find it).
  renderChatHeader();
  renderProxyBanner();
  renderTicker();
  if (state.searchQuery || state.threadFilter || !isFocusEmpty(state.focusFilter))
    applySearch();
}

// ============================================================
// ROLLING TICKER BAR
// ============================================================
// A CNBC/Bloomberg-style strip under the header. Shows what the chat is
// talking about RIGHT NOW — trending stock tickers, @mentioned people, and
// topic keywords — scrolling right→left. Click a chip to search the chat
// for it. Ticker chips carry a recent price pulled (via the background
// service worker, to bypass CORS) from Yahoo Finance.
//
// "Price updates when the symbol re-appears on the right" is honored as:
// a per-symbol TTL price cache refreshed once per marquee loop
// (animationiteration) plus a slow safety timer — so a symbol that keeps
// scrolling past gets a fresh price every few seconds, without hammering
// the endpoint or coupling network I/O to pixel geometry.

const TICKER_WINDOW_MS = 2 * 60 * 60 * 1000; // how far back "trending" looks (2h)
const TICKER_PRICE_TTL_MS = 20_000; // re-fetch a symbol's price after this
const TICKER_SPEED_PX_S = 55; // constant scroll speed, px/sec
const TICKER_MAX_ITEMS = 24;
const TICKER_REFRESH_TIMER_MS = 12_000; // safety re-check of stale prices

const _tickerPrices = new Map(); // SYM → {price, change, changePct, currency, asOf}
const _tickerPriceInflight = new Set();
let _tickerSig = ""; // signature of the current chip set (skip needless rebuilds)
let _tickerSymbols = []; // unique ticker symbols currently in the bar
let _tickerRefreshTimer = null;
let _tickerAnim = null; // the running CSSAnimation (for hover deceleration)
let _tickerRampRAF = null; // in-flight playbackRate ramp

function renderTicker() {
  const bar = document.getElementById("tickerBar");
  const track = document.getElementById("tickerTrack");
  if (!bar || !track) return;

  // Gather only the comments inside the trending window — walk state.order
  // (sorted oldest→newest) backward and stop once we cross the cutoff, so
  // extraction cost is bounded by the window, not total history size.
  const now = Date.now();
  const cutoff = now - TICKER_WINDOW_MS;
  const recent = [];
  for (let i = state.order.length - 1; i >= 0; i--) {
    const c = state.comments.get(state.order[i]);
    if (!c) continue;
    const t = new Date(c.created_at).getTime();
    if (Number.isFinite(t) && t < cutoff) break;
    recent.push(c);
  }

  const items = extractTrending(recent, {
    now,
    windowMs: TICKER_WINDOW_MS,
    maxItems: TICKER_MAX_ITEMS,
  });

  if (!items.length) {
    bar.classList.add("hidden");
    _tickerSig = "";
    track.innerHTML = "";
    stopTickerRefreshTimer();
    return;
  }

  bar.classList.remove("hidden");
  _tickerSymbols = items
    .filter((it) => it.kind === "ticker")
    .map((it) => it.symbol);

  // Only rebuild the DOM when the chip SET changes — otherwise every 12s
  // poll would reset the scroll animation to the start (visible stutter).
  const sig = items.map((it) => it.kind + ":" + it.label).join("|");
  if (sig !== _tickerSig) {
    _tickerSig = sig;
    buildTickerTrack(track, items);
    startTickerRefreshTimer();
  }
  // Always (re)paint prices into the existing chips — a poll may land after
  // a price refresh resolved.
  paintTickerPrices();
  // Kick a refresh for any ticker whose price is missing or stale.
  refreshStaleTickerPrices();
}

// Build one chip element for a trending item.
function buildTickerChip(item) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "ticker-chip";
  chip.dataset.term = item.term;
  chip.dataset.kind = item.kind;
  chip.title = `Search the chat for ${item.label}`;

  if (item.kind === "ticker") {
    chip.dataset.symbol = item.symbol;
    const sym = document.createElement("span");
    sym.className = "ticker-chip-sym";
    sym.textContent = item.symbol;
    const price = document.createElement("span");
    price.className = "ticker-chip-price";
    const chg = document.createElement("span");
    chg.className = "ticker-chip-chg";
    chip.append(sym, price, chg);
  } else {
    const kind = document.createElement("span");
    kind.className = "ticker-chip-kind";
    kind.textContent = item.kind === "person" ? "@" : "#";
    const label = document.createElement("span");
    label.className = "ticker-chip-sym";
    label.textContent = item.label;
    chip.append(kind, label);
  }
  return chip;
}

// Build the scrolling track: one "set" of chips wide enough to fill the
// viewport, duplicated once so a translateX(-50%) loop is seamless.
function buildTickerTrack(track, items) {
  track.style.animation = "none"; // reset before remeasure
  track.innerHTML = "";

  // 1) lay down a single base copy and measure it
  const base = document.createDocumentFragment();
  for (const it of items) base.appendChild(buildTickerChip(it));
  track.appendChild(base);
  const viewport = document.getElementById("tickerViewport");
  const viewportW = (viewport && viewport.clientWidth) || 0;
  const baseW = track.scrollWidth || 0;

  // 2) repeat the base until one "set" is at least the viewport width, so
  //    there's never a visible gap as the loop wraps. Cap at 8 copies: if a
  //    first-paint race ever reports baseW unrealistically small, we must
  //    not clone hundreds of chips.
  const repeats =
    baseW > 0 && viewportW > 0
      ? Math.min(8, Math.max(1, Math.ceil(viewportW / baseW)))
      : 1;
  const baseChildren = Array.from(track.children);
  // We already have 1 base copy; we need `repeats` copies for one set, then
  // duplicate the whole set → repeats * 2 total copies.
  const totalCopies = repeats * 2;
  for (let copy = 1; copy < totalCopies; copy++) {
    for (const node of baseChildren) track.appendChild(node.cloneNode(true));
  }

  // 3) constant-speed animation: one set scrolls past in setW / speed sec.
  const setW = baseW * repeats;
  const reduce =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && setW > 0) {
    const durationS = setW / TICKER_SPEED_PX_S;
    track.style.animation = `bsscTickerScroll ${durationS}s linear infinite`;
    // Grab the live CSSAnimation handle so hover can ramp its playbackRate
    // down to a halt (and back). getAnimations() reflects the inline
    // shorthand we just set. Preserve the current speed if a ramp was
    // mid-flight when the track got rebuilt.
    const prevRate = _tickerAnim ? _tickerAnim.playbackRate : 1;
    _tickerAnim = (track.getAnimations && track.getAnimations()[0]) || null;
    if (_tickerAnim) _tickerAnim.playbackRate = prevRate;
  } else {
    track.style.animation = "none";
    _tickerAnim = null;
  }
}

// Smoothly ramp the marquee's playback speed toward `target` (1 = full
// speed, 0 = halted) over ~300ms. Used so hovering the bar eases it to a
// stop — the chip under the cursor stays put and is clickable — instead of
// scrolling out from under the pointer.
function rampTickerSpeed(target) {
  if (!_tickerAnim) return;
  if (_tickerRampRAF) {
    cancelAnimationFrame(_tickerRampRAF);
    _tickerRampRAF = null;
  }
  const start = _tickerAnim.playbackRate;
  if (Math.abs(start - target) < 0.001) {
    _tickerAnim.playbackRate = target;
    return;
  }
  const startT = performance.now();
  const dur = 300;
  const step = (t) => {
    const k = Math.min(1, (t - startT) / dur);
    // easeInOutQuad
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (!_tickerAnim) {
      _tickerRampRAF = null;
      return;
    }
    _tickerAnim.playbackRate = start + (target - start) * e;
    if (k < 1) {
      _tickerRampRAF = requestAnimationFrame(step);
    } else {
      _tickerRampRAF = null;
    }
  };
  _tickerRampRAF = requestAnimationFrame(step);
}

// Update price/change text inside already-rendered ticker chips. Runs on
// every render and whenever a price fetch resolves. Touches ALL copies.
function paintTickerPrices() {
  const track = document.getElementById("tickerTrack");
  if (!track) return;
  const chips = track.querySelectorAll('.ticker-chip[data-kind="ticker"]');
  for (const chip of chips) {
    const sym = chip.dataset.symbol;
    const rec = _tickerPrices.get(sym);
    const priceEl = chip.querySelector(".ticker-chip-price");
    const chgEl = chip.querySelector(".ticker-chip-chg");
    if (!priceEl || !chgEl) continue;
    if (!rec || rec.error || typeof rec.price !== "number") {
      priceEl.textContent = "";
      chgEl.textContent = "";
      chgEl.className = "ticker-chip-chg";
      continue;
    }
    priceEl.textContent = formatTickerPrice(rec.price);
    if (typeof rec.changePct === "number" && Number.isFinite(rec.changePct)) {
      const up = rec.changePct > 0.0005;
      const down = rec.changePct < -0.0005;
      const arrow = up ? "▲" : down ? "▼" : "▬";
      chgEl.textContent = `${arrow}${Math.abs(rec.changePct).toFixed(2)}%`;
      chgEl.className =
        "ticker-chip-chg " + (up ? "up" : down ? "down" : "flat");
    } else {
      chgEl.textContent = "";
      chgEl.className = "ticker-chip-chg";
    }
  }
}

function formatTickerPrice(p) {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  // Sub-$1 (e.g. SHIB, DOGE) — show enough significant digits to be useful.
  return Number(p.toPrecision(4)).toString();
}

// Ask the background worker (bypasses CORS) for prices of any ticker that's
// missing a price or whose price is older than the TTL.
function refreshStaleTickerPrices() {
  if (!_tickerSymbols.length) return;
  const now = Date.now();
  const need = [];
  for (const sym of _tickerSymbols) {
    if (_tickerPriceInflight.has(sym)) continue;
    const rec = _tickerPrices.get(sym);
    if (!rec || now - rec.asOf > TICKER_PRICE_TTL_MS) need.push(sym);
  }
  if (!need.length) return;
  for (const s of need) _tickerPriceInflight.add(s);
  try {
    chrome.runtime.sendMessage({ type: "fetchPrices", symbols: need }, (resp) => {
      for (const s of need) _tickerPriceInflight.delete(s);
      // chrome.runtime.lastError fires if the SW was asleep / errored.
      if (chrome.runtime.lastError || !resp || !resp.ok || !resp.prices) return;
      const at = Date.now();
      for (const [sym, rec] of Object.entries(resp.prices)) {
        if (rec && typeof rec.price === "number") {
          _tickerPrices.set(sym, { ...rec, asOf: rec.asOf || at });
        } else {
          // Stamp a failed lookup so we don't retry it every tick; TTL still
          // lets us try again later.
          _tickerPrices.set(sym, { error: true, asOf: at });
        }
      }
      paintTickerPrices();
    });
  } catch (_) {
    for (const s of need) _tickerPriceInflight.delete(s);
  }
}

function startTickerRefreshTimer() {
  if (_tickerRefreshTimer) return;
  _tickerRefreshTimer = setInterval(
    refreshStaleTickerPrices,
    TICKER_REFRESH_TIMER_MS
  );
}
function stopTickerRefreshTimer() {
  if (_tickerRefreshTimer) {
    clearInterval(_tickerRefreshTimer);
    _tickerRefreshTimer = null;
  }
}

// Click a chip → drop its term into the search box and run the search.
function bindTickerBar() {
  const bar = document.getElementById("tickerBar");
  const track = document.getElementById("tickerTrack");
  if (!track) return;
  track.addEventListener("click", (e) => {
    const chip = e.target.closest(".ticker-chip");
    if (!chip || !chip.dataset.term) return;
    searchForTerm(chip.dataset.term);
  });
  // Hover the strip → ease the scroll to a halt so the chip under the
  // cursor stops moving and is clickable; leave → ease back to full speed.
  if (bar) {
    bar.addEventListener("mouseenter", () => rampTickerSpeed(0));
    bar.addEventListener("mouseleave", () => rampTickerSpeed(1));
    // Keyboard focus on a chip should also halt it.
    bar.addEventListener("focusin", () => rampTickerSpeed(0));
    bar.addEventListener("focusout", () => {
      if (!bar.matches(":hover")) rampTickerSpeed(1);
    });
  }
  // Refresh prices once per marquee loop — i.e. each time the chips
  // re-enter from the right. TTL-gated inside refreshStaleTickerPrices so
  // this never floods the endpoint.
  track.addEventListener("animationiteration", refreshStaleTickerPrices);
}

// Set the search input to `term` and apply — shared by the ticker chips.
// Mirrors filterByAuthorName (the click-author affordance).
function searchForTerm(term) {
  if (!term) return;
  const input = document.getElementById("searchInput");
  if (input) input.value = term;
  state.searchQuery = term;
  applySearch();
  // Surface the first hit if the user was scrolled away.
  if (state.searchHits && state.searchHits.length) {
    focusSearchHit(state.searchActiveIdx || 0);
  }
}

// renderAll() but keep a given message visually pinned. renderAll rebuilds the
// whole feed; if content is inserted ABOVE the viewport (e.g. the silent
// background prefetch's deferred backlog finally rendering, or older history),
// the user's scroll position would otherwise jump. We measure the anchor
// message's on-screen offset before the render and re-apply scrollTop after so
// it stays put. Used by Explain so clicking ✦ never teleports the feed.
function renderAllAnchored(anchorId) {
  const stream = document.getElementById("stream");
  if (!stream || anchorId == null) {
    renderAll();
    return;
  }
  const sel = `.msg-item[data-id="${cssEscape(String(anchorId))}"]`;
  const before = stream.querySelector(sel);
  const beforeTop = before ? before.getBoundingClientRect().top : null;
  renderAll();
  if (beforeTop == null) return;
  const after = stream.querySelector(sel);
  if (after) stream.scrollTop += after.getBoundingClientRect().top - beforeTop;
}

// Surgically insert / replace / remove ONE message group's ✦ explain block in
// the live DOM, WITHOUT a full renderAll(). This is what Explain uses so a
// click never forces the silent-prefetch backlog to render (the cause of the
// first-click scroll teleport — that backlog's images load async and defeat
// any synchronous scroll anchor). The next genuine renderAll (poll / prefetch
// completion) self-heals the block via renderGroup, so drift is impossible.
//   head: the group's head comment (holds _explain* state)
//   groupItems: the logical group's comments (head + continuations)
function renderExplainInline(head, groupItems) {
  const stream = document.getElementById("stream");
  if (!stream || !head || !head.id) {
    renderAll();
    return;
  }
  const headId = String(head.id);
  // Drop any existing block for this head.
  const existing = stream.querySelector(
    `.msg-explain[data-head-id="${cssEscape(headId)}"]`
  );
  if (existing) existing.remove();

  const headNode = stream.querySelector(
    `.msg-item[data-id="${cssEscape(headId)}"]`
  );

  // Insert a fresh block after the group's LAST message when the head still
  // carries explain state.
  if (head._explainPending || head._explainError || head._explain) {
    const items =
      Array.isArray(groupItems) && groupItems.length
        ? groupItems
        : Array.isArray(head._explainGroupItems) && head._explainGroupItems.length
          ? head._explainGroupItems
          : [head];
    const lastId = String(items[items.length - 1].id);
    const lastNode =
      stream.querySelector(`.msg-item[data-id="${cssEscape(lastId)}"]`) || headNode;
    if (!lastNode) {
      // Group isn't in the DOM (shouldn't happen — user just clicked it).
      renderAllAnchored(head.id);
      return;
    }
    lastNode.after(renderExplainBlock(head));
  }

  // Keep the head's ✦ trigger in sync (pending spinner + disabled).
  if (headNode) {
    const trig = headNode.querySelector(".msg-explain-trigger");
    if (trig) {
      const pending = !!head._explainPending;
      trig.classList.toggle("is-pending", pending);
      trig.disabled = pending;
    }
  }
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

  // Split the author-run into logical sub-groups so the ✦ Explain button
  // shows once per group (on its head), not once per message. A reply to a
  // different target mid-run starts a new group → its own button.
  const subGroups = segmentExplainGroups(group.items);
  const headMembers = new Map(); // headId → member comments (head + continuations)
  const lastIdToHead = new Map(); // last-member id → head comment (explain block anchor)
  for (const sg of subGroups) {
    headMembers.set(sg.headId, sg.items);
    lastIdToHead.set(sg.items[sg.items.length - 1].id, sg.items[0]);
  }

  for (const c of group.items) {
    const groupItems = headMembers.get(c.id); // defined only on a sub-group head
    body.appendChild(
      renderMessageItem(c, { isExplainHead: !!groupItems, groupItems })
    );
    // ✦ The explanation belongs to the whole logical group, so render its
    // block AFTER the group's LAST message (the head holds the _explain* state).
    const head = lastIdToHead.get(c.id);
    if (head && (head._explainPending || head._explainError || head._explain)) {
      body.appendChild(renderExplainBlock(head));
    }
  }

  root.appendChild(body);
  return root;
}

// Build the persistent ✦ Explain trigger shown at the top-right of every
// message. Always visible (not hover-gated). Reflects in-flight state so a
// double-click is obvious, and reuses runExplain's own per-message guard.
function makeExplainTrigger(c, groupItems) {
  // No explain affordance on your own not-yet-confirmed / failed sends —
  // there's nothing stable to explain until the message lands.
  if (c._pending || c._failed) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-explain-trigger" + (c._explainPending ? " is-pending" : "");
  const multi = Array.isArray(groupItems) && groupItems.length > 1;
  btn.title = c._explainPending
    ? "Explaining…"
    : multi
      ? `Explain these ${groupItems.length} messages with AI`
      : "Explain this message with AI";
  btn.setAttribute("aria-label", btn.title);
  btn.textContent = "✦";
  if (c._explainPending) btn.disabled = true;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    runExplain(c, { groupItems });
  });
  return btn;
}

function renderMessageItem(c, opts = {}) {
  // AI Insights messages have their own rendering — local-only, light
  // markdown, dismiss button, "only visible to you" footer.
  if (c._aiGenerated) return renderAiMessageItem(c);

  const wrap = document.createElement("div");
  wrap.className = "msg-item";
  wrap.dataset.id = c.id;

  // ✦ Explain trigger — persistent, top-right (X/Grok-style), NOT in the hover
  // toolbar. Shown only on a LOGICAL-GROUP HEAD (opts.isExplainHead): one
  // button per run of same-author messages, splitting where a reply targets a
  // different message. Clicking explains the whole group inline.
  if (opts.isExplainHead) {
    const explainTrigger = makeExplainTrigger(c, opts.groupItems);
    if (explainTrigger) wrap.appendChild(explainTrigger);
  }

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
        } else if (part.type === "ticker") {
          const a = document.createElement("a");
          a.className = "msg-ticker";
          a.href = "#";
          a.dataset.symbol = part.symbol;
          a.textContent = part.value;
          a.title = `View ${part.symbol} on TradingView`;
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

  const reactionsEl = buildReactionsEl(c);
  if (reactionsEl) wrap.appendChild(reactionsEl);

  // NOTE: the ✦ inline explanation block is NOT rendered here. The explain
  // targets a whole logical GROUP, so renderGroup appends the block after the
  // group's LAST message (not inside the head's item) — see renderGroup.

  return wrap;
}

// Build the inline "✦ Explained" block attached under a message. Three
// states: pending (spinner-ish placeholder), error (sanitized provider
// error + retry), and done (markdown explanation + optional web citations).
// All model text goes through renderAiMarkdownToHtml (escape-first, http(s)-
// only links) — the same XSS-safe path the Ask renderer uses.
function renderExplainBlock(c) {
  const box = document.createElement("div");
  box.className = "msg-explain"
    + (c._explainPending ? " is-pending" : "")
    + (c._explainError ? " is-error" : "");
  // Tag with the head id so the surgical updater (renderExplainInline) can
  // find + replace/remove this block without a full re-render.
  box.dataset.headId = c.id;

  const head = document.createElement("div");
  head.className = "msg-explain-head";
  const label = document.createElement("span");
  label.className = "msg-explain-label";
  label.textContent = c._explainPending ? "✦ Explaining…" : "✦ Explained";
  head.appendChild(label);
  // Dismiss (✕) — only once there's something to dismiss (not mid-flight).
  if (!c._explainPending) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "msg-explain-close";
    close.title = "Dismiss explanation";
    close.setAttribute("aria-label", "Dismiss explanation");
    close.textContent = "✕";
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissExplain(c.id);
    });
    head.appendChild(close);
  }
  box.appendChild(head);

  const body = document.createElement("div");
  body.className = "msg-explain-body";
  if (c._explainPending) {
    body.innerHTML = renderAiMarkdownToHtml(
      "_Reading the thread" +
        (supportsWebSearch(c._explainProvider) ? " and searching the web" : "") +
        "…_"
    );
  } else if (c._explainError) {
    body.innerHTML = renderAiMarkdownToHtml(
      "**Couldn't explain this.** " + (c._explain || "Unknown error")
    );
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "msg-explain-retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      runExplain(c, { groupItems: c._explainGroupItems });
    });
    body.appendChild(retry);
  } else {
    body.innerHTML = renderAiMarkdownToHtml(c._explain || "");
  }
  box.appendChild(body);

  // Web citations (numbered, clickable, http(s)-only) — same shape as Ask.
  if (!c._explainPending && !c._explainError && Array.isArray(c._explainCitations) && c._explainCitations.length) {
    const citeWrap = document.createElement("div");
    citeWrap.className = "msg-explain-citations";
    const citeLabel = document.createElement("div");
    citeLabel.className = "msg-explain-citations-label";
    citeLabel.textContent = `Sources (${c._explainCitations.length})`;
    citeWrap.appendChild(citeLabel);
    const list = document.createElement("ol");
    for (const cit of c._explainCitations) {
      const li = document.createElement("li");
      const safeHref = cit.url && /^https?:\/\//i.test(cit.url) ? cit.url : "#";
      const a = document.createElement("a");
      a.href = safeHref;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "ai-link";
      a.textContent = cit.title || cit.url || "(untitled source)";
      li.appendChild(a);
      list.appendChild(li);
    }
    citeWrap.appendChild(list);
    box.appendChild(citeWrap);
  }

  // Footer — "Only visible to you" + provider, matching the AI-message
  // local-only framing so the user knows this isn't posted to Substack.
  if (!c._explainPending) {
    const footer = document.createElement("div");
    footer.className = "msg-explain-footer";
    const providerLabel = c._explainProvider ? ` · ${c._explainProvider}` : "";
    const info = c._explainContextInfo || {};
    const ctx = c._explainContextInfo
      ? ` · ${info.included} message${info.included === 1 ? "" : "s"} of thread`
      : "";
    const imgLabel = info.imageCount ? ` · ${info.imageCount} image${info.imageCount === 1 ? "" : "s"}` : "";
    const linkLabel = info.linkCount ? ` · ${info.linkCount} link${info.linkCount === 1 ? "" : "s"}` : "";
    footer.textContent = `Only visible to you${providerLabel}${ctx}${imgLabel}${linkLabel}`;
    box.appendChild(footer);
  }

  return box;
}

// Standard "copy" glyph (two overlapping sheets) and a "copied" checkmark.
// Static, author-controlled SVG strings — safe to assign via innerHTML.
const AI_COPY_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="11" height="11" rx="2"></rect>' +
  '<path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>';
const AI_CHECK_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
  'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 6 9 17l-5-5"></path></svg>';

// Copy the insight's raw markdown body to the clipboard. Local-only read:
// this NEVER hits the network and copies only this message's own text.
// On success, flash a checkmark for ~1.5s. If the clipboard API is
// unavailable or blocked (no secure context / lost focus), fail soft with
// a brief shake — never throw, never leave the user staring at a dead icon.
async function copyAiInsight(btn, text) {
  try {
    await navigator.clipboard.writeText(text || "");
    btn.classList.add("is-copied");
    btn.innerHTML = AI_CHECK_ICON_SVG;
    btn.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.innerHTML = AI_COPY_ICON_SVG;
      btn.setAttribute("aria-label", "Copy insight");
    }, 1500);
  } catch (err) {
    console.warn("[BetterSSC copy] clipboard unavailable:", err);
    btn.classList.add("is-copy-failed");
    setTimeout(() => btn.classList.remove("is-copy-failed"), 1200);
  }
}

// Render an AI Insights message — special, local-only, light markdown.
// Body comes back as markdown from the provider; we render bold,
// italic, headers, and bullet lists. Linkifying URLs would risk
// XSS on stylized strings, so we skip it for AI bodies — providers
// almost never emit URLs in this preview format anyway.
function renderAiMessageItem(c) {
  const wrap = document.createElement("div");
  wrap.className = "msg-item ai-msg" + (c._aiPending ? " ai-pending" : "")
    + (c._aiError ? " ai-error" : "");
  wrap.dataset.id = c.id;

  // Copy button — top-right of the insight box. Copies the raw markdown so
  // it pastes cleanly into a doc/message. Only on finished, non-error
  // insights; pending/error states have no body worth copying.
  if (!c._aiPending && !c._aiError && (c.body || "").trim()) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "ai-copy-btn";
    copyBtn.title = "Copy insight";
    copyBtn.setAttribute("aria-label", "Copy insight");
    copyBtn.innerHTML = AI_COPY_ICON_SVG;
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyAiInsight(copyBtn, c.body || "");
    });
    wrap.appendChild(copyBtn);
  }

  const bodyEl = document.createElement("div");
  bodyEl.className = "msg-body ai-body";
  // Ask-mode messages render as structured sections (From the chat /
  // From the web / Synthesis + citation links). Summary messages render
  // as one markdown blob. Pending / error states bypass section parsing
  // because the body is a placeholder string ("_Thinking…_" / "Error: …")
  // that wouldn't survive the parser.
  if (c._aiVariant === "ask" && !c._aiPending && !c._aiError) {
    renderAiAskBody(bodyEl, c);
  } else {
    // innerHTML is safe here because renderAiMarkdownToHtml escapes the
    // raw text via escapeHtml() BEFORE applying its narrow set of inline
    // transforms (bold/italic/headers/bullets). No <script>, no event
    // handler attributes can survive.
    bodyEl.innerHTML = renderAiMarkdownToHtml(c.body || "");
  }
  wrap.appendChild(bodyEl);

  // Regenerate row: only on finished, non-error messages. Clicks
  // generate a NEW insight at the bottom of the feed (don't replace
  // this one) so the user can compare lengths.
  if (!c._aiPending && !c._aiError) {
    const actions = document.createElement("div");
    actions.className = "ai-actions";
    const conciseBtn = document.createElement("button");
    conciseBtn.type = "button";
    conciseBtn.className = "ai-action-btn";
    conciseBtn.textContent = "↓ Concise";
    conciseBtn.title = "Generate a tighter version (3-4 bullets total)";
    conciseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      regenerateAiInsight("concise");
    });
    const elaborateBtn = document.createElement("button");
    elaborateBtn.type = "button";
    elaborateBtn.className = "ai-action-btn";
    elaborateBtn.textContent = "↑ Elaborate";
    elaborateBtn.title = "Generate a longer version (quotes + caveats)";
    elaborateBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      regenerateAiInsight("elaborate");
    });
    actions.appendChild(conciseBtn);
    actions.appendChild(elaborateBtn);
    wrap.appendChild(actions);
  }

  const footer = document.createElement("div");
  footer.className = "ai-footer";
  const meta = document.createElement("span");
  meta.className = "ai-footer-meta";
  const providerLabel = c._aiProvider ? ` · ${c._aiProvider}` : "";
  const variantLabel =
    c._aiVariant && c._aiVariant !== "normal" ? ` · ${c._aiVariant}` : "";
  const ctxInfo = c._aiContextInfo
    ? ` · ${c._aiContextInfo.included} message${c._aiContextInfo.included === 1 ? "" : "s"}`
      + (c._aiContextInfo.dropped ? ` (oldest ${c._aiContextInfo.dropped} truncated)` : "")
    : "";
  meta.textContent = `Only visible to you${providerLabel}${variantLabel}${ctxInfo}`;
  footer.appendChild(meta);
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ai-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.title = "Remove this AI message (it's local-only anyway)";
  dismiss.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissAiMessage(c.id);
  });
  footer.appendChild(dismiss);
  wrap.appendChild(footer);

  return wrap;
}

// Tiny markdown subset for AI bodies: **bold**, _italic_, ## / ### headers,
// "- " bullet lists, [text](url) links, \n → <br>. Input is escapeHtml'd
// FIRST so no raw HTML from the provider can land in the DOM. URL is
// validated against http/https only — javascript: and data: schemes
// (the only practical XSS vectors through an anchor) are dropped.
function renderAiMarkdownToHtml(raw) {
  let html = escapeHtml(raw);
  // Headers (operate on escaped text — pattern still matches "## " literally)
  html = html.replace(/^### (.+)$/gm, "<h4 class='ai-h4'>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3 class='ai-h3'>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h3 class='ai-h3'>$1</h3>");
  // [text](url) — must run BEFORE bold/italic so the bracket/paren
  // characters in the link don't get chewed up. URL is restricted to
  // http(s); anything else falls back to plain text. The URL match
  // allows balanced parens one level deep so Wikipedia-style URLs like
  // /wiki/Foo_(bar) don't get truncated at the first `)`. Anything
  // beyond one paren pair is still terminated by `)` — acceptable
  // because escapeHtml has already neutralized HTML; raw text in the
  // un-linked tail just renders as plain markdown body.
  html = html.replace(
    /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g,
    (_match, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ai-link">${label}</a>`
  );
  // Bold (greedy-resistant: no asterisks inside the run)
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic — underscore-bounded with word-boundary guards so we don't
  // chew through identifiers like _foo_bar_baz.
  html = html.replace(
    /(^|[\s(\[])_([^_\n]+)_(?=[\s.,;:?!)\]]|$)/g,
    "$1<em>$2</em>"
  );
  // Bullet groups: consecutive "- " lines become a <ul>.
  html = html.replace(/(?:^[-*] .+(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split(/\n[-*] /)
      .map((s) => s.replace(/^[-*] /, "").trim())
      .filter(Boolean);
    return "<ul class='ai-ul'>" + items.map((i) => `<li>${i}</li>`).join("") + "</ul>";
  });
  // Remaining newlines → <br>
  html = html.replace(/\n+/g, "<br>");
  // Strip <br>s that hug block elements — they show up as empty lines
  // between a section header and its bulleted list, or after a list
  // before the next header. The <h3>/<h4>/<ul> already provide vertical
  // rhythm via their own margins.
  html = html.replace(/<br>\s*(?=<(?:h3|h4|ul)\b)/g, "");
  html = html.replace(/(<\/(?:h3|h4|ul)>)\s*<br>/g, "$1");
  return html;
}

// Bound + scrub provider error strings before they hit the rendered
// DOM. Anthropic / OpenAI / Google all return verbose server errors
// that occasionally echo request fragments; truncating + masking
// `sk-…` patterns keeps any accidental key fragment out of the visible
// surface. Cap at 200 chars — long enough to be useful, short enough
// that an embedded key can't survive intact.
function sanitizeProviderError(raw) {
  if (typeof raw !== "string") return "Unknown error";
  const masked = raw.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]");
  if (masked.length <= 200) return masked;
  return masked.slice(0, 200) + "…";
}

// Render an Ask-mode AI message into structured sections. Echoes the
// user's question at the top, then renders each non-empty section
// (From the chat / From the web / Synthesis) with a labeled heading
// and a small accent bar. Citations from _aiAskCitations render as a
// numbered list of clickable links underneath the From-the-web section
// (or at the bottom of the body if From-the-web is absent).
//
// All section bodies pass through renderAiMarkdownToHtml so [text](url)
// links inside the model's prose are clickable, the same XSS escape
// applies, and bold/italic/bullets all work consistently.
function renderAiAskBody(container, c) {
  const sections = parseAskSections(c.body || "");
  // Question echo — distinct treatment so the user can scan multiple
  // Ask responses in the feed and tell them apart.
  if (c._aiAskQuestion) {
    const q = document.createElement("div");
    q.className = "ai-ask-question";
    const label = document.createElement("span");
    label.className = "ai-ask-q-label";
    label.textContent = "Q";
    const text = document.createElement("span");
    text.className = "ai-ask-q-text";
    text.textContent = c._aiAskQuestion;
    q.appendChild(label);
    q.appendChild(text);
    container.appendChild(q);
  }

  // Preamble (rare — model occasionally opens with a framing sentence
  // before the first section header).
  if (sections.preamble) {
    const p = document.createElement("div");
    p.className = "ai-ask-preamble";
    p.innerHTML = renderAiMarkdownToHtml(sections.preamble);
    container.appendChild(p);
  }

  const sectionDefs = [
    { key: "fromChat", title: "From the chat", icon: "💬", className: "ai-ask-section-chat" },
    { key: "fromWeb", title: "From the web", icon: "🌐", className: "ai-ask-section-web" },
    { key: "synthesis", title: "Synthesis", icon: "✦", className: "ai-ask-section-synth" },
  ];

  // Track whether From-the-web was rendered so we know where to attach
  // citations (inside the section if present, otherwise as a tail block).
  let webSectionEl = null;

  for (const def of sectionDefs) {
    const text = sections[def.key];
    if (!text) continue;
    const section = document.createElement("section");
    section.className = `ai-ask-section ${def.className}`;
    const heading = document.createElement("h3");
    heading.className = "ai-ask-section-title";
    heading.textContent = `${def.icon} ${def.title}`;
    section.appendChild(heading);
    const bodyDiv = document.createElement("div");
    bodyDiv.className = "ai-ask-section-body";
    bodyDiv.innerHTML = renderAiMarkdownToHtml(text);
    section.appendChild(bodyDiv);
    container.appendChild(section);
    if (def.key === "fromWeb") webSectionEl = section;
  }

  // If the model ignored the format and dropped everything into the
  // preamble, fall back to rendering the body as a single block. The
  // preamble render above already handled this — we just need to
  // surface that there was no section structure so the user can tell.
  if (!sections.fromChat && !sections.fromWeb && !sections.synthesis && !sections.preamble) {
    const fallback = document.createElement("div");
    fallback.className = "ai-ask-fallback";
    fallback.innerHTML = renderAiMarkdownToHtml(c.body || "");
    container.appendChild(fallback);
  }

  // Citation list. Attaches to the bottom of From-the-web if that
  // section rendered, else stands alone at the end of the body. Each
  // entry is a numbered linked title; the numeric index lets the model's
  // prose reference [1] / [2] / etc. (a follow-up could rewrite those
  // citation markers in the section bodies, but it's not load-bearing).
  if (c._aiAskCitations && c._aiAskCitations.length) {
    const citeWrap = document.createElement("div");
    citeWrap.className = "ai-ask-citations";
    const citeLabel = document.createElement("div");
    citeLabel.className = "ai-ask-citations-label";
    citeLabel.textContent = `Sources (${c._aiAskCitations.length})`;
    citeWrap.appendChild(citeLabel);
    const list = document.createElement("ol");
    list.className = "ai-ask-citation-list";
    for (const cit of c._aiAskCitations) {
      const li = document.createElement("li");
      const safeHref =
        cit.url && /^https?:\/\//i.test(cit.url) ? cit.url : "#";
      const a = document.createElement("a");
      a.href = safeHref;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "ai-link";
      a.textContent = cit.title || cit.url || "(untitled source)";
      li.appendChild(a);
      list.appendChild(li);
    }
    citeWrap.appendChild(list);
    if (webSectionEl) {
      webSectionEl.appendChild(citeWrap);
    } else {
      container.appendChild(citeWrap);
    }
  }
}

// Reactions row. v0.1.11: REST shape is {name: <count number>}; WS event
// shape might be {name: {count, has_reacted}}. Handle both, and filter
// out zero-count entries (we were rendering "👍 0" pills).
// Extracted from renderMessageItem so sendReaction can surgically replace
// just this element instead of calling renderAll() (which scroll-jumps).
function buildReactionsEl(c) {
  if (!c.reactions || typeof c.reactions !== "object") return null;
  const entries = Object.entries(c.reactions)
    .map(([name, v]) => {
      const count = typeof v === "number" ? v : (v && v.count) || 0;
      return [name, count];
    })
    .filter(([, count]) => count > 0);
  if (!entries.length) return null;
  const reactionsEl = document.createElement("div");
  reactionsEl.className = "msg-reactions";
  for (const [reactionType, count] of entries) {
    const pill = document.createElement("span");
    pill.className = "msg-reaction";
    pill.title = `Click to react with :${reactionType}: (currently ×${count})`;
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.appendChild(
      document.createTextNode(reactionEmojiFor(reactionType))
    );
    const countEl = document.createElement("span");
    countEl.className = "msg-reaction-count";
    countEl.textContent = String(count);
    pill.appendChild(countEl);
    // Click an existing reaction pill to add your own reaction of the
    // same type — saves a trip through the picker for the common case
    // of "+1ing" a reaction someone else already made. Stop propagation
    // so the pill click doesn't also trigger any parent .msg-item /
    // .msg-group click handlers (focus tracking, ticker modal, etc).
    pill.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendReaction(c, reactionType);
    });
    reactionsEl.appendChild(pill);
  }
  return reactionsEl;
}

// URLs that recently failed to load. Re-attempted after a TTL so a
// transient throttle (Substack CDN occasionally 403s on burst), a
// dropped connection, or a one-time decode error doesn't permanently
// doom an avatar for the entire session. Originally a permanent Set
// — that's why users with one bad fetch were stuck as letter
// placeholders forever even after _userTable upgraded their photo_url.
const _failedImageUrls = new Map(); // url → Date.now() of failure
const FAILED_URL_TTL_MS = 60_000;
function isUrlFailed(url) {
  const t = _failedImageUrls.get(url);
  if (t == null) return false;
  if (Date.now() - t > FAILED_URL_TTL_MS) {
    _failedImageUrls.delete(url);
    return false;
  }
  return true;
}
function markUrlFailed(url) {
  _failedImageUrls.set(url, Date.now());
}

// v0.2.1: cache an <img> template per avatar URL so re-renders during
// polling don't keep creating fresh <img> nodes that each kick off a
// fetch (DevTools "Disable cache" defeats HTTP cache during dev, and
// even with HTTP cache the constant img creation + decode is wasteful).
// We store an img element that's NEVER inserted into the DOM; every
// makeAvatar call clones it. cloneNode preserves the src attribute,
// so the clone hits the browser's image cache without a new GET.
const _avatarTemplates = new Map(); // url → HTMLImageElement

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

// Substack-flavored palette for default avatars. Picked by hashing
// user_id mod palette length so the same user always gets the same
// color across sessions and tabs. Matches the native Substack default
// avatar style (colored circle + first letter) instead of our prior
// single-blue placeholder, which made every photo-less user look
// identical.
const AVATAR_PALETTE = [
  { bg: "#e47453", fg: "#ffffff" }, // coral
  { bg: "#2d5f5c", fg: "#ffffff" }, // teal
  { bg: "#c25d5d", fg: "#ffffff" }, // brick
  { bg: "#3d6b8a", fg: "#ffffff" }, // slate blue
  { bg: "#7a5c8b", fg: "#ffffff" }, // muted purple
  { bg: "#b58a3e", fg: "#ffffff" }, // ochre
  { bg: "#4e7c4f", fg: "#ffffff" }, // forest
  { bg: "#a1556e", fg: "#ffffff" }, // rose
];
function paletteForId(id) {
  if (id == null) return AVATAR_PALETTE[0];
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function makeAvatarPlaceholder(initial, cssClass, userId) {
  const div = document.createElement("div");
  div.className = cssClass + " msg-avatar-placeholder";
  div.textContent = initial;
  const { bg, fg } = paletteForId(userId);
  div.style.backgroundColor = bg;
  div.style.color = fg;
  return div;
}

// Walks the DOM for already-rendered .msg-group elements whose
// data-author-id matches an upgraded user, and swaps the avatar
// element in place with a fresh makeAvatar() that picks up the new
// photo_url. Without this, message rows rendered BEFORE the photo
// arrived stay stuck on the letter placeholder forever — even
// though _userTable now has the real avatar.
function refreshAvatarsForUsers(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  const seen = new Set();
  for (const id of userIds) {
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = _userTable.get(id);
    if (!cached || !cached.photo_url) continue;
    const author = { id, name: cached.name, handle: cached.handle, photo_url: cached.photo_url };
    const groups = document.querySelectorAll(
      `.msg-group[data-author-id="${cssEscape(key)}"]`
    );
    for (const group of groups) {
      const old = group.querySelector(":scope > .msg-avatar, :scope > .msg-avatar-placeholder");
      if (!old) continue;
      const fresh = makeAvatar(author, "msg-avatar");
      old.replaceWith(fresh);
    }
  }
  // Header avatar too (post author + self) — cheaper to re-render than
  // walk for it explicitly.
  renderChatHeader();
}

function makeAvatar(author, cssClass) {
  const initial = ((author && author.name) || "?").charAt(0).toUpperCase();
  // Fallback: if the comment's author lacks photo_url but _userTable has
  // since learned the avatar (later payload upgrade), use that. Keeps
  // already-rendered messages from being stuck on letter placeholders.
  let photoUrl = author && author.photo_url;
  if (!photoUrl && author && author.id != null) {
    const cached = _userTable.get(author.id);
    if (cached && cached.photo_url) {
      photoUrl = cached.photo_url;
      author.photo_url = photoUrl;
    }
  }
  const authorId = author && author.id;
  if (!photoUrl) {
    return makeAvatarPlaceholder(initial, cssClass, authorId);
  }
  const url = rewriteImageUrl(photoUrl);
  // Recently-failed URLs go straight to placeholder — but with a TTL,
  // not a permanent ban, so a one-time CDN throttle doesn't doom the
  // avatar forever.
  if (isUrlFailed(url)) {
    return makeAvatarPlaceholder(initial, cssClass, authorId);
  }
  // Per-URL template: build once, then every caller gets a fresh clone
  // (clones share the browser image cache and don't kick off new GETs).
  let template = _avatarTemplates.get(url);
  if (!template) {
    template = document.createElement("img");
    template.src = url;
    template.loading = "lazy";
    template.decoding = "async";
    _avatarTemplates.set(url, template);
  }
  const img = template.cloneNode(true);
  img.className = cssClass;
  img.alt = author.name || "";
  img.addEventListener("error", () => {
    markUrlFailed(url);
    _avatarTemplates.delete(url);
    img.replaceWith(makeAvatarPlaceholder(initial, cssClass, authorId));
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
  // blob: URLs are produced by URL.createObjectURL on the staged-
  // attachment preview path — we know they're images because the
  // composer validates MIME against COMPOSER_ATTACH_MIMES before
  // generating them. data: URLs aren't used today but get the same
  // pass for symmetry.
  if (url.startsWith("blob:") || url.startsWith("data:image/")) return true;
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
      if (isUrlFailed(finalUrl)) {
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
        markUrlFailed(finalUrl);
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

  // Hoist self to the top of the pinned section, always. Even if other
  // pinned users out-rank self by message count or alphabetical sort, self
  // sits first. If self hasn't posted yet (not in state.authors), build a
  // synthetic row from getResolvedSelf so the user still sees their own row.
  const selfId = state.user && state.user.id;
  if (selfId != null) {
    const selfIdx = pinned.findIndex((a) => a.profile.id === selfId);
    if (selfIdx > 0) {
      const [selfRow] = pinned.splice(selfIdx, 1);
      pinned.unshift(selfRow);
    } else if (selfIdx === -1) {
      const resolved = getResolvedSelf();
      if (resolved) {
        pinned.unshift({
          profile: resolved,
          lastSeenAt: 0,
          messageCount: 0,
        });
      }
    }
  }

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
    last.textContent = a.lastSeenAt
      ? formatRelativeTime(new Date(a.lastSeenAt).toISOString())
      : "";
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
        [
          "bssc_watched_users",
          "bssc_pinned_users",
          "bssc_member_sort",
          "bssc_notify_all",
          "bssc_auto_load_all",
        ],
        (res) => {
          if (res) {
            state.watchedUserIds = new Set(res.bssc_watched_users || []);
            state.pinnedUserIds = new Set(res.bssc_pinned_users || []);
            if (res.bssc_member_sort === "name" || res.bssc_member_sort === "active") {
              state.memberSort = res.bssc_member_sort;
            }
            state.notifyAllMessages = !!res.bssc_notify_all;
            // Explicit `=== false` so an unset key keeps the default ON.
            // Treating an absent storage value as "user disabled" would
            // break the on-by-default contract.
            if (res.bssc_auto_load_all === false) state.autoLoadAll = false;
          }
          ensureSelfDefaults();
          renderMembers();
          renderNotifyAllButton();
        }
      );
    // AI Insights config loads independently — don't gate the rail on it.
    chrome.storage.local.get(
      [
        "bssc_ai_provider",
        "bssc_ai_keys",
        "bssc_ai_model",
        "bssc_ai_budget_chars",
        "bssc_ai_max_tokens",
        "bssc_ai_ask_max_tokens",
        "bssc_ai_ask_web_search",
        "bssc_ai_lens_hint",
        "bssc_ai_format_template",
        "bssc_giphy_api_key",
      ],
      (res) => {
        if (!res) return;
        if (
          res.bssc_ai_provider === "openai" ||
          res.bssc_ai_provider === "anthropic" ||
          res.bssc_ai_provider === "google"
        ) {
          state.aiProvider = res.bssc_ai_provider;
        }
        if (res.bssc_ai_keys && typeof res.bssc_ai_keys === "object") {
          state.aiKeys = res.bssc_ai_keys;
        }
        if (typeof res.bssc_ai_model === "string" && res.bssc_ai_model) {
          state.aiModel = res.bssc_ai_model;
        }
        if (
          typeof res.bssc_ai_budget_chars === "number" &&
          res.bssc_ai_budget_chars >= 1000 &&
          res.bssc_ai_budget_chars <= 1_000_000
        ) {
          state.aiBudgetChars = res.bssc_ai_budget_chars;
        }
        if (
          typeof res.bssc_ai_max_tokens === "number" &&
          res.bssc_ai_max_tokens >= 256 &&
          res.bssc_ai_max_tokens <= 8192
        ) {
          state.aiMaxTokens = res.bssc_ai_max_tokens;
        }
        if (
          typeof res.bssc_ai_ask_max_tokens === "number" &&
          res.bssc_ai_ask_max_tokens >= 256 &&
          res.bssc_ai_ask_max_tokens <= 8192
        ) {
          state.aiAskMaxTokens = res.bssc_ai_ask_max_tokens;
        }
        if (typeof res.bssc_ai_ask_web_search === "boolean") {
          state.aiAskWebSearch = res.bssc_ai_ask_web_search;
        }
        if (typeof res.bssc_ai_lens_hint === "string") {
          state.aiLensHint = res.bssc_ai_lens_hint;
        }
        if (typeof res.bssc_ai_format_template === "string") {
          state.aiFormatTemplate = res.bssc_ai_format_template;
        }
        if (typeof res.bssc_giphy_api_key === "string" && res.bssc_giphy_api_key) {
          state.giphyApiKey = res.bssc_giphy_api_key;
        }
      }
    );
  } catch (_) {}
}

// Self is always pinned + watched by default. Runs from both the storage
// restore callback AND the identity load completion — whichever finishes
// second is the one that actually adds self (the other is a no-op).
// Idempotent: if self is already in both sets, nothing is written.
// Not a hard lock — if the user unpins/unwatches themselves explicitly,
// next session re-adds. "Always" without removing the escape hatch.
function ensureSelfDefaults() {
  if (!state.user || state.user.id == null) return;
  let changed = false;
  if (!state.pinnedUserIds.has(state.user.id)) {
    state.pinnedUserIds.add(state.user.id);
    changed = true;
  }
  if (!state.watchedUserIds.has(state.user.id)) {
    state.watchedUserIds.add(state.user.id);
    changed = true;
  }
  if (!changed) return;
  try {
    chrome.storage &&
      chrome.storage.local &&
      chrome.storage.local.set({
        bssc_pinned_users: Array.from(state.pinnedUserIds),
        bssc_watched_users: Array.from(state.watchedUserIds),
      });
  } catch (_) {}
}

// ============================================================
// "Notify on every new message" header toggle (v0.2)
// ============================================================

function renderNotifyAllButton() {
  const btn = document.getElementById("notifyAllBtn");
  if (!btn) return;
  const on = !!state.notifyAllMessages;
  btn.innerHTML = on ? ICON_BELL_ON_LG : ICON_BELL_OFF_LG;
  btn.classList.toggle("on", on);
  btn.title = on
    ? "Notifications on for every new message — click to turn off"
    : "Notify me on every new message (only while this tab is hidden)";
}

function toggleNotifyAllMessages() {
  state.notifyAllMessages = !state.notifyAllMessages;
  renderNotifyAllButton();
  try {
    chrome.storage &&
      chrome.storage.local &&
      chrome.storage.local.set({ bssc_notify_all: state.notifyAllMessages });
  } catch (_) {}
}

// Alert when someone replies to one of YOUR messages. Catches both
// styles Substack uses:
//   - quote-reply: comment.quote refers to your message
//   - threaded reply: comment.parent_id refers to your message (looked
//     up in state.comments; if the parent isn't in our cache we can't
//     detect this case, but live polling will normally have it)
// Returns true if a notification was fired so the caller can skip the
// fallback watched-user alert path.
function maybeAlertOnReplyToMe(comment) {
  if (!comment) return false;
  if (!isUserAway()) return false;
  if (!state.user || state.user.id == null) return false;
  const myId = state.user.id;
  // Don't alert about my own replies.
  const authorId =
    comment.user_id ?? (comment.author && comment.author.id);
  if (authorId === myId) return false;

  let targetIsMe = false;

  // Quote-reply: c.quote was attached by unwrapComment from raw.quote.
  if (comment.quote) {
    const qAuthorId =
      comment.quote.user_id ??
      (comment.quote.author && comment.quote.author.id);
    if (qAuthorId === myId) targetIsMe = true;
  }

  // Threaded reply: parent_id points at a comment we may have cached.
  if (!targetIsMe && comment.parent_id) {
    const parent = state.comments.get(comment.parent_id);
    if (parent) {
      const pAuthorId =
        parent.user_id ?? (parent.author && parent.author.id);
      if (pAuthorId === myId) targetIsMe = true;
    }
  }

  if (!targetIsMe) return false;

  const name = (comment.author && comment.author.name) || "Someone";
  const preview = (comment.body || "").slice(0, 200);
  try {
    chrome.runtime.sendMessage({
      type: "notify",
      title: `↩ Reply from ${name}`,
      message: preview || "(replied to your message)",
      mentionRef: comment.id,
    });
  } catch (_) {}
  incrementUnreadMentions();
  return true;
}

// Fires one OS notification per new message. Caller passes either a
// single comment or an array. Each notification gets a stable id keyed
// by the comment's own id so polling can't double-fire if it later sees
// the same comment again, but every distinct comment stacks as its own
// notification.
function maybeAlertAllMessages(newlyAdded) {
  if (!state.notifyAllMessages) {
    console.log(
      "[BetterSSC notify-all] skip — toggle is off (click 🔔 in header)"
    );
    return;
  }
  if (!isUserAway()) {
    console.log(
      "[BetterSSC notify-all] skip — tab is visible AND window has focus",
      {
        "document.hidden": document.hidden,
        "document.visibilityState": document.visibilityState,
        "document.hasFocus()": document.hasFocus(),
      }
    );
    return;
  }
  const list = Array.isArray(newlyAdded) ? newlyAdded : [newlyAdded];
  if (!list.length) return;
  const pubName =
    (state.publication && state.publication.name) || "Substack chat";
  for (const c of list) {
    if (!c || !c.id) continue;
    const author = (c.author && c.author.name) || "Someone";
    const body = (c.body || "").slice(0, 140);
    console.log(
      `[BetterSSC notify-all] firing for ${c.id} — ${author}: ${body.slice(0, 60)}`
    );
    try {
      // Chat acronym ("Za's Market Terminal" → "ZMT") leads so a quick
      // glance disambiguates between BetterSSC tabs even when the title
      // truncates. Author follows after a colon; body carries the
      // message text only.
      const tag = chatNameAcronym(pubName);
      chrome.runtime.sendMessage({
        type: "notify",
        title: `${tag}: ${author}`,
        message: body || "(message)",
        mentionRef: c.id,
        notificationId: `bssc-allmsg-${c.id}`,
      });
    } catch (_) {}
  }
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
  if (!isUserAway()) return; // only when user is away
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

// Renders the post-author avatar next to the pub name, the user's own
// avatar in the top-right slot, and the post body in the collapsible
// panel. Called once on initial load + when state.user / state.post
// arrive; the click handler on .header-left toggles panel visibility.
// Merge state.user with _userTable so we pick up the photo_url that
// arrived via comment ingest. fetchUserIdentity only returns {id, name}
// — without this merge the header would always show a letter
// placeholder for "you" even after we've seen your photo in chat.
function getResolvedSelf() {
  if (!state.user) return null;
  let cached = state.user.id != null ? _userTable.get(state.user.id) : null;
  // Name-match fallback — the analytics-config id and comment.user_id
  // can differ in some publications.
  if ((!cached || !cached.photo_url) && state.user.name) {
    const wantName = state.user.name.toLowerCase();
    for (const entry of _userTable.values()) {
      if (entry && entry.name && entry.name.toLowerCase() === wantName) {
        cached = entry;
        break;
      }
    }
  }
  // Last resort: scan state.comments for any message by us. Message
  // rendering proves Inder's photo is somewhere in the ingested data
  // (chat avatars show correctly); ingestComment just doesn't always
  // push it into _userTable. Walking comments at render time is cheap
  // and fixes the case where my own messages haven't been registered
  // as "user objects" but their author payload carries the photo.
  let foundPhoto = cached && cached.photo_url;
  if (!foundPhoto) {
    const myId = state.user.id;
    const wantName = (state.user.name || "").toLowerCase();
    for (const c of state.comments.values()) {
      const a = c && c.author;
      if (!a || !a.photo_url) continue;
      const matchById = myId != null && a.id === myId;
      const matchByName =
        !matchById && wantName && a.name && a.name.toLowerCase() === wantName;
      if (matchById || matchByName) {
        foundPhoto = a.photo_url;
        if (!cached) cached = { name: a.name, handle: a.handle };
        break;
      }
    }
  }
  return {
    id: state.user.id,
    name: state.user.name || (cached && cached.name) || "You",
    handle: state.user.handle || (cached && cached.handle) || null,
    photo_url:
      state.user.photo_url || foundPhoto || (cached && cached.photo_url) || null,
  };
}

function extractPostBody(post) {
  if (!post) return "";
  return (
    post.body ||
    post.body_text ||
    post.body_markdown ||
    post.body_html ||
    ""
  );
}

function renderChatHeader() {
  const pubNameEl = document.getElementById("pubName");
  const postTitleEl = document.getElementById("postTitle");
  if (pubNameEl) {
    pubNameEl.textContent =
      (state.publication && state.publication.name) ||
      `Publication ${state.publicationId}`;
  }
  const postAuthor =
    (state.post && (state.post.user || state.post.author)) ||
    (state.publication &&
      (state.publication.author || state.publication.user)) ||
    null;
  const fullBody = extractPostBody(state.post);
  if (postTitleEl) {
    const titlePrefix = postAuthor && postAuthor.name ? `${postAuthor.name} · ` : "";
    const snippet = fullBody.slice(0, 80);
    postTitleEl.textContent = `${titlePrefix}${snippet}`.trim() || "Open chat";
  }
  const authorSlot = document.getElementById("postAuthorAvatar");
  if (authorSlot) {
    authorSlot.innerHTML = "";
    if (postAuthor) {
      authorSlot.appendChild(makeAvatar(postAuthor, "msg-avatar"));
      authorSlot.setAttribute(
        "title",
        postAuthor.name || postAuthor.handle || ""
      );
    }
  }
  const userSlot = document.getElementById("userAvatarSlot");
  if (userSlot) {
    userSlot.innerHTML = "";
    const self = getResolvedSelf();
    if (self) {
      userSlot.appendChild(makeAvatar(self, "msg-avatar"));
      userSlot.setAttribute("title", self.name || "You");
    }
  }
  // Modal: render meta + body once. Visibility is toggled by the
  // backdrop's .hidden class.
  const titleEl = document.getElementById("postModalTitle");
  if (titleEl) {
    titleEl.textContent =
      (state.publication && state.publication.name) || "Post";
  }
  const meta = document.getElementById("postModalMeta");
  const body = document.getElementById("postModalBody");
  if (meta) {
    meta.innerHTML = "";
    if (postAuthor && postAuthor.name) {
      const strong = document.createElement("strong");
      strong.textContent = postAuthor.name;
      meta.appendChild(strong);
    }
    if (state.post && state.post.date) {
      const span = document.createElement("span");
      try {
        span.textContent = new Date(state.post.date).toLocaleString();
      } catch (_) {
        span.textContent = state.post.date;
      }
      meta.appendChild(span);
    }
  }
  if (body) {
    body.textContent = fullBody || "(this chat doesn't have a post body)";
  }
}

function openPostModal() {
  const backdrop = document.getElementById("postModalBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("hidden");
  const btn = document.getElementById("headerLeft");
  if (btn) btn.setAttribute("aria-expanded", "true");
  // Focus the close button so Esc / Enter work immediately.
  const closeBtn = document.getElementById("postModalClose");
  if (closeBtn) closeBtn.focus();
}

function closePostModal() {
  const backdrop = document.getElementById("postModalBackdrop");
  if (!backdrop) return;
  backdrop.classList.add("hidden");
  const btn = document.getElementById("headerLeft");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

// ============================================================
// AI INSIGHTS (BYOK — bring your own key)
// ============================================================
//
// Click the "✨ AI Insights" header button to summarize whatever is
// currently visible in the feed (respects active search + thread filter).
// First click prompts for a provider + API key; subsequent clicks
// generate a fresh insight using the saved config.
//
// Insights render as a special LOCAL-ONLY message authored by
// "✨ BetterSSC AI". They are stored in state.comments with
// _aiGenerated:true, never POSTed to Substack, never included in the
// poll cursor, and never decorated with reaction / reply UI.
//
// Privacy: the API call goes directly from the extension page to the
// provider's API host. We do NOT route through the substack.com proxy
// tab — that would leak chat content into Substack's network trail.
// The user's own API key is held in chrome.storage.local (per-browser-
// profile, OS-keychain-protected).

const AI_AUTHOR = {
  id: "bssc-ai",
  name: "✨ BetterSSC AI",
  handle: null,
  photo_url: null,
};

function buildAiMessage(id, body, providerName, opts = {}) {
  return {
    id,
    body,
    created_at: new Date().toISOString(),
    author: AI_AUTHOR,
    user_id: "bssc-ai",
    _aiGenerated: true,
    _aiProvider: providerName,
    _aiPending: !!opts.pending,
    _aiError: !!opts.error,
  };
}

// Pick the messages currently visible to the user. Mirrors the same
// filter logic applySearch uses on the DOM, but operates on state so
// the result is an array of comment objects (oldest → newest, no AI
// rows since those aren't context for further insights).
// Single source of truth for "does this comment match the currently
// active search + thread filter?" Used by the AI Insights visible-set
// builder AND by the poll/WS new-message bucketing path so the
// bottom-pill count and the AI summary always agree on what's "in
// filter." AI-generated rows are excluded by design (they're never
// part of either count).
// Focus-mode predicate with memoization. Delegates the ancestor-walk to
// lib/focus.js, passing a live accessor into state.comments. The memo is
// rebuilt lazily after setFocusFilter() clears it.
function commentInFocus(c) {
  if (isFocusEmpty(state.focusFilter)) return true;
  if (!c) return false;
  if (!state._focusMemo) state._focusMemo = new Map();
  return commentMatchesFocus(
    c,
    state.focusFilter,
    (id) => state.comments.get(id),
    state._focusMemo
  );
}

function commentMatchesActiveFilter(c) {
  if (!c || c._aiGenerated) return false;
  const hasSearch = !!(state.searchQuery && state.searchQuery.trim());
  const hasThread = !!state.threadFilter;
  const hasFocus = !isFocusEmpty(state.focusFilter);
  if (!hasSearch && !hasThread && !hasFocus) return true;
  if (hasFocus && !commentInFocus(c)) return false;
  if (hasThread) {
    const parentId = state.threadFilter.parentId;
    if (c.id !== parentId) {
      const refs = state.threadIndex && state.threadIndex.get(parentId);
      if (!refs || !refs.has(c.id)) return false;
    }
  }
  if (hasSearch) {
    const matcher = parseSearchQuery(state.searchQuery.trim());
    if (matcher && matcher.test && !matcher.test(c)) return false;
  }
  return true;
}

function getVisibleCommentsForAi() {
  return state.order
    .map((id) => state.comments.get(id))
    .filter((c) => c && !c._aiGenerated && commentMatchesActiveFilter(c));
}

// When the user has narrowed the chat to a single person via @<name>,
// /from:<name>, or /me, return that person's display name. Used by
// runAiInsights to tell the LLM to phrase the summary in third person
// from that person's viewpoint ("In Jordan's view, ..."). Returns null
// when the filter isn't author-scoped or there's no filter at all.
function detectFocusedAuthorName() {
  const raw = (state.searchQuery || "").trim();
  if (!raw) return null;
  if (raw.startsWith("@")) {
    const name = raw.slice(1).trim();
    return name || null;
  }
  const lower = raw.toLowerCase();
  const cmd = lower.startsWith("/") ? lower.slice(1) : lower;
  if (cmd === "me") {
    return (state.user && state.user.name) || null;
  }
  if (cmd.startsWith("from:")) {
    // Preserve the user's original casing for display.
    const fromIdx = lower.indexOf("from:");
    const name = raw.slice(fromIdx + 5).trim();
    return name || null;
  }
  return null;
}

async function handleAiInsightsClick() {
  if (state.aiBusy) return;
  const provider = state.aiProvider;
  const key = provider ? state.aiKeys[provider] : null;
  if (!provider || !key) {
    openAiSettingsModal();
    return;
  }
  await runAiInsights(provider, key, { variant: "normal" });
}

async function regenerateAiInsight(variant) {
  if (state.aiBusy) return;
  const provider = state.aiProvider;
  const key = provider ? state.aiKeys[provider] : null;
  if (!provider || !key) {
    openAiSettingsModal();
    return;
  }
  await runAiInsights(provider, key, { variant });
}

async function runAiInsights(providerName, apiKey, opts = {}) {
  const variant = opts.variant || "normal";
  const providerObj = PROVIDERS[providerName];
  if (!providerObj) {
    showError("AI Insights: unknown provider");
    return;
  }
  state.aiBusy = true;
  setAiButtonBusy(true);

  const aiId = `ai_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const pending = buildAiMessage(
    aiId,
    "_Generating insights…_",
    providerName,
    { pending: true }
  );
  state.comments.set(aiId, pending);
  insertInOrder(pending);
  renderAll();
  scrollToBottom();

  const visible = getVisibleCommentsForAi();
  const budgetChars =
    typeof state.aiBudgetChars === "number" && state.aiBudgetChars > 0
      ? state.aiBudgetChars
      : undefined;
  const { context, included, dropped } = formatMessagesForLLM(visible, {
    budget: budgetChars,
  });
  const focusedAuthor = detectFocusedAuthorName();
  const systemPrompt = buildSystemPrompt(context, {
    lensHint: state.aiLensHint || undefined,
    formatTemplate: state.aiFormatTemplate || undefined,
    focusedAuthor,
  });

  try {
    // 30s timeout — provider hangs would otherwise lock aiBusy forever
    // (button disabled until page reload, no recourse for the user).
    const signal = AbortSignal.timeout(30_000);
    const result = await callProvider(providerObj, {
      systemPrompt,
      conversation: [
        { role: "user", content: buildPreviewUserMessage({ variant }) },
      ],
      apiKey,
      signal,
      model: state.aiModel || undefined,
      maxTokens:
        typeof state.aiMaxTokens === "number" && state.aiMaxTokens > 0
          ? state.aiMaxTokens
          : undefined,
    });
    const row = state.comments.get(aiId);
    if (!row) return; // dismissed mid-flight
    row._aiPending = false;
    row._aiContextInfo = { included, dropped };
    row._aiVariant = variant;
    if (result.error) {
      row._aiError = true;
      row.body = `**Error:** ${sanitizeProviderError(result.error)}`;
    } else {
      row.body = result.text;
    }
    renderAll();
  } finally {
    state.aiBusy = false;
    setAiButtonBusy(false);
  }
}

function dismissAiMessage(id) {
  if (!state.comments.has(id)) return;
  state.comments.delete(id);
  const idx = state.order.indexOf(id);
  if (idx !== -1) state.order.splice(idx, 1);
  renderAll();
}

function setAiButtonBusy(busy) {
  const btn = document.getElementById("aiInsightsBtn");
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle("is-busy", busy);
  // Keep the compact label in both states — the header decongestion pass
  // shortened "✨ AI Insights" → "✨ AI" but this function was overwriting
  // back to the long label after every insight finished, growing the
  // header again.
  btn.textContent = busy ? "✨ Thinking…" : "✨ AI";
}

// ----- ✨ AI hover dropdown -----
//
// The header *AI button reveals a 2-item menu on hover/focus (CSS-only)
// AND on click for touch / keyboard users (we toggle .is-open). The two
// items dispatch to:
//   action="summary" → existing one-click insights flow
//   action="ask"     → opens the Ask BetterSSC AI input box (commit 3+)
//
// We close on outside-click and on Esc. The hover CSS handles its own
// open state; the .is-open class is the touch-friendly persistence so
// the menu stays put after a tap.

function wireAiMenu() {
  const menu = document.getElementById("aiMenu");
  const btn = document.getElementById("aiInsightsBtn");
  if (!menu || !btn) return;

  const setOpen = (open) => {
    menu.classList.toggle("is-open", !!open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };

  btn.addEventListener("click", (e) => {
    // Don't fire the legacy "run summary on click" behavior — clicking
    // the button now toggles the menu. Users pick an action explicitly.
    e.preventDefault();
    setOpen(!menu.classList.contains("is-open"));
  });

  // Hard-close after item click: the CSS shows the popup on :hover OR
  // :focus-within OR .is-open. Removing .is-open alone leaves the
  // popup visible because the cursor is still hovering over the
  // just-clicked button and the button still has focus.
  // .is-suppressed wins via display:none !important. We also blur()
  // the active element so :focus-within clears immediately.
  // mouseleave on the menu drops the suppression so the next
  // intentional hover re-opens cleanly; a 1500ms safety timer covers
  // touch users who may never fire mouseleave.
  let suppressTimer = null;
  const clearSuppress = () => {
    menu.classList.remove("is-suppressed");
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  };
  const suppressMenu = () => {
    setOpen(false);
    menu.classList.add("is-suppressed");
    if (document.activeElement && menu.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(clearSuppress, 1500);
  };
  menu.addEventListener("mouseleave", clearSuppress);

  // Dropdown item routing — delegated so a re-render of menu contents
  // (none today, but cheap insurance) doesn't strand listeners.
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".ai-menu-item");
    if (!item) return;
    const action = item.getAttribute("data-ai-action");
    suppressMenu();
    if (action === "summary") {
      handleAiInsightsClick();
    } else if (action === "ask") {
      openAiAskBox();
    }
  });

  // Outside-click closes the menu. Hover-only would leave the menu
  // dangling on touch devices that don't fire hover-out.
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target)) setOpen(false);
  });

  // Keyboard contract for role=menu / role=menuitem: ArrowDown / ArrowUp
  // cycle focus between items; Esc closes and returns focus to the trigger.
  // Without this, a keyboard-only user who opened the menu via Enter/Space
  // on the trigger has no way to reach the items — the WAI-ARIA menu role
  // advertises a contract we have to honor.
  const getItems = () =>
    Array.from(menu.querySelectorAll(".ai-menu-item"));

  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      const items = getItems();
      if (items[0]) items[0].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const items = getItems();
      if (items.length) items[items.length - 1].focus();
    }
  });

  menu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = getItems();
    if (!items.length) return;
    const active = document.activeElement;
    const idx = items.indexOf(active);
    e.preventDefault();
    const next =
      e.key === "ArrowDown"
        ? items[(idx + 1 + items.length) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next.focus();
  });

  // Esc closes — match the modal / picker convention.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("is-open")) {
      setOpen(false);
      btn.focus();
    }
  });
}

// ----- 💬 Ask BetterSSC AI -----
//
// Free-form Q&A grounded in the chat. The user types a question; we
// stuff the entire chat into the system prompt (subject only to the
// provider's context-window limit) and dispatch to their configured
// provider. The model answers in 3 sections: From the chat / From the
// web (commit 4 wires the web tool) / Synthesis.
//
// Default budget is ASK_DEFAULT_BUDGET_CHARS (750k chars ≈ 187K tokens)
// so Anthropic 200K fits whole, OpenAI 128K may truncate oldest-first
// (formatMessagesForLLM emits "[earlier messages omitted…]"), Gemini
// 1M is wildly under. We never silently drop without surfacing it.

function openAiAskBox() {
  if (state.aiAskBusy) return;
  const provider = state.aiProvider;
  const key = provider ? state.aiKeys[provider] : null;
  if (!provider || !key) {
    openAiSettingsModal();
    return;
  }
  // Replace any prior modal — no stacking.
  const existing = document.getElementById("aiAskBackdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "aiAskBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Ask BetterSSC AI");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal ai-ask-modal";

  const header = document.createElement("header");
  header.className = "ai-settings-header";
  const title = document.createElement("h2");
  title.className = "ai-settings-title";
  title.textContent = "💬 Ask BetterSSC AI";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeAiAskBox);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "ai-settings-body";

  const visible = getVisibleCommentsForAi();
  const webOn =
    supportsWebSearch(provider) &&
    (state.aiAskWebSearch === false ? false : true);
  const note = document.createElement("p");
  note.className = "ai-settings-note";
  const webBlurb = webOn
    ? "Web search is on — the model uses it only when the chat alone can't answer."
    : supportsWebSearch(provider)
      ? "Web search is off (toggle in Tune AI model)."
      : "Web search isn't supported on this provider yet — the model will answer strictly from the chat.";
  note.textContent = `Your question goes to ${provider} with the visible chat (${visible.length} message${visible.length === 1 ? "" : "s"}) attached, up to the provider's context limit. ${webBlurb}`;
  body.appendChild(note);

  const textarea = document.createElement("textarea");
  textarea.className = "ai-ask-textarea";
  textarea.placeholder = "e.g. What's the bull thesis on CRWV? Who's been bearish on SPX this week?";
  textarea.rows = 3;
  body.appendChild(textarea);

  const footer = document.createElement("footer");
  footer.className = "ai-settings-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ai-settings-btn ai-settings-btn-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeAiAskBox);
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "ai-settings-save";
  submit.textContent = "Ask";
  const dispatch = () => {
    const question = textarea.value.trim();
    if (!question) {
      textarea.focus();
      return;
    }
    closeAiAskBox();
    void runAiAsk(provider, key, question);
  };
  submit.addEventListener("click", dispatch);
  // Enter submits; Shift+Enter inserts a newline. Matches what users expect
  // from chat-style input boxes.
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      dispatch();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeAiAskBox();
    }
  });
  footer.appendChild(cancel);
  footer.appendChild(submit);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeAiAskBox();
  });
  document.body.appendChild(backdrop);
  // Wait for next animation frame so layout has settled (renderAll may
  // have just run) before focusing — more reliable than setTimeout(0)
  // when the page is under paint pressure.
  requestAnimationFrame(() => textarea.focus());
}

function closeAiAskBox() {
  const el = document.getElementById("aiAskBackdrop");
  if (el) el.remove();
}

async function runAiAsk(providerName, apiKey, question) {
  const providerObj = PROVIDERS[providerName];
  if (!providerObj) {
    showError("Ask BetterSSC AI: unknown provider");
    return;
  }
  state.aiAskBusy = true;

  const aiId = `ai_ask_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const pending = buildAiMessage(
    aiId,
    `**Q:** ${question}\n\n_Thinking…_`,
    providerName,
    { pending: true }
  );
  pending._aiAskQuestion = question;
  state.comments.set(aiId, pending);
  insertInOrder(pending);
  renderAll();
  scrollToBottom();

  const visible = getVisibleCommentsForAi();
  // Ask mode stuffs the entire chat — formatMessagesForLLM still does
  // oldest-first truncation if the chat exceeds the budget, and surfaces
  // the drop count in the footer via _aiContextInfo. Generous default
  // (750k chars) means Anthropic 200K rarely truncates.
  const { context, included, dropped } = formatMessagesForLLM(visible, {
    budget: ASK_DEFAULT_BUDGET_CHARS,
  });
  // Web search is only on if the provider supports it (anthropic/google)
  // AND the user hasn't disabled it via Tune dialog. Anthropic returns a
  // validation error if the model emits a web_search tool call without
  // the tool being attached — so the system-prompt instruction MUST track
  // the actual tool attachment exactly.
  const webSearchEnabled =
    supportsWebSearch(providerName) &&
    (state.aiAskWebSearch === false ? false : true);
  const systemPrompt = buildAskSystemPrompt(context, {
    lensHint: state.aiLensHint || undefined,
    webSearchEnabled,
  });
  const userMessage = buildAskUserMessage(question);

  try {
    // 60s — Ask mode chats are longer and may invoke web search, so we
    // double the summary-mode timeout.
    const signal = AbortSignal.timeout(60_000);
    const result = await callProvider(providerObj, {
      systemPrompt,
      conversation: [{ role: "user", content: userMessage }],
      apiKey,
      signal,
      model: state.aiModel || undefined,
      maxTokens:
        typeof state.aiAskMaxTokens === "number" && state.aiAskMaxTokens > 0
          ? state.aiAskMaxTokens
          : 4096,
      webSearchEnabled,
    });
    const row = state.comments.get(aiId);
    if (!row) return; // dismissed mid-flight
    row._aiPending = false;
    row._aiContextInfo = { included, dropped };
    row._aiVariant = "ask";
    if (result.error) {
      row._aiError = true;
      row.body = `**Q:** ${question}\n\n**Error:** ${sanitizeProviderError(result.error)}`;
    } else {
      // Stash citations for the sourced renderer (renderAiMessageItem
      // picks them up via _aiAskCitations on _aiVariant === "ask" rows).
      // Body stays as the model's raw markdown — the section parser in
      // ai-context handles structuring at render time.
      row._aiAskCitations = result.citations || null;
      row._aiAskQuestion = question;
      row.body = result.text;
    }
    renderAll();
  } finally {
    state.aiAskBusy = false;
  }
}

// ----- ✦ Explain (per-message inline AI) -----
//
// Walk the clicked message's reply/quote ancestors, send the thread to the
// configured provider WITH web search, and stash the result on the comment
// itself (c._explain / _explainPending / _explainError / _explainCitations)
// so renderMessageItem can render it inline under the message. We attach to
// the target comment instead of inserting an AI row into state.order so we
// don't perturb author-grouping, the j/k focus unit, or the focus memo.
//
// Concurrency: guarded PER MESSAGE via c._explainPending — clicking ✦ again
// while one is in flight on the same message is a no-op. Different messages
// can explain concurrently (each is an independent BYOK call); we do NOT
// share state.aiBusy with the header ✨ AI / Ask flows.
// Max images sent to the model per Explain call. Vision tokens are pricey
// and the markets use-case is usually a single chart; 4 covers a short
// image thread without blowing up cost/latency.
const EXPLAIN_MAX_IMAGES = 4;
// Max links surfaced to the model. Beyond a handful the model can't
// usefully web-read them all within one explain call.
const EXPLAIN_MAX_LINKS = 6;
// Raw-bytes ceiling for a base64-encoded image (Google path). Anthropic caps
// images ~5MB and base64 inflates ~33%; 4MB raw keeps us comfortably under.
const EXPLAIN_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Collect image attachment URLs across a thread for vision input. Target's
// own images come first (the thread is oldest→target, so we walk it in
// reverse) so they win the cap. Reuses the same extraction + image-detection
// the message renderer uses; SVG is excluded (not raster). Returns rewritten,
// deduped, capped URLs.
function collectThreadImages(thread) {
  if (!Array.isArray(thread) || !thread.length) return [];
  const out = [];
  const seen = new Set();
  // Reverse: target (last) first, then nearest ancestors.
  for (let i = thread.length - 1; i >= 0; i--) {
    const c = thread[i];
    if (!c) continue;
    const buckets = [c.media_uploads, c.threadMediaUploads, c.mediaAttachments, c.attachments];
    for (const b of buckets) {
      if (!Array.isArray(b)) continue;
      for (const a of b) {
        const raw = extractAttachmentUrl(a);
        if (!raw || !isImageUrl(raw)) continue;
        if (/\.svg(\?|$)/i.test(raw)) continue; // not raster — skip for vision
        const url = rewriteImageUrl(raw);
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= EXPLAIN_MAX_IMAGES) return out;
      }
    }
  }
  return out;
}

// Collect http(s) links referenced in a thread's message bodies. Image URLs
// are excluded (those go to vision, not web search). Deduped, capped.
function collectThreadLinks(thread) {
  if (!Array.isArray(thread) || !thread.length) return [];
  const out = [];
  const seen = new Set();
  // Exclude () and [] from the URL body so a parenthesized link in prose
  // ("(see https://reuters.com/markets/foo)") or a paren-containing slug
  // isn't truncated at the first ')'. Brackets get the same treatment.
  const urlRe = /https?:\/\/[^\s<>"'()[\]]+/gi;
  // Target (last) first so its links win the cap.
  for (let i = thread.length - 1; i >= 0; i--) {
    const c = thread[i];
    if (!c || typeof c.body !== "string") continue;
    const matches = c.body.match(urlRe);
    if (!matches) continue;
    for (let u of matches) {
      u = u.replace(/[.,;:!?]+$/, ""); // trim trailing sentence punctuation
      if (u.length > 500) continue; // skip pathological / pasted data URLs
      if (isImageUrl(u)) continue; // images handled via vision
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= EXPLAIN_MAX_LINKS) return out;
    }
  }
  return out;
}

// Fetch an image URL and return { data: <base64>, mediaType } for inline
// (Google) vision, or null on any failure / unsupported type / oversize.
// Never throws — a dead image must not break the explanation. Host perms
// (substackcdn/s3/giphy) let these cross-origin fetches succeed.
async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > EXPLAIN_MAX_IMAGE_BYTES) return null;
    let mediaType = (blob.type || "").toLowerCase();
    if (mediaType === "image/jpg") mediaType = "image/jpeg";
    if (!VISION_IMAGE_TYPES.includes(mediaType)) return null;
    const buf = new Uint8Array(await blob.arrayBuffer());
    // Chunked base64 — btoa(String.fromCharCode(...wholeArray)) overflows the
    // call stack on large images, so encode in 32KB slices.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return { data: btoa(binary), mediaType };
  } catch (_) {
    return null;
  }
}

async function runExplain(comment, opts = {}) {
  if (!comment || !comment.id) return;
  const target = state.comments.get(comment.id);
  if (!target) return;
  if (target._pending || target._failed) return; // nothing stable to explain yet
  if (target._explainPending) return; // already in flight on this message

  const provider = state.aiProvider;
  const key = provider ? state.aiKeys[provider] : null;
  if (!provider || !key) {
    openAiSettingsModal();
    return;
  }
  const providerObj = PROVIDERS[provider];
  if (!providerObj) {
    showError("Explain: unknown provider");
    return;
  }

  // The clicked ✦ explains a LOGICAL GROUP — the head message PLUS any
  // same-author continuation messages the user typed as one thought. Default
  // to just the target when no group was passed (single-message group / old
  // callers).
  const groupItems =
    Array.isArray(opts.groupItems) && opts.groupItems.length
      ? opts.groupItems.filter((c) => c && c.id)
      : [target];

  // Assemble the thread: the head's reply/quote ancestors (oldest → head),
  // then the rest of the logical group's messages. collectThreadForExplain
  // ends with the head, so drop that and append the full group so the head
  // isn't duplicated. Cycle/depth-bounded ancestor walk over the live store.
  const ancestorChain = collectThreadForExplain(
    target.id,
    (id) => state.comments.get(id)
  );
  const thread = ancestorChain.slice(0, -1).concat(groupItems);
  const { context, included, dropped } = formatMessagesForLLM(thread, {
    budget: ASK_DEFAULT_BUDGET_CHARS,
  });

  // Gather the whole group's embedded images (charts/screenshots) and any
  // links in the bodies so the model explains the WHOLE thought, not just its
  // first line. Images become real vision input; links are surfaced for the
  // model to read via web search. Both are capped + deduped (see helpers).
  const imageUrls = collectThreadImages(thread);
  const links = collectThreadLinks(thread);
  // Continuation bodies are intentionally surfaced twice: once in the CHAT
  // CONTEXT transcript (via `thread`) for ordering/attribution, and again in
  // the user message as "(cont'd)" lines so the model knows EXACTLY which
  // lines form the one target thought vs. the surrounding ancestor context.
  // Each is snippet-capped, so the cost of the overlap is bounded.
  const continuations = groupItems.slice(1).map((c) => c.body);

  // Web search: same gate as Ask mode — on when the provider supports it
  // and the user hasn't disabled it. The instruction in the system prompt
  // MUST match the actual tool attachment, so we compute it once and feed
  // BOTH buildExplainSystemPrompt and callProvider the same boolean.
  const webSearchEnabled =
    supportsWebSearch(provider) &&
    (state.aiAskWebSearch === false ? false : true);
  const userMessage = buildExplainUserMessage(target, { links, continuations });

  // Mark pending + render the inline placeholder. Stash the group on the head
  // so the inline "Try again" button can re-run with the SAME group (the
  // retry path must carry the same context as the primary path).
  target._explainPending = true;
  target._explainError = false;
  target._explainProvider = provider;
  target._explainGroupItems = groupItems;
  // Surgical insert — NOT renderAll(). A full re-render here would paint the
  // deferred background-prefetch backlog above the viewport and teleport the
  // feed (the backlog's images load async and beat any scroll anchor).
  renderExplainInline(target, groupItems);

  try {
    // Build the images payload. Anthropic + OpenAI fetch remote image URLs
    // server-side, so we pass the URL untouched (no CORS, any host). Google's
    // generateContent only takes inline base64, so we pre-fetch + encode for
    // it (host perms cover substackcdn/s3/giphy). Any image whose fetch fails
    // is dropped — the text + links explanation still goes through.
    let images;
    if (imageUrls.length) {
      if (provider === "google") {
        const encoded = await Promise.all(imageUrls.map(fetchImageAsBase64));
        images = encoded.filter(Boolean);
      } else {
        images = imageUrls.map((url) => ({ url }));
      }
    }

    // Build the system prompt AFTER image resolution so its "images attached"
    // claim reflects what's ACTUALLY sent — a Google call whose base64
    // fetches all failed must not be told images are present.
    const hasImages = Array.isArray(images) && images.length > 0;
    const systemPrompt = buildExplainSystemPrompt(context, {
      lensHint: state.aiLensHint || undefined,
      webSearchEnabled,
      hasImages,
    });

    const signal = AbortSignal.timeout(60_000);
    const result = await callProvider(providerObj, {
      systemPrompt,
      conversation: [{ role: "user", content: userMessage }],
      apiKey: key,
      signal,
      model: state.aiModel || undefined,
      images,
      // Explain output is deliberately short (one-line gist + 2-4 bullets),
      // but web-search grounding tokens share this budget — 2048 leaves
      // ample headroom over a typical response without letting a verbose
      // model ramble. Honors the user's Tune setting when they've set one.
      maxTokens:
        typeof state.aiAskMaxTokens === "number" && state.aiAskMaxTokens > 0
          ? state.aiAskMaxTokens
          : 2048,
      webSearchEnabled,
    });
    // Re-read: the message could have been removed by a re-sync mid-flight.
    const row = state.comments.get(target.id);
    if (!row) return;
    row._explainPending = false;
    row._explainContextInfo = {
      included,
      dropped,
      imageCount: Array.isArray(images) ? images.length : 0,
      linkCount: links.length,
    };
    if (result.error) {
      row._explainError = true;
      row._explain = sanitizeProviderError(result.error);
      row._explainCitations = null;
    } else {
      row._explainError = false;
      row._explain = result.text;
      row._explainCitations = result.citations || null;
    }
    renderExplainInline(row, groupItems);
  } catch (e) {
    // Defensive only: callProvider never throws (it maps aborts/timeouts/
    // network failures to a { error } envelope handled above). This catches
    // an unexpected throw from the surrounding render/state path so a stray
    // exception can't strand _explainPending = true forever.
    const row = state.comments.get(target.id);
    if (row) {
      row._explainPending = false;
      row._explainError = true;
      row._explain = sanitizeProviderError(String((e && e.message) || e));
    }
    renderExplainInline(row || target, groupItems);
  }
}

// Clear an inline explanation from a message (the ✕ on the explain block).
function dismissExplain(id) {
  const row = state.comments.get(id);
  if (!row) return;
  delete row._explain;
  delete row._explainPending;
  delete row._explainError;
  delete row._explainCitations;
  delete row._explainContextInfo;
  delete row._explainProvider;
  delete row._explainGroupItems;
  // Surgical removal — no full re-render, so dismiss can't shift the feed.
  renderExplainInline(row);
}

// ----- Settings modal -----

function openAiSettingsModal() {
  closeAiSettingsModal();
  const backdrop = document.createElement("div");
  backdrop.id = "aiSettingsBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "AI Insights settings");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal";

  const header = document.createElement("header");
  header.className = "ai-settings-header";
  const title = document.createElement("h2");
  title.className = "ai-settings-title";
  title.textContent = "AI Insights — bring your own key";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeAiSettingsModal);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "ai-settings-body";

  const note = document.createElement("p");
  note.className = "ai-settings-note";
  note.innerHTML =
    "Your key is stored in <code>chrome.storage.local</code> on this device. " +
    "Chat content goes <em>directly</em> from your browser to your chosen provider — " +
    "no BetterSSC server, no proxy. The provider sees what you send.";
  body.appendChild(note);

  const providersWrap = document.createElement("div");
  providersWrap.className = "ai-settings-providers";
  const PROVIDER_META = [
    { value: "openai", label: "OpenAI", model: PROVIDERS.openai.model },
    { value: "anthropic", label: "Anthropic", model: PROVIDERS.anthropic.model },
    { value: "google", label: "Google", model: PROVIDERS.google.model },
  ];
  for (const p of PROVIDER_META) {
    const label = document.createElement("label");
    label.className = "ai-settings-provider";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "ai-provider";
    radio.value = p.value;
    if (state.aiProvider === p.value) radio.checked = true;
    const txt = document.createElement("span");
    const big = document.createElement("strong");
    big.textContent = p.label;
    const small = document.createElement("small");
    small.textContent = ` (${p.model})`;
    txt.appendChild(big);
    txt.appendChild(small);
    label.appendChild(radio);
    label.appendChild(txt);
    providersWrap.appendChild(label);
  }
  body.appendChild(providersWrap);

  const keyLabel = document.createElement("label");
  keyLabel.className = "ai-settings-key-label";
  keyLabel.textContent = "API key";
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.id = "aiSettingsKey";
  keyInput.placeholder = "sk-…  /  ai-…  /  AIza…";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  // Prefill when the user has an existing key for the selected provider.
  if (state.aiProvider && state.aiKeys[state.aiProvider]) {
    keyInput.value = state.aiKeys[state.aiProvider];
  }
  keyLabel.appendChild(keyInput);
  body.appendChild(keyLabel);

  const footer = document.createElement("footer");
  footer.className = "ai-settings-footer";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ai-settings-save";
  saveBtn.textContent = "Save & generate";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ai-settings-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeAiSettingsModal);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  // Refill the key input when the provider radio changes — so switching
  // providers shows the saved key for that provider (if any).
  providersWrap.addEventListener("change", () => {
    const selected = providersWrap.querySelector(
      'input[name="ai-provider"]:checked'
    );
    if (!selected) return;
    const saved = state.aiKeys[selected.value];
    keyInput.value = saved || "";
  });

  saveBtn.addEventListener("click", () => {
    const selected = providersWrap.querySelector(
      'input[name="ai-provider"]:checked'
    );
    if (!selected) {
      keyInput.focus();
      return;
    }
    const providerName = selected.value;
    const key = keyInput.value.trim();
    if (!key) {
      keyInput.focus();
      return;
    }
    state.aiProvider = providerName;
    state.aiKeys = { ...state.aiKeys, [providerName]: key };
    try {
      chrome.storage &&
        chrome.storage.local &&
        chrome.storage.local.set({
          bssc_ai_provider: state.aiProvider,
          bssc_ai_keys: state.aiKeys,
        });
    } catch (_) {}
    closeAiSettingsModal();
    // Guard against re-entry — the modal can only open when no key is
    // configured, so aiBusy is normally false here, but future code
    // paths could open the modal mid-flight. Belt-and-suspenders.
    if (state.aiBusy) return;
    runAiInsights(providerName, key);
  });

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeAiSettingsModal();
  });
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Focus the first unchecked radio (or the key input if a provider is
  // already selected) for fast keyboard flow.
  const checked = providersWrap.querySelector(
    'input[name="ai-provider"]:checked'
  );
  if (checked) keyInput.focus();
  else providersWrap.querySelector('input[name="ai-provider"]').focus();
}

function closeAiSettingsModal() {
  const el = document.getElementById("aiSettingsBackdrop");
  if (el) el.remove();
}

// ============================================================
// KEBAB MENU (header ⋮ — settings + tuning + reset)
// ============================================================

function toggleKebabMenu() {
  if (document.getElementById("kebabMenu")) {
    closeKebabMenu();
  } else {
    openKebabMenu();
  }
}

function openKebabMenu() {
  closeKebabMenu();
  const btn = document.getElementById("kebabMenuBtn");
  if (!btn) return;
  btn.setAttribute("aria-expanded", "true");
  const menu = document.createElement("div");
  menu.id = "kebabMenu";
  menu.className = "kebab-menu";
  menu.setAttribute("role", "menu");
  const rect = btn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  const items = [
    { label: "Tune AI model", handler: openTuneModelModal },
    { label: "Tune prompt", handler: openTunePromptModal },
    { label: "Chat preferences", handler: openChatPrefsModal },
    { label: "Reset all saved data", handler: openResetConfirmModal, danger: true },
  ];
  for (const item of items) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "kebab-menu-item" + (item.danger ? " is-danger" : "");
    el.setAttribute("role", "menuitem");
    el.textContent = item.label;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeKebabMenu();
      item.handler();
    });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("click", kebabOutsideClick, true);
    document.addEventListener("keydown", kebabEscape);
  }, 0);
}

function kebabOutsideClick(e) {
  const menu = document.getElementById("kebabMenu");
  const btn = document.getElementById("kebabMenuBtn");
  if (!menu) return;
  if (menu.contains(e.target)) return;
  if (btn && btn.contains(e.target)) return;
  closeKebabMenu();
}

function kebabEscape(e) {
  if (e.key === "Escape") closeKebabMenu();
}

function closeKebabMenu() {
  const menu = document.getElementById("kebabMenu");
  if (menu) menu.remove();
  const btn = document.getElementById("kebabMenuBtn");
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", kebabOutsideClick, true);
  document.removeEventListener("keydown", kebabEscape);
}

// ----- Tune Prompt dialog -----
//
// Two editable textareas:
// 1. Lens hint — describes what KIND of chat we're reading (default
//    trading-flavored, but Za Terminal isn't every BetterSSC user's
//    use case, so this is exposed).
// 2. Response format template — the "Format your response with these
//    sections" block. Editable.
//
// The focused-author perspective hint stays locked — it's mechanical
// (driven by the search filter) and breaking it would generate output
// that looks like a bug.

function openTunePromptModal() {
  const existing = document.getElementById("tunePromptBackdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "tunePromptBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Tune prompt");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal tune-prompt-modal";

  const header = document.createElement("header");
  header.className = "ai-settings-header";
  const title = document.createElement("h2");
  title.className = "ai-settings-title";
  title.textContent = "Tune prompt";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeTunePromptModal);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "ai-settings-body";

  const intro = document.createElement("p");
  intro.className = "ai-settings-note";
  intro.innerHTML =
    "Customize how the LLM frames its summary. The author-perspective " +
    "rule (third-person when you filter to one user) isn't editable " +
    "here — it's driven by the search filter, not the prompt.";
  body.appendChild(intro);

  // Lens hint
  function makeField({ labelText, helpText, currentValue, defaultValue, rows }) {
    const labelRow = document.createElement("div");
    labelRow.className = "tune-prompt-label-row";
    const labelEl = document.createElement("label");
    labelEl.className = "tune-label";
    labelEl.textContent = labelText;
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "tune-prompt-reset";
    resetBtn.textContent = "Reset to default";
    labelRow.appendChild(labelEl);
    labelRow.appendChild(resetBtn);
    body.appendChild(labelRow);
    const help = document.createElement("div");
    help.className = "tune-prompt-help";
    help.textContent = helpText;
    body.appendChild(help);
    const textarea = document.createElement("textarea");
    textarea.className = "tune-prompt-textarea";
    textarea.rows = rows;
    textarea.value = currentValue || defaultValue;
    body.appendChild(textarea);
    resetBtn.addEventListener("click", () => {
      textarea.value = defaultValue;
    });
    return textarea;
  }

  const lensTextarea = makeField({
    labelText: "Lens hint",
    helpText:
      "Tells the LLM what kind of chat this is. The default is trading-flavored — change it if you use BetterSSC for a different community.",
    currentValue: state.aiLensHint,
    defaultValue: DEFAULT_LENS_HINT,
    rows: 3,
  });

  const formatTextarea = makeField({
    labelText: "Response format template",
    helpText:
      "Tells the LLM what sections to emit. Each line that starts with '- **Name** — …' becomes a heading in the rendered summary.",
    currentValue: state.aiFormatTemplate,
    defaultValue: DEFAULT_FORMAT_TEMPLATE,
    rows: 7,
  });

  // Footer
  const footer = document.createElement("footer");
  footer.className = "ai-settings-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ai-settings-btn ai-settings-btn-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeTunePromptModal);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ai-settings-save";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    const lens = lensTextarea.value.trim();
    const fmt = formatTextarea.value.trim();
    // Empty string is treated as "use the default" — store undefined.
    state.aiLensHint = lens || null;
    state.aiFormatTemplate = fmt || null;
    try {
      chrome.storage &&
        chrome.storage.local &&
        chrome.storage.local.set({
          bssc_ai_lens_hint: lens,
          bssc_ai_format_template: fmt,
        });
    } catch (_) {}
    closeTunePromptModal();
  });
  footer.appendChild(cancel);
  footer.appendChild(save);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeTunePromptModal();
  });
  document.body.appendChild(backdrop);
}

function closeTunePromptModal() {
  const el = document.getElementById("tunePromptBackdrop");
  if (el) el.remove();
}

// ----- Tune AI Model dialog -----
//
// Lets the user:
// - Pick which (provider, model) combo to use — dropdown only shows
//   combos where a key is configured.
// - Adjust the input-context budget in chars (6K–200K).
// - See a live per-call cost estimate that updates on every change.
//
// Saves to chrome.storage.local: bssc_ai_provider, bssc_ai_model,
// bssc_ai_budget_chars, bssc_ai_max_tokens, bssc_ai_ask_max_tokens,
// bssc_ai_ask_web_search. Switching provider here ALSO updates
// state.aiProvider since the active provider IS one of the user-keyed
// ones (the dropdown wouldn't show it otherwise).

const TUNE_BUDGET_MIN = 6000;
const TUNE_BUDGET_MAX = 200_000;
const TUNE_BUDGET_DEFAULT = 60_000;
// Cost-estimate output-token assumption. We scale this with the chosen
// output cap (cap × 0.78) so the per-click figure tracks the user's
// configured headroom — most summaries land near the cap when the cap
// is generous, near 60-70% of cap when the cap is tight.
const TUNE_OUTPUT_FILL_RATE = 0.78;
const TUNE_CHARS_PER_TOKEN = 4;

function listAvailableProviderModels() {
  const out = [];
  for (const providerName of Object.keys(MODEL_CATALOG)) {
    const key = state.aiKeys && state.aiKeys[providerName];
    if (!key) continue;
    for (const model of MODEL_CATALOG[providerName]) {
      out.push({
        providerName,
        modelId: model.id,
        displayName: `${providerName} · ${model.displayName}`,
        info: model,
      });
    }
  }
  return out;
}

function estimateCostUsd({ inputChars, modelInfo, maxTokens }) {
  if (!modelInfo) return null;
  // Mirror the provider clamp floor (256) so a stray sub-floor value can't
  // produce a nonsense low estimate that disagrees with what the provider
  // actually bills against the clamped 256-token request.
  const cap = typeof maxTokens === "number" && maxTokens >= 256 ? maxTokens : DEFAULT_MAX_TOKENS;
  const inputTokens = inputChars / TUNE_CHARS_PER_TOKEN;
  const outputTokens = Math.round(cap * TUNE_OUTPUT_FILL_RATE);
  const inputUsd = (inputTokens / 1_000_000) * modelInfo.inputPer1M;
  const outputUsd = (outputTokens / 1_000_000) * modelInfo.outputPer1M;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd, inputTokens, outputTokens, cap };
}

function formatUsd(n) {
  if (n == null || isNaN(n)) return "—";
  if (n < 0.001) return "<$0.001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function openTuneModelModal() {
  const existing = document.getElementById("tuneModelBackdrop");
  if (existing) existing.remove();

  const combos = listAvailableProviderModels();
  if (combos.length === 0) {
    // No key on file — funnel the user into the first-time settings
    // modal instead. They can come back to Tune AI Model afterward.
    openAiSettingsModal();
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.id = "tuneModelBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Tune AI model");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal tune-model-modal";

  const header = document.createElement("header");
  header.className = "ai-settings-header";
  const title = document.createElement("h2");
  title.className = "ai-settings-title";
  title.textContent = "Tune AI model";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeTuneModelModal);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "ai-settings-body";

  // Provider · Model dropdown
  const modelLabel = document.createElement("label");
  modelLabel.className = "tune-label";
  modelLabel.textContent = "Provider & model";
  body.appendChild(modelLabel);
  const select = document.createElement("select");
  select.className = "tune-select";
  const currentProvider = state.aiProvider;
  const currentModel = state.aiModel || (PROVIDERS[currentProvider] && PROVIDERS[currentProvider].model);
  let initialIdx = 0;
  combos.forEach((combo, idx) => {
    const opt = document.createElement("option");
    opt.value = `${combo.providerName}|${combo.modelId}`;
    opt.textContent = combo.displayName;
    select.appendChild(opt);
    if (combo.providerName === currentProvider && combo.modelId === currentModel) {
      initialIdx = idx;
    }
  });
  select.selectedIndex = initialIdx;
  body.appendChild(select);

  // Budget slider
  const budgetLabel = document.createElement("label");
  budgetLabel.className = "tune-label";
  budgetLabel.textContent = "Input context budget (chars)";
  body.appendChild(budgetLabel);

  const sliderRow = document.createElement("div");
  sliderRow.className = "tune-slider-row";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(TUNE_BUDGET_MIN);
  slider.max = String(TUNE_BUDGET_MAX);
  slider.step = "1000";
  const initialBudget =
    typeof state.aiBudgetChars === "number" ? state.aiBudgetChars : TUNE_BUDGET_DEFAULT;
  slider.value = String(Math.max(TUNE_BUDGET_MIN, Math.min(TUNE_BUDGET_MAX, initialBudget)));
  const budgetReadout = document.createElement("span");
  budgetReadout.className = "tune-readout";
  sliderRow.appendChild(slider);
  sliderRow.appendChild(budgetReadout);
  body.appendChild(sliderRow);

  // Output cap selector — controls max_tokens sent to the provider for the
  // ✨ AI Insights summary call. Default 2048; raise to 4096 for dense
  // briefings, drop to 1024 to save cost on short summaries.
  const capLabel = document.createElement("label");
  capLabel.className = "tune-label";
  capLabel.textContent = "Summary output cap (max tokens)";
  body.appendChild(capLabel);

  const capRow = document.createElement("div");
  capRow.className = "tune-radio-row";
  const initialCap =
    typeof state.aiMaxTokens === "number" && state.aiMaxTokens > 0
      ? state.aiMaxTokens
      : DEFAULT_MAX_TOKENS;
  const capRadios = [];
  for (const opt of MAX_TOKENS_OPTIONS) {
    const label = document.createElement("label");
    label.className = "tune-radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "tune-max-tokens";
    radio.value = String(opt);
    if (opt === initialCap) radio.checked = true;
    const txt = document.createElement("span");
    txt.textContent = `${opt.toLocaleString()} tokens`;
    label.appendChild(radio);
    label.appendChild(txt);
    capRow.appendChild(label);
    capRadios.push(radio);
  }
  body.appendChild(capRow);

  // ----- Ask BetterSSC AI — separate output cap + web search toggle -----
  // Ask responses run longer (3 sections + citations) so default is 4096.
  // Web search is per-call and disabled on providers we can't wire (openai).

  const askSectionLabel = document.createElement("label");
  askSectionLabel.className = "tune-label";
  askSectionLabel.textContent = "Ask output cap (max tokens)";
  body.appendChild(askSectionLabel);

  const askCapRow = document.createElement("div");
  askCapRow.className = "tune-radio-row";
  const ASK_DEFAULT_CAP = 4096;
  const initialAskCap =
    typeof state.aiAskMaxTokens === "number" && state.aiAskMaxTokens > 0
      ? state.aiAskMaxTokens
      : ASK_DEFAULT_CAP;
  const askCapRadios = [];
  for (const opt of MAX_TOKENS_OPTIONS) {
    const label = document.createElement("label");
    label.className = "tune-radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "tune-ask-max-tokens";
    radio.value = String(opt);
    if (opt === initialAskCap) radio.checked = true;
    const txt = document.createElement("span");
    txt.textContent = `${opt.toLocaleString()} tokens`;
    label.appendChild(radio);
    label.appendChild(txt);
    askCapRow.appendChild(label);
    askCapRadios.push(radio);
  }
  body.appendChild(askCapRow);

  const webLabel = document.createElement("label");
  webLabel.className = "tune-label";
  webLabel.textContent = "Ask web search";
  body.appendChild(webLabel);

  const webRow = document.createElement("div");
  webRow.className = "tune-toggle-row";
  const webCheckbox = document.createElement("input");
  webCheckbox.type = "checkbox";
  webCheckbox.id = "tuneAskWebSearch";
  // Default ON; user-toggle persists via bssc_ai_ask_web_search.
  // `!== false` is intentional: null / undefined / true → checked,
  // explicit false → unchecked.
  webCheckbox.checked = state.aiAskWebSearch !== false;
  const webText = document.createElement("label");
  webText.htmlFor = "tuneAskWebSearch";
  webText.className = "tune-toggle-label";
  // Show provider-specific support state — Anthropic / Google supported,
  // OpenAI not yet (requires Responses API migration). The closure
  // re-reads the provider on every call so changes from the dropdown
  // re-paint cleanly.
  const renderWebSupportNote = () => {
    const p = combos[select.selectedIndex] && combos[select.selectedIndex].providerName;
    if (supportsWebSearch(p)) {
      webCheckbox.disabled = false;
      webText.textContent = `Allow the model to invoke web search (on ${p}, when chat alone can't answer).`;
    } else {
      webCheckbox.disabled = true;
      webText.textContent = `Web search isn't supported on ${p} yet (Anthropic + Google only). The Ask call will answer strictly from the chat.`;
    }
  };
  webRow.appendChild(webCheckbox);
  webRow.appendChild(webText);
  body.appendChild(webRow);

  // Live cost estimate
  const costBox = document.createElement("div");
  costBox.className = "tune-cost-box";
  body.appendChild(costBox);

  function getSelectedCap() {
    for (const r of capRadios) if (r.checked) return parseInt(r.value, 10);
    return DEFAULT_MAX_TOKENS;
  }
  function getSelectedAskCap() {
    for (const r of askCapRadios) if (r.checked) return parseInt(r.value, 10);
    return ASK_DEFAULT_CAP;
  }

  function paintReadouts() {
    const budget = parseInt(slider.value, 10);
    const inputTokens = Math.round(budget / TUNE_CHARS_PER_TOKEN);
    budgetReadout.textContent = `${budget.toLocaleString()} chars (~${inputTokens.toLocaleString()} tokens)`;
    const combo = combos[select.selectedIndex];
    const cap = getSelectedCap();
    const est = estimateCostUsd({ inputChars: budget, modelInfo: combo && combo.info, maxTokens: cap });
    if (!est) {
      costBox.innerHTML = "<em>No pricing data for this model.</em>";
      return;
    }
    costBox.innerHTML = `
      <div class="tune-cost-row"><span>Input</span>
        <span>${est.inputTokens.toLocaleString()} tokens · ${formatUsd(est.inputUsd)}</span></div>
      <div class="tune-cost-row"><span>Output (est. ~${est.outputTokens.toLocaleString()} of ${est.cap.toLocaleString()} cap)</span>
        <span>${formatUsd(est.outputUsd)}</span></div>
      <div class="tune-cost-row tune-cost-total"><span>Per ✨ click</span>
        <span>${formatUsd(est.totalUsd)}</span></div>
      <div class="tune-cost-note">Estimate uses the provider's public per-million-token input + output pricing. Raise the output cap if briefings keep truncating mid-sentence.</div>
    `;
  }
  paintReadouts();
  renderWebSupportNote();
  slider.addEventListener("input", paintReadouts);
  select.addEventListener("change", () => {
    paintReadouts();
    renderWebSupportNote();
  });
  for (const r of capRadios) r.addEventListener("change", paintReadouts);

  // Footer
  const footer = document.createElement("footer");
  footer.className = "ai-settings-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ai-settings-btn ai-settings-btn-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeTuneModelModal);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ai-settings-save";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    const combo = combos[select.selectedIndex];
    const budget = parseInt(slider.value, 10);
    const cap = getSelectedCap();
    const askCap = getSelectedAskCap();
    // Web search: persist the checkbox state. We keep the value even
    // when the checkbox is disabled (unsupported provider) so switching
    // back to a supported provider later restores the user's intent.
    const askWeb = !!webCheckbox.checked;
    if (!combo) return closeTuneModelModal();
    state.aiProvider = combo.providerName;
    state.aiModel = combo.modelId;
    state.aiBudgetChars = budget;
    state.aiMaxTokens = cap;
    state.aiAskMaxTokens = askCap;
    state.aiAskWebSearch = askWeb;
    try {
      chrome.storage &&
        chrome.storage.local &&
        chrome.storage.local.set({
          bssc_ai_provider: combo.providerName,
          bssc_ai_model: combo.modelId,
          bssc_ai_budget_chars: budget,
          bssc_ai_max_tokens: cap,
          bssc_ai_ask_max_tokens: askCap,
          bssc_ai_ask_web_search: askWeb,
        });
    } catch (_) {}
    closeTuneModelModal();
  });
  footer.appendChild(cancel);
  footer.appendChild(save);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeTuneModelModal();
  });
  document.body.appendChild(backdrop);
}

function closeTuneModelModal() {
  const el = document.getElementById("tuneModelBackdrop");
  if (el) el.remove();
}

// ----- Chat preferences modal -----
//
// One option for now (auto-load full chat history). Future general
// chat-side preferences slot in here. Keeps Tune AI model focused on
// AI knobs and stops the kebab from sprouting one-off items every
// time a small toggle ships.

function openChatPrefsModal() {
  const existing = document.getElementById("chatPrefsBackdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "chatPrefsBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Chat preferences");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal";

  const header = document.createElement("header");
  header.className = "ai-settings-header";
  const title = document.createElement("h2");
  title.className = "ai-settings-title";
  title.textContent = "Chat preferences";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeChatPrefsModal);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "ai-settings-body";

  const row = document.createElement("div");
  row.className = "tune-toggle-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = "chatPrefsAutoLoadAll";
  checkbox.checked = state.autoLoadAll !== false;
  const label = document.createElement("label");
  label.htmlFor = "chatPrefsAutoLoadAll";
  label.className = "tune-toggle-label";
  label.textContent =
    "Auto-load the full chat history in the background after initial load. Makes scrolling up with g instant. Sequential, rate-limit-aware. Off means BetterSSC loads one page at a time on demand (the old behavior).";
  row.appendChild(checkbox);
  row.appendChild(label);
  body.appendChild(row);

  const footer = document.createElement("footer");
  footer.className = "ai-settings-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ai-settings-btn ai-settings-btn-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeChatPrefsModal);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ai-settings-save";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    const next = !!checkbox.checked;
    const prev = state.autoLoadAll !== false;
    state.autoLoadAll = next;
    // If the user toggled OFF while bg prefetch is currently running,
    // flip the stop flag so the loop exits cleanly at the next slot.
    if (prev && !next && state.bgPrefetchActive) {
      state.bgPrefetchStop = true;
    }
    // If the user toggled ON within the SAME session and the prefetch
    // had been gated off at session start, kick it off now. The latch
    // (bgPrefetchDone) only flips on completion, so re-enabling a
    // session that finished prefetching is a no-op.
    if (!prev && next && !state.bgPrefetchDone && !state.bgPrefetchActive) {
      void runChatBgPrefetch();
    }
    try {
      chrome.storage &&
        chrome.storage.local &&
        chrome.storage.local.set({ bssc_auto_load_all: next });
    } catch (_) {}
    closeChatPrefsModal();
  });
  footer.appendChild(cancel);
  footer.appendChild(save);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeChatPrefsModal();
  });
  document.body.appendChild(backdrop);
}

function closeChatPrefsModal() {
  const el = document.getElementById("chatPrefsBackdrop");
  if (el) el.remove();
}

function openResetConfirmModal() {
  // Close any prior backdrop and build a fresh one.
  const existing = document.getElementById("resetConfirmBackdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "resetConfirmBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Reset all saved data");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal reset-confirm-modal";

  const header = document.createElement("header");
  header.className = "ai-settings-header";
  const title = document.createElement("h2");
  title.className = "ai-settings-title";
  title.textContent = "Reset all saved data?";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeResetConfirmModal);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "ai-settings-body";

  const note = document.createElement("p");
  note.className = "ai-settings-note";
  note.innerHTML =
    "This will permanently wipe BetterSSC's local storage on this device. " +
    "You'll be signed back to defaults the next time you reload.";
  body.appendChild(note);

  const list = document.createElement("ul");
  list.className = "reset-confirm-list";
  const things = [
    "📌 Pinned members and 🔔 watch / alert preferences",
    "✨ AI provider settings and API key (you'll re-paste it next time)",
    "Tuned AI model, context-budget slider, and custom prompt",
    "Theme (light / dark), member-rail sort, notify-all toggle",
    "WebSocket-enabled flag",
  ];
  for (const t of things) {
    const li = document.createElement("li");
    li.textContent = t;
    list.appendChild(li);
  }
  body.appendChild(list);

  const warn = document.createElement("p");
  warn.className = "reset-confirm-warn";
  warn.textContent =
    "Chat messages themselves stay on Substack — nothing on their side changes.";
  body.appendChild(warn);

  const footer = document.createElement("footer");
  footer.className = "ai-settings-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ai-settings-btn ai-settings-btn-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeResetConfirmModal);
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "ai-settings-btn ai-settings-btn-danger";
  confirm.textContent = "Reset everything";
  confirm.addEventListener("click", () => {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.clear(() => {
        closeResetConfirmModal();
        // Reload — easiest way to land cleanly with default state
        // (in-memory state.pinnedUsers / state.aiKeys / etc all live).
        window.location.reload();
      });
    } else {
      closeResetConfirmModal();
    }
  });
  footer.appendChild(cancel);
  footer.appendChild(confirm);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeResetConfirmModal();
  });
  document.body.appendChild(backdrop);
}

function closeResetConfirmModal() {
  const el = document.getElementById("resetConfirmBackdrop");
  if (el) el.remove();
}

// ============================================================
// TICKER MODAL (click $NASA / $DXYZ → TradingView chart)
// ============================================================
//
// Each $TICKER token in a message renders as a .msg-ticker anchor. A
// delegated listener on #messages handles clicks. The modal embeds
// TradingView's free advanced-chart widget via iframe — no script tag,
// no API key, no auth. Theme follows the current BetterSSC theme.

function openTickerModal(symbol) {
  if (!symbol) return;
  closeTickerModal(); // dismiss any existing modal first
  const theme =
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  // hide_side_toolbar:false brings in the drawing-tools rail on the left
  // (horizontal line, trend line, brush, fib, rectangle, etc.). The free
  // embed widget doesn't let us pick individual tools — toolbar is
  // all-or-nothing. Drawings are local to the iframe session and don't
  // persist across modal reopens (TradingView's free embed doesn't sync
  // them to your account).
  const config = {
    symbol,
    interval: "D",
    hide_side_toolbar: false,
    allow_symbol_change: true,
    theme,
    style: "1",
    locale: "en",
    autosize: true,
    save_image: false,
    withdateranges: true,
  };
  const url =
    "https://s.tradingview.com/embed-widget/advanced-chart/?locale=en#" +
    encodeURIComponent(JSON.stringify(config));

  const backdrop = document.createElement("div");
  backdrop.id = "tickerModalBackdrop";
  backdrop.className = "ticker-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "$" + symbol + " chart");

  const modal = document.createElement("div");
  modal.className = "ticker-modal";

  const header = document.createElement("div");
  header.className = "ticker-modal-header";
  const symEl = document.createElement("span");
  symEl.className = "ticker-modal-symbol";
  symEl.textContent = "$" + symbol;
  const openExternal = document.createElement("a");
  openExternal.className = "ticker-modal-external";
  openExternal.href = "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(symbol);
  openExternal.target = "_blank";
  openExternal.rel = "noopener noreferrer";
  openExternal.textContent = "open on TradingView ↗";
  openExternal.title = "Open full chart on TradingView";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ticker-modal-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close (Esc)";
  closeBtn.addEventListener("click", closeTickerModal);
  header.appendChild(symEl);
  header.appendChild(openExternal);
  header.appendChild(closeBtn);

  const iframe = document.createElement("iframe");
  iframe.className = "ticker-modal-iframe";
  iframe.src = url;
  iframe.setAttribute("frameborder", "0");
  iframe.setAttribute("scrolling", "no");
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  );

  modal.appendChild(header);
  modal.appendChild(iframe);
  backdrop.appendChild(modal);

  // Click outside the modal closes it.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeTickerModal();
  });

  document.body.appendChild(backdrop);
  closeBtn.focus();
}

function closeTickerModal() {
  const el = document.getElementById("tickerModalBackdrop");
  if (el) el.remove();
}

// Kept name for compatibility with the existing click handler; just
// opens the modal now.
function toggleChatHeaderPanel() {
  const backdrop = document.getElementById("postModalBackdrop");
  if (!backdrop) return;
  if (backdrop.classList.contains("hidden")) openPostModal();
  else closePostModal();
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

// "Go to latest" — single source of truth used by both the bottom-jump
// pill and the Shift+G keybind. With clearFilters:true (default for
// keyboard / Latest-mode pill click), drops any active search + thread
// filter so the user lands on the actual newest message rather than the
// filtered-bottom (which can be visually confusing — "feed ends here?").
// With clearFilters:false (pill click when pendingNewMessages > 0),
// keeps the filter intact because those new messages are the reason
// the pill is showing.
function goToLatest({ clearFilters = true } = {}) {
  if (clearFilters) {
    const input = document.getElementById("searchInput");
    if (input && input.value) {
      input.value = "";
      state.searchQuery = "";
    }
    if (state.threadFilter) {
      closeThreadFilter();
    } else if (state.searchQuery === "") {
      // closeThreadFilter already calls applySearch + scrollToBottom; if
      // only search was active, re-apply now to repaint the hidden rows.
      applySearch();
    }
  }
  scrollToBottom();
  // Move the j/k cursor anchor to the last visible group. Without this
  // Shift+G scrolls to bottom but the cursor stays wherever it was, so
  // the next j/k jumps from the middle of the feed instead of from the
  // bottom row the user just landed on.
  const groups = getVisibleGroups();
  if (groups.length) {
    setActiveGroup(groups[groups.length - 1], { skipScroll: true });
  }
}

// The bottom jump pill is the user's only "scroll back to current" cue.
// Show it WHENEVER they're not at bottom (replaces the old header "Latest"
// button), and let the label reflect whatever's most useful right now:
// "↓ N new messages" if polling added unread, otherwise plain "↓ Latest".
function showNewMessageJump() {
  const jump = document.getElementById("newMessageJump");
  if (!jump) return;
  jump.classList.remove("hidden");
  const main = jump.querySelector("#newMessageJumpMain");
  const aside = jump.querySelector("#newMessageJumpAside");
  const n = state.pendingNewMessages;
  const m = state.pendingNewMessagesOffFilter;
  const filtered =
    !!(state.searchQuery && state.searchQuery.trim()) ||
    !!state.threadFilter;
  // Main text is always plain "Latest" or "N new messages" — the filter
  // context is implicit (you can see your filter is on), and the aside
  // below carries the off-filter signal when it matters.
  if (main) {
    main.textContent = n > 0
      ? `↓ ${n} new message${n > 1 ? "s" : ""}`
      : "↓ Latest";
  }
  // Aside ("N in chat" suffix) only appears when a filter is active AND
  // off-filter activity exists. It's a separate click target that clears
  // the filter and jumps to the absolute bottom of the chat.
  if (aside) {
    if (filtered && m > 0) {
      aside.textContent = n > 0 ? `+${m} in chat` : `${m} in chat`;
      aside.classList.remove("hidden");
    } else {
      aside.classList.add("hidden");
    }
  }
}

function hideNewMessageJump() {
  state.pendingNewMessages = 0;
  state.pendingNewMessagesOffFilter = 0;
  document.getElementById("newMessageJump").classList.add("hidden");
}

// ============================================================
// SEARCH
// ============================================================

function applySearch() {
  // Filter change → the two pending counts are scoped to the OLD filter
  // and can't be meaningfully carried over (a count of 5 "in '@boz'" is
  // not 5 "in '@jordan'"). Reset both; the next poll cycle will populate
  // them correctly under the new filter. Hiding the pill avoids a
  // momentary stale-count flicker while waiting for that poll.
  if (state.pendingNewMessages || state.pendingNewMessagesOffFilter) {
    state.pendingNewMessages = 0;
    state.pendingNewMessagesOffFilter = 0;
    const jump = document.getElementById("newMessageJump");
    if (jump && !state.isAtBottom) {
      // Repaint the pill (shows "↓ Latest [in filter]" with no count).
      showNewMessageJump();
    } else if (jump) {
      jump.classList.add("hidden");
    }
  }
  const raw = (state.searchQuery || "").trim();
  const q = raw.toLowerCase();
  const hasThread = !!state.threadFilter;
  const hasFocus = !isFocusEmpty(state.focusFilter);

  // Drop the focus memo at the START of every pass. Its only job is to
  // avoid re-walking the same ancestor across the groups of THIS pass —
  // it must NOT survive across renders. History backfill (loadOlder /
  // bgPrefetch) inserts OLDER messages that can be ancestors of rows we
  // already evaluated; a memo that persisted would keep their stale
  // pre-backfill verdict (a "false" computed when the parent wasn't
  // loaded yet) and hide a message whose ancestor now matches.
  state._focusMemo = null;

  // Reset all groups to default state.
  document.querySelectorAll(".msg-group").forEach((node) => {
    node.classList.remove("search-hit", "search-active", "search-hidden");
  });

  // Parse the search query (if any). /help short-circuits to the overlay.
  // Slash command syntax: /from:<name>, /me, /has:link, /has:image,
  // /has:reaction, /since:<iso-or-relative>, /help. Otherwise `@<name>` is
  // the author-prefix filter, anything else is full-text on body+author.
  let matcher = null;
  if (q) {
    matcher = parseSearchQuery(raw);
    if (matcher.help) {
      showHelpOverlay();
      return;
    }
  }

  // Nothing narrowing the feed at all — every group visible, clear counts.
  if (!q && !hasThread && !hasFocus) {
    document.getElementById("searchCount").textContent = "";
    state.searchHits = [];
    hideSearchEmpty();
    return;
  }

  // Search hit set (all matches, pre-visibility). We narrow to VISIBLE
  // hits below so n/N never lands on a row hidden by thread/focus.
  const hitIds = new Set();
  if (matcher && matcher.test) {
    for (const id of state.order) {
      const c = state.comments.get(id);
      if (c && matcher.test(c)) hitIds.add(id);
    }
  }

  // Thread member set (parent + direct replies, one level — threaded OR
  // quoted).
  const threadParentId = hasThread ? state.threadFilter.parentId : null;
  const threadMemberIds = threadParentId
    ? new Set([
        threadParentId,
        ...((state.threadIndex && state.threadIndex.get(threadParentId)) || []),
      ])
    : null;

  // Unified pass: a group is VISIBLE iff it satisfies ALL active filters
  // (focus ∩ thread ∩ search). Focus and search are per-message-OR within
  // a group (any member matching shows the whole group); the three
  // dimensions intersect. AI Insights rows bypass every filter.
  const visibleHits = [];
  document.querySelectorAll(".msg-group").forEach((group) => {
    const ids = Array.from(group.querySelectorAll("[data-id]")).map(
      (n) => n.dataset.id
    );
    const containsAi = ids.some((id) => id && id.startsWith("ai_"));
    if (containsAi) {
      // Local-only, user-requested, synthesized FROM the current view —
      // hiding them after the fact would show nothing after a click.
      group.classList.add("search-hit");
      return;
    }
    const focusOk =
      !hasFocus ||
      ids.some((id) => {
        const c = state.comments.get(id);
        return c && commentInFocus(c);
      });
    const inThread = !threadMemberIds || ids.some((id) => threadMemberIds.has(id));
    const groupHasHit = ids.some((id) => hitIds.has(id));
    const searchOk = !q || groupHasHit;
    const visible = focusOk && inThread && searchOk;
    if (!visible) {
      group.classList.add("search-hidden");
      return;
    }
    if (q && groupHasHit) {
      group.classList.add("search-hit");
      // Collect surviving hits in chronological order for n/N cycling.
      for (const id of ids) if (hitIds.has(id)) visibleHits.push(id);
    } else if (hasThread && !q && inThread) {
      // Preserve the legacy thread-view tint: when a thread filter is
      // active with no text search, every in-thread group is highlighted
      // (this is what the old applyThreadFilter did). Focus-only mode does
      // NOT tint — it just hides non-matches — so the whole feed isn't lit.
      group.classList.add("search-hit");
    }
  });

  state.searchHits = visibleHits;

  // Count label + empty-state + initial landing apply only when a text
  // query is active. Focus/thread-only narrowing shows no search count.
  if (!q) {
    document.getElementById("searchCount").textContent = "";
    hideSearchEmpty();
    return;
  }
  const label = visibleHits.length
    ? `${visibleHits.length} ${matcher.kind} · Esc to clear`
    : `no ${matcher.kind} · Esc to clear`;
  document.getElementById("searchCount").textContent = label;
  if (visibleHits.length) {
    hideSearchEmpty();
    // Default-land on the NEWEST visible match. Chat usage almost always
    // wants "show me the latest thing matching this filter". n/N cycle
    // from here; wrap is fine.
    const lastIdx = visibleHits.length - 1;
    state.searchActiveIdx = lastIdx;
    focusSearchHit(lastIdx);
  } else {
    showSearchEmpty(raw);
  }
}

function showSearchEmpty(query) {
  const panel = document.getElementById("searchEmpty");
  if (!panel) return;
  const q = document.getElementById("searchEmptyQuery");
  if (q) q.textContent = query;
  panel.classList.remove("hidden");
}

function hideSearchEmpty() {
  const panel = document.getElementById("searchEmpty");
  if (panel) panel.classList.add("hidden");
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

  if (cmd === "has:link" || cmd === "has:links" || cmd === "has:url" || cmd === "has:urls") {
    return {
      kind: "with link",
      test: (c) => /https?:\/\//i.test(c.body || ""),
    };
  }
  if (
    cmd === "has:image" ||
    cmd === "has:images" ||
    cmd === "has:img" ||
    cmd === "has:imgs" ||
    cmd === "has:pic" ||
    cmd === "has:pics" ||
    cmd === "has:picture" ||
    cmd === "has:pictures"
  ) {
    return {
      kind: "with image",
      test: (c) =>
        hasAttachment(c.media_uploads) ||
        hasAttachment(c.threadMediaUploads) ||
        hasAttachment(c.mediaAttachments) ||
        hasAttachment(c.attachments),
    };
  }
  if (cmd === "has:reaction" || cmd === "has:reactions" || cmd === "has:emoji" || cmd === "has:emojis") {
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
      <dt>/has:link(s)</dt><dd>Messages containing a URL</dd>
      <dt>/has:image(s)</dt><dd>Messages with an image attachment (also /has:pic, /has:picture)</dd>
      <dt>/has:reaction(s)</dt><dd>Messages that have ≥1 reaction (also /has:emoji)</dd>
      <dt>/since:3</dt><dd>Messages from the last 3 days</dd>
      <dt>/since:2026-06-01</dt><dd>Messages on or after a date</dd>
      <dt>/help</dt><dd>This screen</dd>
    </dl>
    <h2 style="margin-top:18px">🎯 Focus mode</h2>
    <dl>
      <dt>🎯 Focus button</dt><dd>Just left of the search box — opens the Focus dialog (a separate function from search)</dd>
      <dt>Terms</dt><dd>Add words/tickers as chips (e.g. <code>$SPCX earnings</code>). Multiple terms are OR'd — a message shows if it matches any of them</dd>
      <dt>People</dt><dd>Tag people from the list; selected people pin to the top. Their messages — and every reply to them — come through</dd>
      <dt>Reply-tree aware</dt><dd>A reply to a matching message passes even if it doesn't contain the term itself (Focus walks up the reply/quote chain)</dd>
      <dt>Esc</dt><dd>Exit focus (banner also has <em>edit</em> / <em>× exit focus</em>)</dd>
    </dl>
    <h2 style="margin-top:18px">Stock & crypto tickers</h2>
    <dl>
      <dt>$NASA</dt><dd>Click any $TICKER symbol to open a free TradingView chart with drawing tools</dd>
      <dt>$BRK.B</dt><dd>Single-letter share classes supported. $5 / $100 dollar amounts are skipped</dd>
    </dl>
    <h2 style="margin-top:18px">Keyboard</h2>
    <dl>
      <dt>/</dt><dd>Focus search</dd>
      <dt>Esc</dt><dd>Close overlay → exit thread → exit 🎯 focus → clear search</dd>
      <dt>j / k or ↓ / ↑</dt><dd>Next / previous message</dd>
      <dt>PageDn / PageUp</dt><dd>Full page down / up</dd>
      <dt>⌘D / ⌘U</dt><dd>Half page down / up (vim style)</dd>
      <dt>g</dt><dd>Page up (loads older history at the top)</dd>
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

// (applyThreadFilter was folded into the unified applySearch intersection
// pass — thread membership is now one of the three filter dimensions.)

// Shows/hides the "can't reach Substack" banner. Mounted into #stream
// so it sits above the messages (and scrolls with them, intentionally —
// most users will be at bottom when this appears). Idempotent.
function renderProxyBanner() {
  const existing = document.getElementById("proxyBanner");
  if (!state.proxyDisconnected) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const banner = document.createElement("div");
  banner.id = "proxyBanner";
  banner.className = "proxy-banner";
  const icon = document.createElement("span");
  icon.className = "proxy-banner-icon";
  icon.textContent = "⚠";
  const text = document.createElement("span");
  text.className = "proxy-banner-text";
  text.textContent =
    "Can't reach Substack — open or refresh a substack.com tab to reconnect.";
  banner.appendChild(icon);
  banner.appendChild(text);
  const stream = document.getElementById("stream");
  if (stream) stream.prepend(banner);
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

// ============================================================
// FOCUS MODE (click the 🎯 button — filter feed to terms + people,
// ancestor-walk aware: replies to matching messages come through)
// ============================================================

// Single mutation point for the focus filter. Clears the memo (verdicts
// are filter-generation-scoped), repaints the banner + button state, and
// re-runs the unified filter pass.
function setFocusFilter(filter) {
  state.focusFilter = isFocusEmpty(filter) ? null : filter;
  state._focusMemo = null;
  const btn = document.getElementById("focusBtn");
  if (btn) btn.classList.toggle("is-active", !!state.focusFilter);
  renderFocusBanner();
  applySearch();
}

function clearFocus() {
  setFocusFilter(null);
  // Land at the latest message, mirroring closeThreadFilter's behavior.
  scrollToBottom();
}

// Resolve a focused userId to a display name (falls back to the id).
function focusUserName(userId) {
  const a = state.authors && state.authors.get(userId);
  if (a && a.profile && a.profile.name) return a.profile.name;
  // authors map may be keyed by number; try a loose scan.
  if (state.authors) {
    for (const v of state.authors.values()) {
      if (v.profile && String(v.profile.id) === String(userId))
        return v.profile.name;
    }
  }
  return String(userId);
}

function renderFocusBanner() {
  let banner = document.getElementById("focusBanner");
  if (!state.focusFilter) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "focusBanner";
    banner.className = "focus-banner";
    const stream = document.getElementById("stream");
    if (stream) stream.prepend(banner);
  }
  banner.innerHTML = "";
  const label = document.createElement("span");
  label.className = "focus-banner-label";
  label.textContent = "🎯 Focus:";
  banner.appendChild(label);

  const chips = document.createElement("span");
  chips.className = "focus-banner-chips";
  for (const term of state.focusFilter.terms || []) {
    const chip = document.createElement("span");
    chip.className = "focus-chip focus-chip-term";
    chip.textContent = term;
    chips.appendChild(chip);
  }
  for (const uid of state.focusFilter.userIds || []) {
    const chip = document.createElement("span");
    chip.className = "focus-chip focus-chip-person";
    chip.textContent = "@" + focusUserName(uid);
    chips.appendChild(chip);
  }
  banner.appendChild(chips);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "focus-banner-edit";
  edit.textContent = "edit";
  edit.title = "Edit focus";
  edit.addEventListener("click", openFocusDialog);
  banner.appendChild(edit);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "focus-banner-close";
  close.textContent = "× exit focus";
  close.title = "Exit focus (Esc)";
  close.addEventListener("click", clearFocus);
  banner.appendChild(close);
}

// The Focus dialog — term chips + a searchable people multiselect. Working
// state lives in `draftTerms` / `draftUserIds` and is committed on Apply.
function openFocusDialog() {
  // Idempotent — never stack two dialogs.
  const existing = document.getElementById("focusDialogBackdrop");
  if (existing) existing.remove();

  const draftTerms = [...((state.focusFilter && state.focusFilter.terms) || [])];
  const draftUserIds = new Set(
    ((state.focusFilter && state.focusFilter.userIds) || []).map(String)
  );

  const backdrop = document.createElement("div");
  backdrop.id = "focusDialogBackdrop";
  backdrop.className = "focus-dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "focus-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Focus mode");

  dialog.innerHTML = `
    <div class="focus-dialog-head">
      <h2>🎯 Focus mode</h2>
      <p class="focus-dialog-sub">Show only messages about these terms or people — and every reply to them. Everything else is hidden.</p>
    </div>
    <label class="focus-field-label">Terms</label>
    <div class="focus-terms-input" id="focusTermsInput">
      <span class="focus-terms-chips" id="focusTermsChips"></span>
      <input id="focusTermField" type="text" placeholder="$SPCX, earnings…  (Enter to add)" autocomplete="off" />
    </div>
    <label class="focus-field-label">People</label>
    <input id="focusPeopleSearch" type="text" class="focus-people-search" placeholder="Filter people…" autocomplete="off" />
    <div class="focus-people-list" id="focusPeopleList"></div>
    <div class="focus-dialog-actions">
      <button type="button" class="focus-dialog-clear" id="focusDialogClear">Clear focus</button>
      <div class="focus-dialog-actions-right">
        <button type="button" class="focus-dialog-cancel" id="focusDialogCancel">Cancel</button>
        <button type="button" class="focus-dialog-apply" id="focusDialogApply">Apply focus</button>
      </div>
    </div>
  `;
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const chipsEl = dialog.querySelector("#focusTermsChips");
  const termField = dialog.querySelector("#focusTermField");
  const peopleSearch = dialog.querySelector("#focusPeopleSearch");
  const peopleList = dialog.querySelector("#focusPeopleList");

  function renderTermChips() {
    chipsEl.innerHTML = "";
    draftTerms.forEach((term, idx) => {
      const chip = document.createElement("span");
      chip.className = "focus-chip focus-chip-term";
      chip.textContent = term;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "focus-chip-x";
      x.textContent = "×";
      x.setAttribute("aria-label", `Remove ${term}`);
      x.addEventListener("click", () => {
        draftTerms.splice(idx, 1);
        renderTermChips();
      });
      chip.appendChild(x);
      chipsEl.appendChild(chip);
    });
  }

  function addTerm(raw) {
    // Split on whitespace + commas so each word becomes its own OR'd chip.
    // Typing "$SPCX earnings TSLA" + Enter yields three independent terms,
    // not one phrase that would only match messages containing all three
    // words in sequence. Each chip is matched as a substring; the feed
    // shows a message if it (or an ancestor) matches ANY chip.
    const parts = splitTerms(raw);
    for (const t of parts) {
      if (!draftTerms.some((x) => x.toLowerCase() === t.toLowerCase()))
        draftTerms.push(t);
    }
    renderTermChips();
  }

  termField.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTerm(termField.value);
      termField.value = "";
    } else if (e.key === "Backspace" && !termField.value && draftTerms.length) {
      draftTerms.pop();
      renderTermChips();
    }
  });

  function renderPeople() {
    const q = (peopleSearch.value || "").trim().toLowerCase();
    const authors = state.authors
      ? Array.from(state.authors.values()).filter((a) => a && a.profile)
      : [];
    // Selected (focused) people float to the TOP so you can see who's in
    // the filter at a glance; alphabetical within each group. Re-sorts on
    // every toggle, so clicking a person lifts them to the top immediately.
    authors.sort((a, b) => {
      const aSel = draftUserIds.has(String(a.profile.id)) ? 0 : 1;
      const bSel = draftUserIds.has(String(b.profile.id)) ? 0 : 1;
      if (aSel !== bSel) return aSel - bSel;
      return (a.profile.name || "").localeCompare(b.profile.name || "");
    });
    peopleList.innerHTML = "";
    let shown = 0;
    for (const a of authors) {
      const name = a.profile.name || "Unknown";
      const id = String(a.profile.id);
      const isSel = draftUserIds.has(id);
      // Selected people ALWAYS stay visible (at the top) even while a search
      // query is active — so you never lose sight of who's in the filter
      // while hunting for the next person to add.
      if (q && !isSel && !name.toLowerCase().includes(q)) continue;
      shown++;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "focus-person-row";
      if (isSel) row.classList.add("is-selected");
      const av = document.createElement("span");
      av.className = "focus-person-avatar";
      if (a.profile.photo_url) {
        const img = document.createElement("img");
        img.src = a.profile.photo_url;
        img.alt = "";
        av.appendChild(img);
      } else {
        av.textContent = (name[0] || "?").toUpperCase();
      }
      const nm = document.createElement("span");
      nm.className = "focus-person-name";
      nm.textContent = name;
      const check = document.createElement("span");
      check.className = "focus-person-check";
      check.textContent = isSel ? "✓" : "";
      row.appendChild(av);
      row.appendChild(nm);
      row.appendChild(check);
      row.addEventListener("click", () => {
        if (draftUserIds.has(id)) draftUserIds.delete(id);
        else draftUserIds.add(id);
        renderPeople();
      });
      peopleList.appendChild(row);
    }
    if (shown === 0) {
      const empty = document.createElement("div");
      empty.className = "focus-people-empty";
      empty.textContent = authors.length
        ? "No people match."
        : "No people loaded yet — scroll the chat to load members.";
      peopleList.appendChild(empty);
    }
  }
  peopleSearch.addEventListener("input", renderPeople);

  function close() {
    backdrop.remove();
  }

  dialog
    .querySelector("#focusDialogCancel")
    .addEventListener("click", close);
  dialog.querySelector("#focusDialogClear").addEventListener("click", () => {
    setFocusFilter(null);
    close();
    scrollToBottom();
  });
  dialog.querySelector("#focusDialogApply").addEventListener("click", () => {
    // Fold any half-typed term in the field into the filter on Apply.
    if (termField.value.trim()) addTerm(termField.value);
    const filter = buildFocusFilter(draftTerms, Array.from(draftUserIds));
    setFocusFilter(filter);
    close();
    if (filter) scrollToBottom();
  });
  // NOTE: intentionally NO backdrop-click-to-close. Building a focus filter
  // is deliberate, multi-step work (typing terms, hunting people in the
  // list) — an accidental outside click shouldn't wipe it. The dialog only
  // closes via Cancel, Clear focus, Apply focus, or the Esc key.

  renderTermChips();
  renderPeople();
  requestAnimationFrame(() => termField.focus());
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
  if (!isUserAway()) return;
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
  let currentIdx = groups.findIndex((g) => g.classList.contains("vi-active"));

  // Lazy re-anchor: if the user scrolled the active row off-screen
  // with the mousewheel / scrollbar since the last j/k, snap the
  // cursor to the topmost fully-visible group BEFORE moving. Without
  // this, j after a manual scroll-up would move from the offscreen
  // anchor (probably below the viewport) and instantly yank the user
  // back to where they came from. Costs one bounding-rect check per
  // keystroke — only fires on j/k, not on every scroll event.
  const stream = document.getElementById("stream");
  if (currentIdx !== -1 && stream) {
    const streamRect = stream.getBoundingClientRect();
    const activeRect = groups[currentIdx].getBoundingClientRect();
    const stillVisible =
      activeRect.bottom > streamRect.top + 8 &&
      activeRect.top < streamRect.bottom - 8;
    if (!stillVisible) {
      for (let i = 0; i < groups.length; i++) {
        const rect = groups[i].getBoundingClientRect();
        if (rect.top >= streamRect.top - 4) {
          currentIdx = i;
          setActiveGroup(groups[i], { skipScroll: true });
          break;
        }
      }
    }
  }

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

// `g` — two-tier state machine. Each press does at most ONE thing:
//
//   State A: not at top of currently-loaded feed (scrollTop > 20)
//     → smooth-scroll to scrollTop=0. Focus first group on settle.
//
//   State B: at top of loaded + more history available
//     → loadOlder (await), then smooth-scroll back to scrollTop=0.
//       loadOlder preserves visual position by setting scrollTop to
//       the new batch's height, so the scroll covers that distance.
//
//   State C: at top of loaded + no more history (state.moreBefore===false)
//     → no-op. Absolute top of the chat, nothing left to do.
//
// The split avoids the bug that plagued every prior version: when
// loadOlder fired DURING a smooth scroll, its tail line
// `stream.scrollTop = ...` (app.js:518) cancelled the animation and
// the user only saw a few messages of progress. Here loadOlder is
// always sequenced BEFORE the smooth scroll (via await), and the
// scroll handler's loadOlder trigger is suppressed across the
// animation window via state.suppressScrollLoadOlder.
const AT_TOP_THRESHOLD = 20;

function onScrollSettled(stream, cb) {
  if ("onscrollend" in stream) {
    const handler = () => {
      stream.removeEventListener("scrollend", handler);
      cb();
    };
    stream.addEventListener("scrollend", handler);
  } else {
    setTimeout(cb, 350);
  }
}

function focusFirstGroup() {
  const groups = getVisibleGroups();
  if (groups.length) {
    setActiveGroup(groups[0], { skipScroll: true });
  }
}

async function pageUpWithFocus() {
  const stream = document.getElementById("stream");
  if (!stream) return;
  const atTop = stream.scrollTop <= AT_TOP_THRESHOLD;

  if (!atTop) {
    // State A — smooth-scroll to top of currently loaded.
    state.suppressScrollLoadOlder = true;
    stream.scrollTo({ top: 0, behavior: "smooth" });
    onScrollSettled(stream, () => {
      state.suppressScrollLoadOlder = false;
      focusFirstGroup();
    });
    return;
  }

  // At top of loaded — state B or C.
  if (!state.moreBefore) return; // State C: no-op, already at oldest.

  // State B — fetch one older batch, then smooth-scroll back to top.
  state.suppressScrollLoadOlder = true;
  await loadOlder();
  stream.scrollTo({ top: 0, behavior: "smooth" });
  onScrollSettled(stream, () => {
    state.suppressScrollLoadOlder = false;
    focusFirstGroup();
  });
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
  bindTickerBar();
  const stream = document.getElementById("stream");
  stream.addEventListener(
    "scroll",
    throttle(() => {
      const nearBottom =
        stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
      state.isAtBottom = nearBottom;
      if (nearBottom) {
        hideNewMessageJump();
      } else {
        showNewMessageJump();
      }
      if (stream.scrollTop < 200 && !state.suppressScrollLoadOlder) {
        loadOlder();
      }
    }, 100)
  );

  // Split pill: main button preserves the active filter (Latest in
  // filter); aside button clears the filter and goes to absolute bottom
  // (the off-filter "+M elsewhere" shortcut). The asymmetric click
  // semantics now live in the HTML, not in a condition over
  // pendingNewMessages — much cleaner.
  document
    .getElementById("newMessageJumpMain")
    .addEventListener("click", () => {
      goToLatest({ clearFilters: false });
    });
  document
    .getElementById("newMessageJumpAside")
    .addEventListener("click", () => {
      goToLatest({ clearFilters: true });
    });

  wireAiMenu();

  const kebabBtn = document.getElementById("kebabMenuBtn");
  if (kebabBtn) {
    kebabBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleKebabMenu();
    });
  }

  // Delegated click handler for $TICKER links in messages — opens the
  // TradingView modal. Delegation means we don't have to re-bind on
  // every render.
  const messagesEl = document.getElementById("messages");
  if (messagesEl) {
    messagesEl.addEventListener("click", (e) => {
      // Move the j/k cursor anchor to whatever group the user clicked
      // on. Skip scroll — the click itself already put the row where
      // the user wants it; we just need to update _viActiveId so the
      // next j/k starts from here. Defensive class check in case a
      // future filter hides clickable groups in some edge state.
      const clickedGroup = e.target.closest && e.target.closest(".msg-group");
      if (clickedGroup && !clickedGroup.classList.contains("search-hidden")) {
        setActiveGroup(clickedGroup, { skipScroll: true });
      }
      // TradingView modal trigger (separate concern — keeps the focus
      // shift above even when the click is on a ticker).
      const ticker = e.target.closest && e.target.closest(".msg-ticker");
      if (!ticker) return;
      e.preventDefault();
      const symbol = ticker.dataset.symbol;
      if (symbol) openTickerModal(symbol);
    });

    // Mouse hover sets focus on the hovered group, same state j/k uses.
    // We use mousemove rather than mouseover because mouseover ALSO fires
    // when the page scrolls under a stationary cursor (the element below
    // the cursor changes even though the user hasn't moved). That made
    // j/k unusable: every keyboard move scrolled the target into view,
    // which slid a different group under the cursor, which fired
    // mouseover, which overrode the active group set by moveActive.
    // mousemove only fires on real cursor motion in viewport coords —
    // no scroll-induced re-entry — so keyboard nav and hover nav stay
    // independent. The _viActiveId equality check makes per-pixel
    // mousemove events cheap by short-circuiting when the cursor is
    // still inside the same group. AI insights are .ai-msg with no
    // .msg-group wrapper, so closest() returns null and we bail.
    messagesEl.addEventListener("mousemove", (e) => {
      const group = e.target.closest && e.target.closest(".msg-group");
      if (!group || group.classList.contains("search-hidden")) return;
      if (group.dataset.firstId === _viActiveId) return;
      setActiveGroup(group, { skipScroll: true });
    });
  }

  const searchInput = document.getElementById("searchInput");
  searchInput.addEventListener(
    "input",
    debounce((e) => {
      state.searchQuery = e.target.value || "";
      applySearch();
    }, 120)
  );
  // Enter while focused in the search box commits the filter and drops
  // focus back to the feed so j/k vi nav works without the user having
  // to click out. preventDefault stops any default form-submit / newline.
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      state.searchQuery = searchInput.value || "";
      applySearch();
      searchInput.blur();
    }
  });

  document.addEventListener("keydown", (e) => {
    // Suppress vi shortcuts whenever focus is inside ANY editable
    // surface — not just the search box + TEXTAREAs. Previously this
    // missed `<input type="text">` fields like the GIPHY API key
    // input and the AI Insights settings inputs, so typing letters
    // like `r` (refresh) into those fields fired the shortcut instead
    // of inserting the character. Also catches `isContentEditable`
    // for any future rich-text input.
    const active = document.activeElement;
    const tag = active && active.tagName;
    const inInput =
      active === searchInput ||
      tag === "TEXTAREA" ||
      tag === "INPUT" ||
      (active && active.isContentEditable);

    // Escape — clear active overlays, then thread filter, then search.
    // v0.1.27: works from anywhere, not just when focused in the search box.
    if (e.key === "Escape") {
      const aiSettings = document.getElementById("aiSettingsBackdrop");
      if (aiSettings) {
        closeAiSettingsModal();
        return;
      }
      const tickerModal = document.getElementById("tickerModalBackdrop");
      if (tickerModal) {
        closeTickerModal();
        return;
      }
      const focusDialog = document.getElementById("focusDialogBackdrop");
      if (focusDialog) {
        focusDialog.remove();
        return;
      }
      const overlay = document.querySelector(".help-overlay, .lightbox");
      if (overlay) {
        overlay.remove();
        return;
      }
      if (state.threadFilter) {
        closeThreadFilter();
        return;
      }
      if (!isFocusEmpty(state.focusFilter)) {
        clearFocus();
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

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "g") {
      e.preventDefault();
      pageUpWithFocus();
    } else if (e.key === "G") {
      e.preventDefault();
      goToLatest({ clearFilters: true });
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

  // Manual refresh button — triggers an immediate poll. Spins briefly.
  const refreshBtn = document.getElementById("refreshNow");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      manualRefresh(refreshBtn);
    });
  }

  // "Notify on every new message" header toggle.
  const notifyAllBtn = document.getElementById("notifyAllBtn");
  if (notifyAllBtn) {
    notifyAllBtn.addEventListener("click", toggleNotifyAllMessages);
    renderNotifyAllButton();
  }

  // 🎯 Focus mode button — opens the term/people focus dialog.
  const focusBtn = document.getElementById("focusBtn");
  if (focusBtn) {
    focusBtn.addEventListener("click", openFocusDialog);
  }

  // Click anywhere on the header-left (pub avatar + name) expands the
  // full post body in a collapsible panel below the header.
  const headerLeft = document.getElementById("headerLeft");
  if (headerLeft) {
    headerLeft.addEventListener("click", toggleChatHeaderPanel);
  }
  // Post modal: close on ✕, backdrop click, or Esc.
  const postModalClose = document.getElementById("postModalClose");
  if (postModalClose) {
    postModalClose.addEventListener("click", closePostModal);
  }
  const postModalBackdrop = document.getElementById("postModalBackdrop");
  if (postModalBackdrop) {
    postModalBackdrop.addEventListener("click", (e) => {
      if (e.target === postModalBackdrop) closePostModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const bd = document.getElementById("postModalBackdrop");
    if (bd && !bd.classList.contains("hidden")) {
      closePostModal();
      e.stopPropagation();
    }
  });

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
      if (state.postUuid) markViewed();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (state.ws) state.ws.close();
    if (_pollTimer) clearInterval(_pollTimer);
    if (_markViewedTimer) clearInterval(_markViewedTimer);
    stopTickerRefreshTimer();
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
  updateReactionCount,
  topReactionsInChat,
  setReplyTarget,
  clearReplyTarget,
  buildReplyFields,
} from "./lib/compose.js";
import {
  postComment as apiPostComment,
  fetchMentionSuggestions as apiFetchMentions,
  postReaction as apiPostReaction,
  registerChatMediaUpload as apiRegisterMedia,
  putChatMediaBinary as apiPutMediaBinary,
} from "./lib/api.js";
import {
  fetchGiphyTrending,
  fetchGiphySearch,
  pickGifsFromResponse,
  testGiphyKey,
} from "./lib/giphy.js";
import { uuid as composerUuid, debounce as composerDebounce } from "./lib/util.js";
import {
  reactionEmojiFor as composerReactionEmojiFor,
  groupedReactions,
  filterReactionsByQuery,
} from "./lib/emojis.js";

// Composer-scoped state. Kept namespaced so it doesn't collide with any v0.1
// state path. Initialized lazily on first mount so a missing #composer (e.g.
// the landing screen) is a no-op.
state.composer = state.composer || {
  pending: null,         // outgoing send in flight (commit 2)
  mentions: {},          // @name → { user_id, text } map for the buffer
  replyingTo: null,      // {id, authorName, body} when replying (commit 6)
  // Giphy BYOK API key for the GIF picker. Persisted as
  // bssc_giphy_api_key. The picker hides itself behind the onboarding
  // modal until the user has configured a key.
  giphyApiKey: null,
  // Single staged attachment for v1 — paperclip / paste / drag-drop all
  // funnel into this slot. Shape: {file: File, blob: Blob, previewUrl:
  // string-or-null}. Cleared on send-success, on user dismiss, or on
  // send-failure of the upload step (we don't strand the staged blob
  // when the upload itself fails — we keep the text in the composer
  // and surface a retry-friendly error toast).
  attachment: null,
};

// MIME allow-list + size cap for staged attachments. HAR captures
// confirmed image/png + image/jpeg + image/gif work end-to-end; webp
// is added as the only other browser-native still+animated format
// likely to round-trip through Substack's image rendering path. Non-
// image MIMEs aren't yet verified — gated behind the picker accept
// attribute AND a runtime check.
const COMPOSER_ATTACH_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
// Conservative client-side cap. HAR captures confirmed end-to-end at
// 1.8 MB (JPEG); Substack's actual server-side limit is unverified.
// 10 MB is a typical chat-attachment ceiling on similar platforms and
// keeps us well clear of any plausible server cap. Worth raising if
// users report rejected uploads under 10 MB.
const COMPOSER_ATTACH_MAX_BYTES = 10 * 1024 * 1024;

function mountComposer() {
  const composer = document.getElementById("composer");
  if (!composer) return;
  const input = document.getElementById("composerInput");
  const sendBtn = document.getElementById("composerSend");
  if (!input || !sendBtn) return;

  // Enable / disable the Send button based on input contents + in-flight.
  // A staged attachment is enough to enable Send on its own — Substack
  // accepts an empty-body comment when an attachment is present.
  const refreshSendBtn = () => {
    const txt = input.value || "";
    const empty = txt.trim().length === 0;
    const hasAttachment = !!state.composer.attachment;
    sendBtn.disabled = (empty && !hasAttachment) || !!state.composer.pending;
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

  // Commit 6: reply bar × button.
  const replyClose = document.getElementById("composerReplyClose");
  if (replyClose) {
    replyClose.addEventListener("click", (e) => {
      e.preventDefault();
      clearReplyTarget(state.composer);
      renderComposerReplyBar();
    });
  }

  // Make sure the reply bar starts hidden (state may carry over on hot reload).
  renderComposerReplyBar();

  // Commit (this branch): attachment wiring — paperclip, drag-drop, paste.
  wireComposerAttachments(composer, input);
}

// ============================================================
// COMPOSER ATTACHMENTS — paperclip + paste + drag-drop
// ============================================================
//
// Single staged-attachment state lives on state.composer.attachment.
// Three intake paths funnel into stageAttachment(file):
//
//   1. Paperclip button → hidden <input type="file"> picker
//   2. Paste into the textarea — clipboard `Files`
//   3. Drag-drop onto the composer area — DataTransfer `files`
//
// stageAttachment validates MIME + size, builds a preview Object URL,
// stashes the File on state, and re-renders the preview chip.
//
// The chip lives directly above the textarea row (#composerAttachment)
// — thumbnail + filename + size + ✕ to discard. Object URL revoked on
// dismiss + on successful send to avoid leaks.

function wireComposerAttachments(composer, input) {
  const attachBtn = document.getElementById("composerAttachBtn");
  const fileInput = document.getElementById("composerFileInput");
  // Wire the NEW Discord-style icon buttons (GIF + emoji). Paperclip
  // stays under wireComposerAttachments because its drag-drop / paste
  // path is the same code.
  wireComposerGifAndEmoji(input);
  if (!attachBtn || !fileInput) return;

  attachBtn.addEventListener("click", (e) => {
    e.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) tryStageAttachment(file);
    // Reset so picking the SAME file twice still fires `change`.
    fileInput.value = "";
  });

  // Clipboard paste — Files[] is non-empty when the user pasted an image.
  // We process the FIRST file we find; pasted text in the same paste
  // event still lands in the textarea naturally (we don't preventDefault
  // unless we actually stage something).
  input.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.files;
    if (!items || !items.length) return;
    const file = items[0];
    if (!file) return;
    if (tryStageAttachment(file)) {
      // Suppress the textarea also receiving the file as a fake-text
      // paste in some browsers.
      e.preventDefault();
    }
  });

  // Drag-drop. We listen on the whole composer so users can drop anywhere
  // in the bottom bar — not just on the textarea. dragover MUST
  // preventDefault for drop to fire on the target.
  const dropHint = document.getElementById("composerDropHint");
  let dragDepth = 0; // dragenter/leave fire on children; count them
  const showHint = () => {
    composer.classList.add("is-dragover");
    if (dropHint) dropHint.classList.remove("hidden");
  };
  const hideHint = () => {
    composer.classList.remove("is-dragover");
    if (dropHint) dropHint.classList.add("hidden");
  };
  composer.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    showHint();
  });
  composer.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  composer.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideHint();
  });
  composer.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    hideHint();
    tryStageAttachment(e.dataTransfer.files[0]);
  });
}

// Validate + stage. Returns true on success, false if rejected. The
// rejection toast tells the user WHY without needing to inspect logs.
function tryStageAttachment(file) {
  if (!file || !file.type) {
    showComposerError("That doesn't look like a file we can attach.");
    return false;
  }
  if (!COMPOSER_ATTACH_MIMES.has(file.type)) {
    showComposerError(
      `Attachments are PNG / JPEG / GIF / WebP only — got ${file.type || "(unknown)"}.`
    );
    return false;
  }
  if (file.size > COMPOSER_ATTACH_MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    showComposerError(
      `That image is ${mb} MB — Substack caps chat attachments around 10 MB.`
    );
    return false;
  }
  // Discard any prior staged attachment first (revokes its preview URL
  // so we don't leak Blob URLs across re-stages).
  clearStagedAttachment();
  const previewUrl = URL.createObjectURL(file);
  state.composer.attachment = {
    file,
    blob: file, // File extends Blob — same instance for the PUT
    previewUrl,
  };
  renderComposerAttachment();
  if (state.composer._refreshSendBtn) state.composer._refreshSendBtn();
  return true;
}

function clearStagedAttachment() {
  const a = state.composer.attachment;
  if (!a) return;
  if (a.previewUrl) {
    try {
      URL.revokeObjectURL(a.previewUrl);
    } catch (_) {}
  }
  state.composer.attachment = null;
  renderComposerAttachment();
  if (state.composer._refreshSendBtn) state.composer._refreshSendBtn();
}

function renderComposerAttachment() {
  const wrap = document.getElementById("composerAttachment");
  if (!wrap) return;
  const a = state.composer.attachment;
  if (!a) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML = "";

  const thumb = document.createElement("div");
  thumb.className = "composer-attachment-thumb";
  if (a.previewUrl) {
    const img = document.createElement("img");
    img.src = a.previewUrl;
    img.alt = "";
    img.className = "composer-attachment-img";
    thumb.appendChild(img);
  } else {
    thumb.textContent = "📎";
  }
  wrap.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "composer-attachment-meta";
  const name = document.createElement("div");
  name.className = "composer-attachment-name";
  name.textContent = a.file.name || "(pasted image)";
  name.title = name.textContent;
  const size = document.createElement("div");
  size.className = "composer-attachment-size";
  size.textContent = formatBytes(a.file.size);
  meta.appendChild(name);
  meta.appendChild(size);
  wrap.appendChild(meta);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "composer-attachment-remove";
  remove.title = "Remove attachment";
  remove.setAttribute("aria-label", "Remove attachment");
  remove.textContent = "✕";
  remove.addEventListener("click", (e) => {
    e.preventDefault();
    clearStagedAttachment();
  });
  wrap.appendChild(remove);
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================
// GIF PICKER (Giphy) + COMPOSER EMOJI BUTTON
// ============================================================

function wireComposerGifAndEmoji(input) {
  const gifBtn = document.getElementById("composerGifBtn");
  if (gifBtn) {
    gifBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!state.giphyApiKey) {
        openGiphyOnboardingModal();
      } else {
        openGiphyPickerModal();
      }
    });
  }
  const emojiBtn = document.getElementById("composerEmojiBtn");
  if (emojiBtn && input) {
    emojiBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openComposerEmojiPopover(input, emojiBtn);
    });
  }
}

// ----- Giphy onboarding (first-time key setup) -----

function openGiphyOnboardingModal() {
  closeGiphyOnboardingModal();
  const backdrop = document.createElement("div");
  backdrop.id = "giphyOnboardingBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Set up GIPHY");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal giphy-onboarding-modal";

  const header = document.createElement("header");
  header.className = "ai-settings-header";
  const title = document.createElement("h2");
  title.className = "ai-settings-title";
  title.textContent = "Set up the GIF picker";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeGiphyOnboardingModal);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "ai-settings-body";

  const intro = document.createElement("p");
  intro.className = "ai-settings-note";
  intro.innerHTML =
    "GIFs run on <strong>GIPHY</strong>. Free for personal use — get a key in about 30 seconds. " +
    "Your key stays in <code>chrome.storage.local</code> on this device. BetterSSC never sees it.";
  body.appendChild(intro);

  // Three numbered steps with clickable link to GIPHY dashboard.
  const steps = document.createElement("ol");
  steps.className = "giphy-onboarding-steps";
  const stepTexts = [
    'Open <a href="https://developers.giphy.com/dashboard/" target="_blank" rel="noopener noreferrer">developers.giphy.com/dashboard</a> and sign in (free).',
    'Click <strong>Create an App</strong> → choose <strong>API</strong> (not SDK) → fill in any name + description → submit.',
    'Copy the generated <strong>API Key</strong>, paste it below, and click <strong>Test &amp; Save</strong>.',
  ];
  for (const t of stepTexts) {
    const li = document.createElement("li");
    li.innerHTML = t;
    steps.appendChild(li);
  }
  body.appendChild(steps);

  const inputRow = document.createElement("div");
  inputRow.className = "giphy-onboarding-input-row";
  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.className = "giphy-onboarding-key";
  keyInput.placeholder = "Paste your GIPHY API key here";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  if (state.giphyApiKey) keyInput.value = state.giphyApiKey;
  inputRow.appendChild(keyInput);
  body.appendChild(inputRow);

  const status = document.createElement("div");
  status.className = "giphy-onboarding-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  body.appendChild(status);

  const footer = document.createElement("footer");
  footer.className = "ai-settings-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ai-settings-btn ai-settings-btn-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeGiphyOnboardingModal);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ai-settings-save";
  save.textContent = "Test & Save";
  save.addEventListener("click", async () => {
    const key = (keyInput.value || "").trim();
    if (!key) {
      status.textContent = "Paste a key first.";
      status.className = "giphy-onboarding-status is-error";
      keyInput.focus();
      return;
    }
    save.disabled = true;
    save.textContent = "Testing…";
    status.textContent = "Asking GIPHY if this key is valid…";
    status.className = "giphy-onboarding-status";
    const result = await testGiphyKey(key);
    save.disabled = false;
    save.textContent = "Test & Save";
    if (!result.ok) {
      status.textContent = "✗ " + (result.error || "Test failed");
      status.className = "giphy-onboarding-status is-error";
      return;
    }
    state.giphyApiKey = key;
    try {
      chrome.storage &&
        chrome.storage.local &&
        chrome.storage.local.set({ bssc_giphy_api_key: key });
    } catch (_) {}
    status.textContent = "✓ Saved. Opening the GIF picker…";
    status.className = "giphy-onboarding-status is-ok";
    setTimeout(() => {
      closeGiphyOnboardingModal();
      openGiphyPickerModal();
    }, 400);
  });
  footer.appendChild(cancel);
  footer.appendChild(save);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeGiphyOnboardingModal();
  });
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => keyInput.focus());
}

function closeGiphyOnboardingModal() {
  const el = document.getElementById("giphyOnboardingBackdrop");
  if (el) el.remove();
}

// ----- Giphy picker modal -----

async function openGiphyPickerModal() {
  // Revalidate the stored key BEFORE building the picker UI. If the key
  // was revoked / expired since last session, the user would otherwise
  // see a 401 error string buried inside the picker's status bar — and
  // would have to find the small "Change key" link to recover. A 1-call
  // /trending ping (~100ms) bounces them to onboarding cleanly instead.
  if (state.giphyApiKey) {
    const check = await testGiphyKey(state.giphyApiKey);
    if (!check.ok) {
      openGiphyOnboardingModal();
      return;
    }
  } else {
    openGiphyOnboardingModal();
    return;
  }
  closeGiphyPickerModal();
  const backdrop = document.createElement("div");
  backdrop.id = "giphyPickerBackdrop";
  backdrop.className = "ai-settings-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Pick a GIF");

  const modal = document.createElement("div");
  modal.className = "ai-settings-modal giphy-picker-modal";

  const header = document.createElement("header");
  header.className = "giphy-picker-header";
  const search = document.createElement("input");
  search.type = "text";
  search.id = "giphyPickerSearch";
  search.className = "giphy-picker-search";
  search.placeholder = "Search GIPHY…";
  search.autocomplete = "off";
  header.appendChild(search);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ai-settings-close";
  closeBtn.setAttribute("aria-label", "Close picker");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeGiphyPickerModal);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const grid = document.createElement("div");
  grid.id = "giphyPickerGrid";
  grid.className = "giphy-picker-grid";
  modal.appendChild(grid);

  const status = document.createElement("div");
  status.id = "giphyPickerStatus";
  status.className = "giphy-picker-status";
  modal.appendChild(status);

  const footer = document.createElement("footer");
  footer.className = "giphy-picker-footer";
  // TODO: verify GIPHY attribution policy for public distribution —
  // their dev guidelines may require the GIPHY logo image asset (not
  // just text). Drop in https://developers.giphy.com/branch/master/docs/sdk/branding-guidelines/
  // before Chrome Web Store submission and swap to <img> if required.
  const attribution = document.createElement("span");
  attribution.className = "giphy-attribution";
  attribution.textContent = "Powered by GIPHY";
  footer.appendChild(attribution);
  const changeKey = document.createElement("button");
  changeKey.type = "button";
  changeKey.className = "giphy-picker-changekey";
  changeKey.textContent = "Change key";
  changeKey.addEventListener("click", () => {
    closeGiphyPickerModal();
    openGiphyOnboardingModal();
  });
  footer.appendChild(changeKey);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeGiphyPickerModal();
  });
  document.body.appendChild(backdrop);

  // Esc closes the picker
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeGiphyPickerModal();
    }
  };
  document.addEventListener("keydown", onKey);
  modal._onKey = onKey;
  // Picker-lifecycle AbortController. Both the search fetches AND any
  // in-flight stageGiphyPick binary download check this signal — if the
  // user closes the picker mid-download we cancel rather than letting
  // the file silently stage in the composer after the modal is gone.
  modal._pickerAbort = new AbortController();

  // Debounce search input — 300ms balances responsiveness vs API cost.
  let searchTimer = null;
  let activeFetchAbort = null;
  const doFetch = async (query) => {
    if (activeFetchAbort) activeFetchAbort.abort();
    activeFetchAbort = new AbortController();
    status.textContent = "Loading…";
    grid.innerHTML = "";
    try {
      const fn = query
        ? () => fetchGiphySearch(state.giphyApiKey, query, { signal: activeFetchAbort.signal })
        : () => fetchGiphyTrending(state.giphyApiKey, { signal: activeFetchAbort.signal });
      const json = await fn();
      const picks = pickGifsFromResponse(json);
      renderGiphyGrid(grid, picks);
      if (picks.length === 0) {
        status.textContent = query ? `No GIFs for "${query}"` : "No GIFs found";
      } else {
        status.textContent = "";
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
      grid.innerHTML = "";
      status.textContent = "✗ " + ((e && e.message) || "Failed to load GIFs");
    }
  };

  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    const q = search.value.trim();
    searchTimer = setTimeout(() => doFetch(q), 300);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (searchTimer) clearTimeout(searchTimer);
      doFetch(search.value.trim());
    }
  });

  requestAnimationFrame(() => search.focus());
  doFetch("");
}

function closeGiphyPickerModal() {
  const el = document.getElementById("giphyPickerBackdrop");
  if (el) {
    const modal = el.querySelector(".giphy-picker-modal");
    if (modal && modal._onKey) document.removeEventListener("keydown", modal._onKey);
    if (modal && modal._pickerAbort) {
      try { modal._pickerAbort.abort(); } catch (_) {}
    }
    el.remove();
  }
}

function renderGiphyGrid(grid, picks) {
  grid.innerHTML = "";
  for (const pick of picks) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "giphy-picker-tile";
    tile.title = pick.title;
    tile.setAttribute("aria-label", pick.title);
    const img = document.createElement("img");
    img.src = pick.thumbnailUrl;
    img.alt = "";
    img.loading = "lazy";
    img.className = "giphy-picker-tile-img";
    tile.appendChild(img);
    tile.addEventListener("click", (e) => {
      e.preventDefault();
      void stageGiphyPick(pick);
    });
    grid.appendChild(tile);
  }
}

async function stageGiphyPick(pick) {
  // Fetch the binary, stage it through the same path the paperclip /
  // paste / drag-drop intake uses. Visual feedback while the binary
  // downloads — typically <1s but can be 2-3s on slow connections.
  //
  // The abort signal is sourced from the picker modal so a user who
  // closes the picker mid-download cancels the fetch — otherwise the
  // download would complete and silently stage a file in the composer
  // after the picker is already gone, surprising the user with a chip.
  const status = document.getElementById("giphyPickerStatus");
  const modal = document.querySelector(".giphy-picker-modal");
  const signal = modal && modal._pickerAbort ? modal._pickerAbort.signal : undefined;
  if (status) status.textContent = "Downloading the GIF…";
  try {
    const res = await fetch(pick.originalUrl, { signal });
    if (!res.ok) throw new Error(`Giphy CDN ${res.status}`);
    const blob = await res.blob();
    // Force image/gif MIME so Substack's content_type field is what
    // its CDN expects (the Giphy URL always serves image/gif, but
    // some servers strip Content-Type — coerce defensively).
    const file = new File([blob], `giphy-${pick.id}.gif`, { type: "image/gif" });
    closeGiphyPickerModal();
    tryStageAttachment(file);
  } catch (e) {
    if (e && e.name === "AbortError") return; // picker closed mid-fetch
    if (status) status.textContent = "✗ Download failed: " + ((e && e.message) || e);
  }
}

// ----- Composer emoji popover -----
//
// Minimal popover with categories of common Unicode emojis. Click an
// emoji → inserts at cursor in the composer textarea, closes popover.
// We DON'T reuse the reaction picker because it returns reaction names
// (e.g. "thumbs_up") that map to glyphs — composer needs the raw glyph.

const COMPOSER_EMOJI_CATALOG = [
  { label: "Smileys", glyphs: ["😀","😄","😁","😂","🤣","😊","😉","😍","😘","😎","🤩","🥳","😜","🤔","🤨","😐","😶","🙄","😴","🤤","😪","😭","😢","😤","😡","🤬","🤯","😱","🥵","🥶"] },
  { label: "Hands", glyphs: ["👍","👎","👏","🙌","🤝","🙏","💪","✊","🤘","👌","👋","🤙","✋","🤲","☝️","🫶"] },
  { label: "Hearts", glyphs: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️‍🔥","💖","💘","💝","💞","💕"] },
  { label: "Symbols", glyphs: ["🔥","✨","⭐","🌟","💯","✅","❌","⚠️","🚀","🎉","🎯","💡","💎","🏆","🏅","🥇","🥈","🥉"] },
  { label: "Markets", glyphs: ["📈","📉","💰","💸","💵","💴","💶","💷","🪙","💳","🧾","🏦","📊","🔔"] },
  { label: "Food", glyphs: ["☕","🍕","🍔","🌮","🍩","🍪","🍰","🎂","🍿","🍫","🍦","🍺","🍷","🥂","🍾","🥃"] },
];

let _composerEmojiPopoverEl = null;

function openComposerEmojiPopover(input, anchorBtn) {
  // Re-click on the emoji button must TOGGLE the popover closed, not
  // close-then-reopen. The outside-click handler's btn.contains() guard
  // intentionally lets the button's own click reach this function; we
  // catch the "already open" case here and bail.
  if (_composerEmojiPopoverEl) {
    closeComposerEmojiPopover();
    return;
  }
  const pop = document.createElement("div");
  pop.id = "composerEmojiPopover";
  pop.className = "composer-emoji-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Insert emoji");

  for (const cat of COMPOSER_EMOJI_CATALOG) {
    const header = document.createElement("div");
    header.className = "composer-emoji-cat";
    header.textContent = cat.label;
    pop.appendChild(header);
    const row = document.createElement("div");
    row.className = "composer-emoji-row";
    for (const g of cat.glyphs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "composer-emoji-glyph";
      btn.textContent = g;
      btn.title = g;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        insertEmojiAtCursor(input, g);
      });
      row.appendChild(btn);
    }
    pop.appendChild(row);
  }

  // Position above the anchor button.
  document.body.appendChild(pop);
  const rect = anchorBtn.getBoundingClientRect();
  // Right-align to button, pop up above it.
  pop.style.position = "fixed";
  pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  pop.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
  _composerEmojiPopoverEl = pop;

  // Outside-click + Esc close.
  setTimeout(() => {
    document.addEventListener("click", composerEmojiOutsideClick, true);
    document.addEventListener("keydown", composerEmojiEscape);
  }, 0);
}

function composerEmojiOutsideClick(e) {
  if (!_composerEmojiPopoverEl) return;
  const btn = document.getElementById("composerEmojiBtn");
  if (_composerEmojiPopoverEl.contains(e.target)) return;
  if (btn && btn.contains(e.target)) return;
  closeComposerEmojiPopover();
}
function composerEmojiEscape(e) {
  if (e.key === "Escape") closeComposerEmojiPopover();
}
function closeComposerEmojiPopover() {
  if (_composerEmojiPopoverEl) {
    _composerEmojiPopoverEl.remove();
    _composerEmojiPopoverEl = null;
  }
  document.removeEventListener("click", composerEmojiOutsideClick, true);
  document.removeEventListener("keydown", composerEmojiEscape);
}

function insertEmojiAtCursor(input, glyph) {
  if (!input) return;
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  input.value = before + glyph + after;
  const newPos = start + glyph.length;
  try {
    input.focus();
    input.setSelectionRange(newPos, newPos);
  } catch (_) {}
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Renders the "Replying to X" bar above the textarea based on
// state.composer.replyingTo.
function renderComposerReplyBar() {
  const bar = document.getElementById("composerReply");
  const label = document.getElementById("composerReplyLabel");
  if (!bar || !label) return;
  const target = state.composer && state.composer.replyingTo;
  if (!target) {
    bar.classList.add("hidden");
    label.textContent = "";
    return;
  }
  bar.classList.remove("hidden");
  const preview =
    target.body && target.body.length
      ? ` — "${target.body.length > 60 ? target.body.slice(0, 57) + "…" : target.body}"`
      : "";
  label.textContent = "Replying to " + target.authorName + preview;
  // Move focus to the textarea so the user can start typing immediately.
  const input = document.getElementById("composerInput");
  if (input) {
    try {
      input.focus();
    } catch (_) {}
  }
}

// Called from the message hover toolbar's "Reply" button.
function startReplyTo(comment) {
  if (!comment) return;
  setReplyTarget(state.composer, comment);
  renderComposerReplyBar();
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
  // A staged attachment is enough on its own — Substack accepts comments
  // with the media body empty (we'll send "" as body and the upload
  // appears as the message content).
  const attachment = state.composer.attachment;
  if (!text && !attachment) return;
  if (state.composer.pending) return; // already in flight
  if (!state.postUuid) {
    showComposerError("No chat post loaded — refresh and try again.");
    return;
  }

  const rawText = input.value;
  const sendingMentions = { ...state.composer.mentions };
  const { body, mentions } = buildCommentBody(rawText, sendingMentions);
  const clientId = composerUuid();
  // Commit 6: attach reply parent / quote if the user clicked Reply.
  const replyFields = buildReplyFields(state.composer);
  const replyingToSnapshot = state.composer.replyingTo
    ? { ...state.composer.replyingTo }
    : null;

  // OPTIMISTIC: insert into the store and render IMMEDIATELY so the user
  // sees their message land without the 12s poll delay.
  const pending = buildPendingComment(clientId, state.user, body, mentions);
  // If this is a reply, attach the quote shape so the renderMessageItem
  // path renders the quoted block immediately on the optimistic row.
  if (replyingToSnapshot) {
    pending.parent_id = replyingToSnapshot.id;
    pending.quote = {
      id: replyingToSnapshot.id,
      body: replyingToSnapshot.body || "",
      author: replyingToSnapshot.author || null,
    };
  }
  // Attachment preview: stamp the staged-attachment's Object URL onto
  // the pending row so the existing appendAttachments renderer shows
  // the image immediately. After server reconciliation, the real CDN
  // URL replaces this — the blob URL then gets reclaimed when the
  // pending row's DOM node is discarded.
  //
  // We also stash the original File on `_stagedFile` so the retry path
  // (retryFailedMessage) can re-run register+PUT if the first attempt
  // failed BEFORE the upload landed. Without this, retry would silently
  // skip the upload and the message would send as text-only.
  if (attachment) {
    pending.media_uploads = [
      {
        id: clientId,
        type: "image",
        content_type: attachment.file.type,
        url: attachment.previewUrl,
        _localPreview: true,
        _stagedFile: attachment.file,
      },
    ];
  }
  state.comments.set(clientId, pending);
  insertInOrder(pending);
  renderAll();
  if (state.isAtBottom) scrollToBottom();

  // Clear the composer right away. If the send fails, the message stays in
  // the stream with a Retry button — we don't make the user re-type. The
  // text is preserved on the failed comment itself (via pending.body).
  input.value = "";
  state.composer.mentions = {};
  // Detach the staged attachment from state WITHOUT revoking its Object
  // URL — the pending row still references it for the preview. The URL
  // is reclaimed naturally when the pending DOM gets replaced by the
  // server-reconciled row carrying the real CDN URL.
  const stagedAttachment = state.composer.attachment;
  state.composer.attachment = null;
  renderComposerAttachment();
  // Clear the reply target on optimistic insert; the failed-retry path
  // re-attaches it from the pending comment's parent_id/quote.
  clearReplyTarget(state.composer);
  renderComposerReplyBar();
  autoGrowTextarea(input, { lineHeight: 22, maxRows: 4 });

  // Loading state on the button.
  state.composer.pending = { id: clientId, text: rawText };
  sendBtn.classList.add("is-sending");
  sendBtn.classList.remove("is-error");
  sendBtn.textContent = stagedAttachment ? "Uploading…" : "Sending…";
  sendBtn.disabled = true;
  clearComposerError();

  try {
    // Attachment upload runs BEFORE the comment POST. The server links
    // the upload to the comment by the shared clientId — if the upload
    // succeeds and the comment POST fails, the orphan upload gets
    // cleaned up server-side after a grace window. Per the HAR captures,
    // step 1 (register) returns {url, id}; step 2 (PUT) uploads the
    // bytes; step 3 is the existing comment POST.
    if (stagedAttachment) {
      try {
        const reg = await apiRegisterMedia({
          publicationId: state.publicationId,
          commentId: clientId,
          contentType: stagedAttachment.file.type,
        });
        if (!reg || !reg.url) {
          throw new Error("Upload registration returned no URL");
        }
        // Swap button to "Sending…" once the binary is up.
        await apiPutMediaBinary(reg.url, stagedAttachment.blob);
        sendBtn.textContent = "Sending…";
      } catch (uploadErr) {
        // Tag the error so the outer catch can show a UPLOAD-specific
        // toast — "Upload failed" tells the user to check file size /
        // format; the generic "Send failed" implies a network retry will
        // help, which it won't if the upload itself is the problem.
        if (uploadErr && typeof uploadErr === "object") {
          uploadErr._isUploadError = true;
        }
        throw uploadErr;
      }
    }
    const res = await apiPostComment(state.postUuid, {
      id: clientId,
      body,
      mentions,
      ...replyFields,
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
    // composer (which re-sends the same text + retries the upload).
    markPendingFailed(
      { comments: state.comments, order: state.order },
      clientId,
      (e && e.message) || "Send failed"
    );
    renderAll();
    // Upload-step failures get their own toast — "Send failed" implies a
    // retry might work; "Upload failed" tells the user to check file
    // size / format. The distinction matters because retryFailedMessage
    // re-runs the upload from the stashed File, so a transient upload
    // error IS retryable, but a file-too-big error never will be.
    const isUploadError = e && e._isUploadError;
    if (isUploadError) {
      showComposerError(
        "Upload failed: " + (e && e.message ? e.message : "unknown error") +
          " — check file size / format, or click the message to retry."
      );
    } else {
      showComposerError(
        "Send failed: " + (e && e.message ? e.message : "unknown error") +
          " — click the message to retry."
      );
    }
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
    else if (x.comment) {
      // Try the structured unwrap first. If it bails (because x.id is set
      // and there's no `type` discriminator), fall back to a manual
      // shallow-copy + attach x.user as author. Without this, the
      // optimistic-pending row gets replaced by a comment with no
      // author, which renders as "Unknown" — the user-reported bug.
      const unwrapped = unwrapComment(x);
      const c = unwrapped
        ? unwrapped
        : { ...x.comment, ...(x.user && !x.comment.author ? { author: x.user } : {}) };
      // Even after unwrap, sometimes author still isn't attached (depends
      // on whether unwrapComment's condition fired). Belt-and-suspenders.
      if (c && !c.author && x.user) c.author = x.user;
      candidates.push(c);
    } else if (x.id != null) candidates.push(x);
    // ^ The previous gate was `x.body && x.id`. That rejected
    // attachment-only messages (e.g. a GIF send with no caption) because
    // their body is the empty string — falsy. The fast-path reconcile
    // then silently failed and the optimistic row's `_pending: true`
    // stayed until something else triggered a re-render, leaving
    // "sending…" stamped under the image indefinitely. The fresh-comment
    // candidate just needs an id to be matchable; body content was never
    // a real requirement.
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
  // Pending / failed UI.
  for (const id of state.order) {
    const c = state.comments.get(id);
    if (!c) continue;
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
    // Commit 5: reaction toolbar (skip on pending/failed rows — can't react
    // to something that hasn't landed yet, and AI messages are local-only
    // so there's nothing on Substack to react to).
    if (!c._pending && !c._failed && !c._aiGenerated) {
      decorateReactionToolbar(node, c);
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
  // Preserve the reply context that was captured when the message was first
  // optimistically inserted (commit 6).
  const retryReply = {};
  if (c.parent_id) retryReply.parentId = c.parent_id;
  if (c.quote) retryReply.quote = c.quote;
  // Critical: if this message had a staged attachment that we couldn't
  // confirm landed on the server, we MUST re-run register+PUT before the
  // comment POST. Otherwise the retry would land as a text-only message
  // with no server-side media linked to it — silently dropping the
  // attachment the user sees on their pending row. The File handle is
  // stashed on the pending media_uploads entry at send time precisely
  // for this case.
  const stagedRetry =
    c.media_uploads &&
    c.media_uploads[0] &&
    c.media_uploads[0]._stagedFile;
  try {
    if (stagedRetry) {
      const file = c.media_uploads[0]._stagedFile;
      const reg = await apiRegisterMedia({
        publicationId: state.publicationId,
        commentId: clientId,
        contentType: file.type,
      });
      if (!reg || !reg.url) {
        const err = new Error("Upload registration returned no URL");
        err._isUploadError = true;
        throw err;
      }
      try {
        await apiPutMediaBinary(reg.url, file);
      } catch (uploadErr) {
        if (uploadErr && typeof uploadErr === "object") {
          uploadErr._isUploadError = true;
        }
        throw uploadErr;
      }
    }
    const res = await apiPostComment(state.postUuid, {
      id: clientId,
      body: c.body,
      mentions: c.mentions || {},
      ...retryReply,
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

// ============================================================
// REACTIONS (commit 5)
// ============================================================
//
// Hover toolbar with a "+" button → opens a full emoji picker. Clicking an
// emoji optimistically bumps the count + calls api.postReaction. On error we
// roll back. Decorator runs on every render via the MutationObserver in
// patchRenderAllForComposer. The picker is backed by the static REACTION_EMOJI
// catalog (lib/emojis.js) — no live library fetch.

function decorateReactionToolbar(node, comment) {
  if (node.querySelector(".msg-toolbar")) return; // already decorated
  const toolbar = document.createElement("div");
  toolbar.className = "msg-toolbar";

  // Quick-react strip — top 4 emojis used in this chat. Click sends the
  // reaction directly without opening the picker. topReactionsInChat
  // falls back to DEFAULT_SUGGESTED_REACTIONS when the chat has no
  // reactions yet, so the strip is never empty. Walking state.comments
  // here is O(N) but the toolbar is only decorated on the rendered nodes
  // (not all 1000+ messages in state) so the per-decoration cost is the
  // walk itself, ~1ms per render frame. Caching is doable later if it
  // shows up in a profile — defer.
  const quickNames = topReactionsInChat(
    [...state.comments.values()],
    4,
    reactionEmojiFor
  );
  for (const name of quickNames) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-toolbar-btn msg-quick-react";
    btn.title = `React with :${name}:`;
    btn.setAttribute("aria-label", `React with ${name}`);
    btn.textContent = reactionEmojiFor(name);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendReaction(comment, name);
    });
    toolbar.appendChild(btn);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "msg-toolbar-btn";
  addBtn.title = "Add reaction";
  addBtn.setAttribute("aria-label", "Add reaction");
  addBtn.textContent = "+";
  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleEmojiPicker(node, comment);
  });
  toolbar.appendChild(addBtn);
  // Commit 6: Reply button.
  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "msg-toolbar-btn";
  replyBtn.title = "Reply";
  replyBtn.setAttribute("aria-label", "Reply");
  replyBtn.textContent = "↩";
  replyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startReplyTo(comment);
  });
  toolbar.appendChild(replyBtn);

  // NOTE: the ✦ Explain affordance is intentionally NOT in this hover
  // toolbar. It's a persistent, always-visible trigger rendered at the
  // top-right of every message in renderMessageItem (makeExplainTrigger) so
  // it reads like X's per-post explain button instead of hiding behind hover.

  node.appendChild(toolbar);
}

// Tracks the single open picker's full teardown (DOM node + document click
// listener + pending focus timer). Module-level so opening a new picker — or
// re-clicking the same "+" — tears the previous one down completely instead of
// orphaning its document listener on the page.
let activePickerClose = null;

async function toggleEmojiPicker(node, comment) {
  const wasThisOpen = node._hasPicker;
  // Close whatever picker is currently open (this row's or another's),
  // including its document listener and pending timer — not just the DOM node.
  if (activePickerClose) activePickerClose();
  // Toggle: clicking "+" on the row whose picker was open just closes it.
  if (wasThisOpen) return;

  // Panel: search box + a "Frequently used" row derived from THIS chat's
  // reactions + the full categorized catalog. All static (lib/emojis.js) —
  // no live library fetch.
  const picker = document.createElement("div");
  picker.className = "emoji-picker emoji-picker-panel";

  const search = document.createElement("input");
  search.type = "text";
  search.className = "emoji-search-input";
  search.placeholder = "Search emoji";
  search.setAttribute("aria-label", "Search emoji");
  // Keep clicks/keys inside the field from reaching the click-outside handler
  // or the app's global vi key nav (j/k/g).
  search.addEventListener("click", (e) => e.stopPropagation());
  search.addEventListener("keydown", (e) => e.stopPropagation());
  picker.appendChild(search);

  const scroll = document.createElement("div");
  scroll.className = "emoji-picker-scroll";
  picker.appendChild(scroll);

  // Pending focus/listener timer (set at the bottom). Cleared on close so a
  // fast double-click can't re-attach this picker's listener after teardown.
  let addTimer = null;

  // Click-outside to close. Declared before closeThisPicker so the closure
  // dependency is explicit to the next maintainer.
  const onDocClick = (e) => {
    if (!picker.contains(e.target) && !node.contains(e.target)) {
      closeThisPicker();
    }
  };

  function closeThisPicker() {
    if (addTimer !== null) {
      clearTimeout(addTimer);
      addTimer = null;
    }
    picker.remove();
    node.classList.remove("has-picker");
    node._hasPicker = false;
    document.removeEventListener("click", onDocClick, true);
    if (activePickerClose === closeThisPicker) activePickerClose = null;
  }

  // One labeled section of emoji buttons. Dedupes by glyph so aliases that
  // render the same emoji don't double up within a section. Returns null
  // when the section would be empty.
  const buildSection = (label, entries) => {
    const seen = new Set();
    const grid = document.createElement("div");
    grid.className = "emoji-grid";
    for (const [name, glyph] of entries) {
      if (seen.has(glyph)) continue;
      seen.add(glyph);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emoji-picker-btn";
      btn.title = `:${name}:`;
      btn.textContent = glyph;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeThisPicker();
        sendReaction(comment, name);
      });
      grid.appendChild(btn);
    }
    if (!grid.childElementCount) return null;
    const section = document.createElement("div");
    section.className = "emoji-cat";
    const head = document.createElement("div");
    head.className = "emoji-cat-label";
    head.textContent = label;
    section.appendChild(head);
    section.appendChild(grid);
    return section;
  };

  // Default view: Frequently used (from this chat) + the full catalog.
  const renderDefault = () => {
    scroll.replaceChildren();
    const favNames = topReactionsInChat(
      state.comments.values(),
      8,
      composerReactionEmojiFor
    );
    const favEntries = favNames.map((n) => [n, composerReactionEmojiFor(n)]);
    const fav = buildSection("Frequently used", favEntries);
    if (fav) scroll.appendChild(fav);
    for (const group of groupedReactions()) {
      const section = buildSection(group.label, group.entries);
      if (section) scroll.appendChild(section);
    }
  };

  // Search view: a single flat section, or an empty-state.
  const renderResults = (query) => {
    scroll.replaceChildren();
    const section = buildSection("Results", filterReactionsByQuery(query));
    if (section) {
      scroll.appendChild(section);
    } else {
      const empty = document.createElement("div");
      empty.className = "emoji-picker-empty";
      empty.textContent = "No emoji match";
      scroll.appendChild(empty);
    }
  };

  search.addEventListener("input", () => {
    const q = search.value.trim();
    if (q) renderResults(q);
    else renderDefault();
  });

  renderDefault();
  node.appendChild(picker);
  node.classList.add("has-picker");
  node._hasPicker = true;
  activePickerClose = closeThisPicker;
  // Defer so the opening click doesn't immediately trigger click-outside, then
  // focus the search. Tracked in addTimer so closeThisPicker can cancel it if
  // the picker is torn down first (fast double-click race).
  addTimer = setTimeout(() => {
    addTimer = null;
    document.addEventListener("click", onDocClick, true);
    search.focus();
  }, 0);
}

async function sendReaction(comment, type) {
  if (!comment || !type) return;
  const id = comment.id;
  // Optimistic bump.
  const prevReactions = comment.reactions;
  comment.reactions = updateReactionCount(prevReactions, type, +1);
  // Surgical DOM update — replace only the .msg-reactions row on this
  // message's node. Full renderAll() would replaceChildren the whole
  // message list and yank scroll position when reacting mid-history.
  updateReactionsDom(id, comment);
  try {
    await apiPostReaction(id, type);
  } catch (e) {
    // Rollback — same surgical path.
    comment.reactions = prevReactions;
    updateReactionsDom(id, comment);
    showError(
      "Reaction failed: " + ((e && e.message) || "unknown error")
    );
  }
}

// Replace just the reactions row inside a single message's DOM node.
// No-op if the node isn't currently rendered (filtered out, virtualized,
// not yet ingested) — state is the source of truth; next renderAll picks
// it up.
function updateReactionsDom(id, comment) {
  const node = document.querySelector(
    `.msg-item[data-id="${cssEscape(String(id))}"]`
  );
  if (!node) return;
  const existing = node.querySelector(":scope > .msg-reactions");
  if (existing) existing.remove();
  const fresh = buildReactionsEl(comment);
  if (fresh) node.appendChild(fresh);
}

// Mount when the app is visible. If we're on the landing screen, #composer
// doesn't exist and mountComposer is a no-op. If we're in the app, calling
// it here happens AFTER bindEventHandlers — fine, the composer's own
// listeners are scoped to its own elements.
if (typeof appEl !== "undefined" && appEl && !appEl.classList.contains("hidden")) {
  mountComposer();
  patchRenderAllForComposer();
}
