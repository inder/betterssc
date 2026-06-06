# BetterSSC

A Chrome extension that gives Substack Chat a Discord-style makeover.

**[Install](#install)** · **[Give feedback](https://github.com/inder/betterssc/issues/new)** · **[Roadmap](#roadmap)**

---

## Why this exists

Substack Chat is where a lot of really good traders and writers share their thinking in real time. The trouble is the interface gets in the way:

- Search usually doesn't find what you're looking for.
- If 200 people are posting, there's no easy way to focus on just the 3 you care about.
- You don't get notifications when a specific person posts, or even when someone @mentions you.
- Scroll position resets in weird ways when older messages load.
- Threads of 10 replies all show up as a flat wall of text.
- The whole thing feels like it was built for mobile first and never quite finished for desktop.

BetterSSC keeps your existing Substack account and reads from Substack's own API. It just paints a nicer layout on top so you can actually follow conversations.

## What it does (v0.1)

### Reading the chat

- Two-pane Discord-style layout. Real names, real avatars, real emoji reactions (no more `:flexed_biceps:` showing up as text).
- When someone quotes another message, the quoted block is a clickable accent-color card. Click it to jump to the original and watch it flash amber so you can find it.
- Inline images, click for a full-screen lightbox. If an image fails to load it falls back to a "📎 image (click to open)" link.
- Light theme by default, dark theme one click away. Choice is remembered across reloads.

### Finding stuff

- Full-text search across every message that's been loaded.
- Type `@boz` to see only that person's messages.
- Slash commands (the leading `/` is optional, the `:` is what makes them unambiguous):
  - `/from:<name>` show one person's messages
  - `/me` your own messages
  - `/has:link` messages containing a URL
  - `/has:image` messages with an image attachment
  - `/has:reaction` messages with at least one reaction
  - `/since:3` everything from the last 3 days
  - `/help` the full reference
- 💬 thread badge on any message that has replies (quote-replies count too). Click it to focus the stream on just that conversation.

### Following specific people

- 🔔 bell next to each name in the Active rail. Toggle it on and you'll get a desktop notification when that person posts, even if BetterSSC is in another tab.
- 📌 pin people to the top of the Active rail so you always see them first.
- Sort the rail by most-active (default) or alphabetically.
- The browser tab title shows an unread count while you're away: `(3) Za's Market Terminal · BetterSSC`.
- Auto mark-viewed every 30 seconds, so your unread count in native Substack stays in sync.

### Getting around

| Key | What it does |
|---|---|
| `j` / `k` | Next or previous message |
| `PageUp` / `PageDown` | Full page up or down |
| `Ctrl+U` / `Ctrl+D` | Half page up or down (vim style) |
| `g` / `Shift+G` | Jump to top or bottom |
| `n` / `Shift+N` | Cycle through search hits |
| `r` | Refresh now (also a ⟳ button in the header) |
| `/` | Focus the search box |
| `Esc` | Clear search, close the thread view, close any overlay |
| `?` | Show the help overlay |

### Live updates

Polling once every 12 seconds, which is the same thing Substack's own native client does. The status pill in the header shows you what's live: 🟢 live poll or 🟢 ws on. WebSocket support is on the roadmap, polling handles things in the meantime.

## How it works under the hood

It's a Chrome MV3 extension that opens one page (`app.html`) when you click the toolbar icon. That page makes authenticated REST calls to Substack by piggy-backing on your open Substack tab via `chrome.scripting.executeScript`. The requests run inside Substack's own origin so your session cookie comes along for the ride. There is no backend server.

```
You click the toolbar icon
    ↓
background.js looks at your active Substack chat tab's URL
    ↓
Opens app.html?pub=<pubId>&post=<postUuid> in a new tab
    ↓
app.js gets to work:
    - Reads your identity from window._analyticsConfig
    - Pulls initial messages from /api/v1/community/posts/<postUuid>/comments
    - Polls every 12s with ?after=<ISO> for new messages
    - declarativeNetRequest rewrites the Referer header on image requests
       so Substack's S3 bucket serves them properly
```

Nothing leaves your browser except calls to `substack.com`. No analytics, no tracking, no third-party scripts. Your preferences (theme, pinned users, watched users, sort order) live in `chrome.storage.local`.

## Install

1. Clone this repo, or download it as a zip.
2. Open `chrome://extensions` in Chrome, Brave, Arc, or Edge.
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked** and pick this folder.
5. Open a Substack chat in another tab, something like `substack.com/chat/<pubId>/post/<uuid>`.
6. Click the BetterSSC icon in your toolbar.

Chrome will ask you to approve the permissions the first time. They're all scoped to Substack.

One thing to know: **keep at least one `substack.com` tab open** while you're using BetterSSC. That tab is the authentication proxy your REST calls go through. Close it and BetterSSC will tell you it can't reach Substack until you open one again.

## Feedback and bug reports

**[👉 Open an issue](https://github.com/inder/betterssc/issues/new/choose)**

Bugs, feature requests, "this is weird on my chat," questions, all welcome.

If you're filing a bug, these things help me fix it faster:

- Chrome version and OS
- What you did to make it happen
- Whatever red text is in the DevTools console (open with Cmd-Opt-I on Mac, F12 on Windows)
- A screenshot if it's a visual bug

The roadmap below is my current wish list. What you actually need will reshape it.

## Roadmap

- **v0.2** Send messages, add reactions, reply, @mention autocomplete with optimistic UI.
- **v0.3** Multi-chat support. Left rail across every chat you're in, unread badges, Cmd-K quick switcher.
- **v0.4** Direct messages, image upload, edit and delete your own messages.
- **WebSocket protocol** Right now the WS handshake returns "Invalid message" after auth and we fall back to polling. Cracking that protocol needs a side-by-side capture of a working native session vs ours. v0.2-ish.

## Privacy

- No phone-home, no analytics, no third-party scripts of any kind.
- Every API call goes directly to `substack.com` from your browser, using your existing session.
- Settings (theme, pinned users, watched users, sort preference) live in `chrome.storage.local`.
- Failed-image URLs are cached in memory only for the lifetime of the tab.

## Tech notes

No framework. Just vanilla JS modules and plain HTML/CSS. About 3000 lines across `app.js`, `app.css`, `app.html`, `lib/*.js`, and the manifest. No build step. What you see in the source is what runs.

Why no framework: this is a tool I use daily, and hopefully now you will too. Vanilla makes it easier to read, easier to debug, and easier to keep up with Substack's evolving API without dependency-update churn. Lift the hood and the engine is sitting right there.

The protocol was reverse-engineered through five rounds of probing (see commit history before v0.1.0). A few notable detours that became ship-blocker fixes:

- v0.1.2: cross-origin cookies don't attach from `chrome-extension://`, so REST calls now route through the Substack tab via `scripting.executeScript`.
- v0.1.5: REST replies come back wrapped as `{comment, user}` rather than flat. New `unwrapComment` normalizes both shapes.
- v0.1.8: author info lives as a sibling of `comment`, not nested inside it. Attached `raw.user` as `c.author` during unwrap.
- v0.1.20: threaded replies live nested under their parents in the response. Added a recursive `flattenReplies` walker.
- v0.1.24: quote-reply counts aren't in `reply_count`. Built a client-side thread index that counts both styles.

## License

MIT. See [LICENSE](LICENSE).

---

Built by [Inder Sabharwal](https://github.com/inder). Not affiliated with Substack.
