// Substack realtime WebSocket client for BetterSSC.
//
// Confirmed protocol (v0.0.5 probe):
//   1. POST /api/v1/realtime/token?channels=... → { token, expiry, endpoint, permissions }
//   2. Open WebSocket to endpoint (always wss://zyncrealtime.substack.com).
//   3. Send `{ token: <JWT> }` as first frame to authenticate + subscribe to
//      whatever channels the JWT permissions cover. Server acks with
//      `{ error: null, data: { status: "OK" } }`.
//   4. Events arrive as `{ error, data: { channel, message } }` where
//      `message` is a JSON-encoded string. Parse it and dispatch by `type`.
//
// Known event types:
//   - chat:new-comment        — { type, comment }
//   - chat:updated-comment    — { type, comment }   (edits AND reaction changes)
//   - chat:updated-post       — { type, post }
//
// Reconnect strategy: exponential backoff 1s → 2s → 4s → 8s → 16s → cap 30s.
// Token refresh: scheduled ~5min before declared expiry.

import { fetchRealtimeToken } from "./api.js";

const ENDPOINT_DEFAULT = "wss://zyncrealtime.substack.com";
const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;

export class SubstackRealtime extends EventTarget {
  constructor({ channels, onStatusChange }) {
    super();
    this.channels = channels;
    this.onStatusChange = onStatusChange || (() => {});
    this.ws = null;
    this.token = null;
    this.endpoint = ENDPOINT_DEFAULT;
    this.permissions = [];
    this.backoffMs = 1000;
    this.tokenRefreshTimer = null;
    this.closed = false;
    this.status = "idle";
  }

  setStatus(s) {
    this.status = s;
    this.onStatusChange(s);
    this.dispatchEvent(new CustomEvent("status", { detail: s }));
  }

  async connect() {
    if (this.closed) return;
    // Clear any pending refresh timer from a prior connection — it would race
    // with this connection's own refresh schedule otherwise.
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.setStatus("connecting");
    try {
      const tokenRes = await fetchRealtimeToken(this.channels);
      this.token = tokenRes.token;
      this.endpoint = tokenRes.endpoint || ENDPOINT_DEFAULT;
      this.permissions = tokenRes.permissions || [];

      const ws = new WebSocket(this.endpoint);
      this.ws = ws;

      ws.addEventListener("open", () => {
        // v0.1.3: revert to a single frame. The "two-frame" theory from
        // v0.1.2 didn't match what we observe — both our frames were getting
        // Invalid-message responses. Native client probably sends twice as a
        // belt-and-suspenders, not as a hard requirement.
        const frame = JSON.stringify({ token: this.token });
        console.log("[BetterSSC WS] → OPEN, sending auth frame");
        ws.send(frame);
      });

      ws.addEventListener("message", (event) => {
        // Log every inbound frame raw so we can see what the server actually
        // says vs what we expect.
        const preview =
          typeof event.data === "string"
            ? event.data.slice(0, 400)
            : "[binary]";
        console.log("[BetterSSC WS] ← IN:", preview);
        this._handleRawMessage(event.data);
      });

      ws.addEventListener("close", (event) => {
        this._handleClose(event);
      });

      ws.addEventListener("error", () => {
        // The browser fires error then close; we handle reconnect in close.
        this.setStatus("error");
      });

      // Schedule token refresh.
      this._scheduleTokenRefresh(tokenRes.expiry);
    } catch (e) {
      this.setStatus("error");
      this._scheduleReconnect();
    }
  }

  _handleRawMessage(raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (envelope && envelope.error) {
      // Server-side error frames. "Invalid message" is a frequent noisy
      // false-error that doesn't seem to block live event delivery — we log
      // but don't escalate. "Missing permission" still propagates because
      // it indicates a real channel-access issue.
      if (envelope.error === "Invalid message") {
        console.log("[BetterSSC WS] ignoring 'Invalid message' (noisy)");
        return;
      }
      this.dispatchEvent(
        new CustomEvent("server-error", { detail: envelope.error })
      );
      return;
    }
    const data = envelope && envelope.data;
    if (!data) return;
    if (data.status === "OK") {
      // subscribe ack; first OK transitions us to "connected".
      if (this.status !== "connected") {
        this.setStatus("connected");
        this.backoffMs = 1000;
      }
      return;
    }
    if (typeof data.message === "string" && data.channel) {
      let inner;
      try {
        inner = JSON.parse(data.message);
      } catch (_) {
        return;
      }
      this.dispatchEvent(
        new CustomEvent("chat-event", {
          detail: { channel: data.channel, ...inner },
        })
      );
    }
  }

  _handleClose(event) {
    this.ws = null;
    // Tear down the refresh timer attached to the dead socket — the next
    // connect() will schedule a fresh one against the new token's expiry.
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.setStatus("disconnected");
    if (this.closed) return;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(this.backoffMs, MAX_BACKOFF_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.connect(), delay);
  }

  _scheduleTokenRefresh(expiryISO) {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    if (!expiryISO) return;
    try {
      const exp = new Date(expiryISO).getTime();
      const now = Date.now();
      const refreshIn = Math.max(30_000, exp - now - TOKEN_REFRESH_LEAD_MS);
      this.tokenRefreshTimer = setTimeout(() => this._refreshToken(), refreshIn);
    } catch (_) {}
  }

  async _refreshToken() {
    if (this.closed) return;
    try {
      const tokenRes = await fetchRealtimeToken(this.channels);
      this.token = tokenRes.token;
      this.permissions = tokenRes.permissions || [];
      // Send new token frame to re-authorize the existing connection.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ token: this.token }));
      }
      this._scheduleTokenRefresh(tokenRes.expiry);
    } catch (e) {
      // If refresh fails, force a reconnect.
      try {
        this.ws && this.ws.close();
      } catch (_) {}
    }
  }

  close() {
    this.closed = true;
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    try {
      if (this.ws) this.ws.close();
    } catch (_) {}
    this.ws = null;
    this.setStatus("closed");
  }
}
