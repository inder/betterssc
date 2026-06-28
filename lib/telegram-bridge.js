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
  } = deps;

  const cfg = { token: null, chatId: null, streaming: false };
  const sentIds = new Set(); // idempotency: comment ids already forwarded
  let updateOffset = 0;
  const sendQueue = [];
  let draining = false;
  let pollTimer = null;
  let pollStarting = false;
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

  async function sendOne(c) {
    const img = pickImageUrl(c);
    if (img) {
      try {
        await tgCall("sendPhoto", {
          chat_id: cfg.chatId,
          photo: img,
          caption: formatPhotoCaption(c),
          parse_mode: "HTML",
        });
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
    await tgCall("sendMessage", {
      chat_id: cfg.chatId,
      text,
      parse_mode: m.parse_mode,
      disable_web_page_preview: false,
    });
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
    sentIds.clear();
    updateOffset = 0;
    seeded = false;
    cfg.token = null;
    cfg.chatId = null;
    cfg.streaming = false;
  }

  async function pollOnce() {
    if (!cfg.token) return;
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
      // (reaction) can be confirmed live before write-back is wired.
      _log(
        `probe: update ${ev.updateId} type=${ev.type}` +
          (ev.type === "reaction" ? ` emoji=${ev.emoji}` : "")
      );
      try {
        onProbeEvent && onProbeEvent(ev);
      } catch (_) {}
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
