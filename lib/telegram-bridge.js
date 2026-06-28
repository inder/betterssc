// lib/telegram-bridge.js — IO + control layer for the Substack → Telegram bridge.
//
// Pure formatting/decision logic lives in lib/telegram.js (unit-tested). This
// module owns the side-effecting parts: network calls to api.telegram.org, the
// outbound send queue, the inbound getUpdates poll, chat-id acquisition, and
// the live probe logging. It is dependency-injected (no direct app.js / chrome
// references) so it stays decoupled from the overlay.
//
// SECURITY (invariant 4): the bot token is a secret. It is never logged. Any
// string we DO log is run through scrub() to defensively strip the token, in
// case Telegram echoes it back inside an error description.

import {
  formatMessageForTelegram,
  formatPhotoCaption,
  pickImageUrl,
  shouldForward,
  parseGetUpdates,
  nextOffset,
  escapeTelegramHtml,
  textForPostBack,
  mapTelegramReaction,
} from "./telegram.js";

const API = "https://api.telegram.org";
// Telegram allows ~1 message/sec per chat; space sends a touch above that so a
// quiet-then-busy thread's batch drips out instead of tripping 429s.
const SEND_SPACING_MS = 1200;
// Short-poll getUpdates cadence. The overlay tab is long-lived, so a plain
// interval is fine; Chrome throttles it to ~1/min when the tab is hidden.
const POLL_SPACING_MS = 5000;

export function createTelegramBridge(deps = {}) {
  const {
    getCurrentCommentIds = () => [],
    getSelfId = () => null,
    onChatIdCaptured = null,
    onProbeEvent = null,
    log = console.log,
    // Write-back (slices 5-6). All optional; absent → read-only bridge.
    makeClientId = null, // () => string  (Substack honors client id as comment id)
    postSubstackMessage = null, // (text, clientId) => Promise<commentId|null>
    addSubstackReaction = null, // (commentId, reactionName) => Promise<void>
  } = deps;

  const cfg = { token: null, chatId: null, streaming: false };
  const sentIds = new Set(); // idempotency: comment ids already forwarded
  // Telegram message_id → Substack comment id, recorded on every outbound send
  // so an inbound reaction can be routed back to the right comment. In-memory
  // (lost on reload → reactions on pre-reload messages are skipped) and bounded.
  const msgMap = new Map();
  const MSG_MAP_MAX = 1000;
  let updateOffset = 0;
  const sendQueue = [];
  let draining = false;
  let pollTimer = null;
  let pollStarting = false;
  let pollInflight = false;
  let seeded = false;

  const _log = (...a) => {
    try {
      log("[BetterSSC TG]", ...a.map((x) => (typeof x === "string" ? scrub(x) : x)));
    } catch (_) {}
  };
  const scrub = (s) => {
    if (!cfg.token) return s;
    try {
      return String(s).split(cfg.token).join("<token>");
    } catch (_) {
      return s;
    }
  };

  // ── Telegram API ───────────────────────────────────────────────────────────
  async function tgCall(method, params) {
    if (!cfg.token) throw new Error("no token configured");
    const r = await fetch(`${API}/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {}),
    });
    let json = null;
    try {
      json = await r.json();
    } catch (_) {}
    if (!json || !json.ok) {
      const desc = (json && json.description) || `HTTP ${r.status}`;
      const err = new Error(desc);
      err.errorCode = json && json.error_code;
      throw err;
    }
    return json.result;
  }

  // ── Config / validation ─────────────────────────────────────────────────────
  // Validate a token via getMe. Returns the bot info, or throws on a bad token
  // (without keeping the bad token around).
  async function validateToken(token) {
    const prev = cfg.token;
    cfg.token = token;
    try {
      return await tgCall("getMe"); // {id, username, first_name, ...}
    } catch (e) {
      cfg.token = prev;
      throw e;
    }
  }

  function setConfig(next = {}) {
    if (next.token !== undefined) cfg.token = next.token;
    if (next.chatId !== undefined) cfg.chatId = next.chatId;
    if (next.streaming !== undefined) cfg.streaming = next.streaming;
  }
  function getConfig() {
    return {
      hasToken: !!cfg.token,
      chatId: cfg.chatId,
      streaming: cfg.streaming,
    };
  }

  // A webhook and getUpdates are mutually exclusive (getUpdates → 409 if a
  // webhook is set). Drop any webhook before we start polling.
  async function deleteWebhook() {
    try {
      await tgCall("deleteWebhook", { drop_pending_updates: false });
    } catch (e) {
      _log("deleteWebhook failed (continuing):", e && e.message);
    }
  }

  // ── Outbound (Substack → Telegram) ──────────────────────────────────────────
  // Defense-in-depth: mark every currently-loaded comment id as already-sent.
  // The poll only ever hands us genuinely-new comments, so the backlog can't be
  // forwarded anyway — this just guarantees it across any future re-ingest path.
  function seedSent() {
    try {
      for (const id of getCurrentCommentIds() || []) sentIds.add(id);
    } catch (_) {}
    seeded = true;
  }

  function enableStreaming() {
    seedSent();
    cfg.streaming = true;
  }
  function disableStreaming() {
    cfg.streaming = false;
  }

  // Fire-and-forget (invariant 6): enqueue new comments and return immediately.
  // NEVER awaited by the caller (the Substack poll loop), so Telegram latency
  // can't stall the next poll.
  function forwardNewMessages(comments) {
    if (!cfg.streaming || !cfg.token || cfg.chatId == null) return;
    if (!seeded) seedSent();
    const selfId = getSelfId() ?? null;
    for (const c of comments || []) {
      if (!shouldForward(c, sentIds, selfId)) continue;
      sentIds.add(c.id); // mark before send so a re-poll can't double-enqueue
      sendQueue.push(c);
    }
    drainSoon();
  }

  // Self-scheduling drain: the next send is scheduled only AFTER the current
  // one settles, so spacing includes the request duration (a slow send can't be
  // lapped by the next tick) and delivery order is preserved.
  function drainSoon() {
    if (draining || !sendQueue.length) return;
    draining = true;
    const tick = async () => {
      if (!sendQueue.length) {
        draining = false;
        return;
      }
      const c = sendQueue.shift();
      try {
        await sendOne(c);
      } catch (e) {
        _log("send failed:", e && e.message);
      }
      setTimeout(tick, SEND_SPACING_MS);
    };
    setTimeout(tick, 0);
  }

  // Record the Telegram message_id → Substack comment id mapping so an inbound
  // reaction on this message routes back to the right comment.
  function rememberSent(result, c) {
    const mid = result && result.message_id;
    if (mid == null || c.id == null) return;
    msgMap.set(mid, c.id);
    if (msgMap.size > MSG_MAP_MAX) {
      // drop oldest (Map preserves insertion order)
      msgMap.delete(msgMap.keys().next().value);
    }
  }

  async function sendOne(c) {
    const img = pickImageUrl(c);
    if (img) {
      try {
        const res = await tgCall("sendPhoto", {
          chat_id: cfg.chatId,
          photo: img,
          caption: formatPhotoCaption(c),
          parse_mode: "HTML",
        });
        rememberSent(res, c);
        return;
      } catch (e) {
        // Telegram fetches the photo by URL server-side; if the URL is signed /
        // not publicly fetchable it fails. Fall back to a text message with the
        // link so the message still arrives (oracle #1: it must appear).
        _log("sendPhoto failed, falling back to text:", e && e.message);
      }
    }
    const m = formatMessageForTelegram(c);
    let text = m.text;
    // Escape the URL: it's attacker-controllable JSON and signed URLs carry
    // raw & query params that would break parse_mode:"HTML" (the 400 that loses
    // the very fallback message meant to guarantee delivery).
    if (img) text += `\n${escapeTelegramHtml(img)}`;
    const res = await tgCall("sendMessage", {
      chat_id: cfg.chatId,
      text,
      parse_mode: m.parse_mode,
      disable_web_page_preview: false,
    });
    rememberSent(res, c);
  }

  // ── Inbound poll / live probe (Telegram → here) ─────────────────────────────
  // Runs whenever we have a token. Captures the chat id from the first incoming
  // message (a bot can't message a user until the user messages it first), and
  // LOUDLY logs every update type so the user can confirm message /
  // message_reaction delivery for a PRIVATE chat before any write-back is built
  // (the probe — honors invariant 3).
  function startPoll() {
    if (pollTimer || pollStarting || !cfg.token) return;
    pollStarting = true; // synchronous guard against a double-start race
    deleteWebhook().finally(() => {
      pollStarting = false;
      if (!pollTimer && cfg.token) pollTimer = setInterval(pollOnce, POLL_SPACING_MS);
    });
  }
  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    pollStarting = false;
  }

  // Full teardown for disconnect / switching to a different bot. getUpdates'
  // offset is per-bot-token, so a stale offset would skip a new bot's early
  // updates (including the chat-id-capturing first message) — clear everything.
  function reset() {
    stopPoll();
    sendQueue.length = 0;
    draining = false;
    pollInflight = false;
    sentIds.clear();
    msgMap.clear();
    updateOffset = 0;
    seeded = false;
    cfg.token = null;
    cfg.chatId = null;
    cfg.streaming = false;
  }

  async function pollOnce() {
    if (!cfg.token || pollInflight) return;
    pollInflight = true; // reentrancy guard — a slow batch of write-backs must
    // not be lapped by the next interval (would reorder / double-process)
    try {
      let result;
      try {
        result = await tgCall("getUpdates", {
          offset: updateOffset,
          timeout: 0,
          allowed_updates: ["message", "message_reaction"],
        });
      } catch (e) {
        if (e.errorCode === 409) {
          _log("getUpdates 409 — a webhook is set on this bot. Deleting it, then retrying.");
          await deleteWebhook();
        } else {
          _log("getUpdates failed:", e && e.message);
        }
        return;
      }
      const events = parseGetUpdates({ result });
      if (!events.length) return;
      // ACK to Telegram up front: an update is consumed once. A failed write-back
      // is dropped (not retried) — reprocessing would risk a double-post
      // (invariant 5). The user gets a Telegram reply on failure instead.
      updateOffset = nextOffset(events, updateOffset);
      for (const ev of events) {
        if (ev.type === "message" && !ev.fromBot && ev.chatId != null && cfg.chatId == null) {
          cfg.chatId = ev.chatId;
          _log("captured chat id from incoming message");
          try {
            onChatIdCaptured && onChatIdCaptured(ev.chatId);
          } catch (_) {}
        }
        // PROBE: report every delivered update so legs a (message) and b
        // (reaction) can be confirmed live during dogfood.
        _log(
          `probe: update ${ev.updateId} type=${ev.type}` +
            (ev.type === "reaction" ? ` emoji=${ev.emoji}` : "")
        );
        try {
          onProbeEvent && onProbeEvent(ev);
        } catch (_) {}
        // Write-back is active only while the bridge is streaming and only for
        // events in the linked chat (ignore other chats messaging the bot).
        if (cfg.streaming && ev.chatId != null && cfg.chatId != null && ev.chatId === cfg.chatId) {
          try {
            await routeInbound(ev);
          } catch (e) {
            _log("write-back failed:", e && e.message);
          }
        }
      }
    } finally {
      pollInflight = false;
    }
  }

  // Route one inbound Telegram event to Substack (post-back / react-back).
  async function routeInbound(ev) {
    if (ev.type === "message" && !ev.fromBot) {
      const text = textForPostBack(ev.text);
      if (!text || !postSubstackMessage || !makeClientId) return;
      // ECHO PREVENTION (invariant 5): claim the comment id BEFORE the post so
      // the separate Substack poll can never fetch-and-re-forward it during the
      // await window. Substack honors the client id as the comment id.
      const clientId = makeClientId();
      sentIds.add(clientId);
      let posted = null;
      try {
        posted = await postSubstackMessage(text, clientId);
      } catch (e) {
        _log("post-back failed:", e && e.message);
      }
      // Treat BOTH a throw AND a falsy return (overlay not ready / logged out /
      // empty body) as a failure: drop the phantom id and tell the user, so a
      // silently-vanished message never looks posted.
      if (!posted) {
        sentIds.delete(clientId);
        try {
          await tgCall("sendMessage", {
            chat_id: cfg.chatId,
            text: "⚠️ Couldn't post that to Substack — please try again.",
          });
        } catch (_) {}
      }
    } else if (ev.type === "reaction") {
      if (!addSubstackReaction) return;
      const commentId = msgMap.get(ev.messageId);
      if (commentId == null) return; // reaction on a non-bridged / pre-reload message
      const name = mapTelegramReaction(ev.emoji); // null on unmapped/removed → skip (invariant 7)
      if (!name) return;
      await addSubstackReaction(commentId, name);
    }
  }

  return {
    validateToken,
    setConfig,
    getConfig,
    seedSent,
    enableStreaming,
    disableStreaming,
    forwardNewMessages,
    startPoll,
    stopPoll,
    reset,
    deleteWebhook,
    getChatId: () => cfg.chatId,
    // exposed for diagnostics/tests
    _state: () => ({ sentCount: sentIds.size, queued: sendQueue.length, offset: updateOffset }),
  };
}
