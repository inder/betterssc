# BetterSSC

A Discord-style Chrome extension client for Substack Chat.

Substack's native chat UI is clunky: weak presence, no real search, no @mention notifications, erratic scroll behavior. BetterSSC replaces it with a clean two-pane interface that uses Substack's own REST API and WebSocket so you get the same data your account already has access to — just better presented.

**Status: v0.1 — read-only.** Send / react / mention land in v0.2.

## What v0.1 does

- **Live message stream** of one Substack chat, rendered Discord-style with grouped consecutive sender messages.
- **Realtime updates** via Substack's `wss://zyncrealtime.substack.com` channel. New messages and reaction changes appear instantly without polling.
- **History pagination** — scroll up to load older messages via cursor-based REST.
- **Client-side full-text search** across all loaded messages. Press `/` to focus, `Esc` to clear.
- **@mention desktop notifications** via `chrome.notifications`. Click a notification → focus BetterSSC tab and scroll to the message. Toolbar badge shows unread mention count.
- **Members rail** showing active participants derived from message authors, sorted by last-seen.
- **Auto mark-viewed** so your unread count in native Substack stays in sync.

## What v0.1 does NOT do (yet)

- Send messages, react, or edit. Use the link in the footer to open the chat in native Substack for those actions — messages you send there will appear in BetterSSC live.
- Multi-chat switching. v0.1 shows one chat per tab (the chat URL you had open when you clicked the toolbar icon).
- Image / attachment / poll rendering.

## How it works

1. Click the BetterSSC toolbar icon while you have a Substack chat tab open (any URL matching `substack.com/chat/<pubId>/post/<postUuid>`).
2. BetterSSC opens in a new tab and reads that URL to know which chat to load.
3. Identity comes from `window._analyticsConfig` in your Substack tab (read via a content script).
4. Initial messages load via `GET /api/v1/community/posts/<postUuid>/comments?initial=true`.
5. A JWT for `wss://zyncrealtime.substack.com` is fetched and the WebSocket subscribes to the highest-tier chat channel your account has access to.
6. New comments, reaction changes, and post updates arrive as WS events and update the UI in place.

All HTTP and WebSocket traffic goes directly to Substack from your browser with your existing session cookie. **No third-party backend; nothing leaves your machine except calls to substack.com.**

## Install (dev / unpacked)

1. Clone this repo.
2. Open `chrome://extensions` in Chrome / Brave / Arc / Edge.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked**.
5. Select this directory.
6. Open a Substack chat in another tab.
7. Click the BetterSSC icon in the toolbar.

If you re-load the extension while the chat is already open in BetterSSC, refresh the BetterSSC tab too.

## Architecture

```
manifest.json              MV3 manifest. Two content scripts: a MAIN-world
                           network sniffer + an ISOLATED-world DOM probe,
                           both useful for debugging. Background service
                           worker handles toolbar action + notifications.
background.js              chrome.action.onClicked → opens app.html, passing
                           pub/post params extracted from the active tab's
                           URL. Forwards notification triggers.
content.js                 Debug-only DOM probe + console helper. Exposes
                           __betterssc_probe() on Substack pages.
network-hook.js            Page-main-world fetch/XHR/WebSocket sniffer used
                           during protocol discovery; left in for now to
                           catch any new endpoints during build.
app.html                   The Discord-style UI entry point. Two-pane.
app.css                    Discord-inspired dark theme.
app.js                     Main controller: state, REST loading, WS event
                           handling, search, rendering, scroll behavior.
lib/api.js                 REST client for every confirmed endpoint.
lib/ws.js                  SubstackRealtime — WebSocket client with auto-
                           reconnect (exponential backoff) and JWT refresh.
lib/util.js                Helpers: time formatting, mention/URL segmenting,
                           message grouping, throttle/debounce, uuid.
lib/notify.js              @mention detection → background notification.
```

## Endpoints used

All REST calls require your Substack session cookie (sent automatically by the browser on cross-origin requests from the extension, since we declare `host_permissions` for substack.com).

| Purpose | Method | Path |
|---|---|---|
| Initial messages | GET | `/api/v1/community/posts/<postUuid>/comments?order=asc&initial=true` |
| Older messages | GET | `/api/v1/community/posts/<postUuid>/comments?order=desc&before=<ISO>` |
| Publication metadata | GET | `/api/v1/publication/public/<publicationId>` |
| Realtime token | GET | `/api/v1/realtime/token?channels=<encoded>` |
| Mark chat viewed | POST | `/api/v1/community/chat/<pubId>/view` |
| Reactions library | GET | `/api/v1/threads/reactions` |
| Blocks / mutes | GET | `/api/v1/blocks/ids` |
| WebSocket | WSS | `wss://zyncrealtime.substack.com` |

## Privacy

- BetterSSC does not phone home. There is no analytics, no telemetry, no third-party scripts.
- All data fetched stays in your browser. Settings persist in `chrome.storage.local` only.
- Your Substack session cookie is used for API calls in the same way Substack's own website uses it.

## Roadmap

- **v0.2** — Send messages, add reactions, @mention autocomplete, reply / quote, optimistic UI.
- **v0.3** — Multi-chat support (left rail of all chats from inbox), unread badges, quick switcher.
- **v0.4** — DMs, image upload, edit / delete own messages.

## License

MIT (or whatever — placeholder).
