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
  constructor({ channels, secondaryChannels, onStatusChange }) {
    super();
    this.channels = channels;
    // Optional second channel set for the subscribe-after-auth handshake.
    // When provided we fetch a second token scoped to this list and send
    // it as a follow-up frame once the first auth OK arrives.
    this.secondaryChannels = secondaryChannels || null;
    this.onStatusChange = onStatusChange || (() => {});
    this.ws = null;
    this.token = null;
    this.secondaryToken = null;
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

      // Pre-fetch the secondary token if requested (used for the
      // subscribe-after-auth handshake).
      this.secondaryToken = null;
      if (this.secondaryChannels && this.secondaryChannels.length) {
        try {
          const t2 = await fetchRealtimeToken(this.secondaryChannels);
          this.secondaryToken = t2.token;
        } catch (e) {
          console.warn(
            "[BetterSSC WS] secondary token fetch failed:",
            e && e.message
          );
        }
      }

      const ws = new WebSocket(this.endpoint);
      this.ws = ws;

      ws.addEventListener("open", () => {
        // v0.1.13: match the native client's exact frame sequence captured
        // in v0.0.4. It sends the user-scoped token TWICE in a row on open
        // (synchronously, no delay between sends), waits for the first OK
        // ack, then sends the broader chat-scoped token. Our prior attempts
        // (v0.1.8 single frame, v0.1.2 same combined-token twice) all got
        // Invalid message; the missing piece appears to be the duplicate of
        // the NARROW token. Theory: first frame authenticates + subscribes
        // to user channel; second frame is a "ready for events" confirm.
        const frame = JSON.stringify({ token: this.token });
        console.log(
          "[BetterSSC WS] → OPEN, sending auth frame ×2 (channels:",
          this.channels,
          ")"
        );
        ws.send(frame);
        ws.send(frame); // duplicate, matches native exactly
        this._subscribeFrameSent = false;
      });

      ws.addEventListener("message", (event) => {
        const preview =
          typeof event.data === "string"
            ? event.data.slice(0, 400)
            : "[binary]";
        console.log("[BetterSSC WS] ← IN:", preview);

        // Auth-then-subscribe: when we get the first OK ack, send the
        // secondary token (different scope) for chat-channel subscription.
        if (!this._subscribeFrameSent && this.secondaryToken) {
          try {
            const parsed = JSON.parse(event.data);
            if (
              parsed &&
              parsed.data &&
              parsed.data.status === "OK" &&
              !parsed.error
            ) {
              const frame2 = JSON.stringify({ token: this.secondaryToken });
              console.log(
                "[BetterSSC WS] → sending subscribe frame 2/2 (channels:",
                this.secondaryChannels,
                ")"
              );
              try {
                ws.send(frame2);
              } catch (_) {}
              this._subscribeFrameSent = true;
            }
          } catch (_) {}
        }

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
