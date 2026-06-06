# BetterSSC — DOM Probe (v0.0.1)

A Manifest V3 Chrome extension that answers one question: **can we read Substack Chat's DOM well enough to build a Discord-style overlay?**

It does not modify the page. It only inspects.

## What it does

When you click the extension's icon on a Substack tab, it runs a content script that:

1. Records URL, path, page title, and whether the path looks like a chat page (`/chat` or `/inbox`).
2. Tries a list of selector hypotheses (`[class*="chat"]`, `[class*="message"]`, `[role="log"]`, etc.) and reports which ones actually match elements.
3. If on a chat page, picks the "messageItem" selector with ≥2 hits and dumps 5 sample messages: outerHTML preview, text content, class list, ARIA label.
4. Reports whether `__NEXT_DATA__` is present (indicates server-rendered JSON we could parse instead of scraping the DOM).

You get a JSON report in the popup. Copy it and paste it back here.

## Install (unpacked dev mode)

1. Open `chrome://extensions` in Chrome (or Brave/Arc/Edge — same UI).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select this directory: `/Users/indersabharwal/signaldeck/betterssc`.
5. The extension card appears with name "BetterSSC DOM Probe".

## Use

1. Open a Substack page — ideally a chat URL like `https://substack.com/chat` or `https://<publication>.substack.com/chat`.
2. If you installed *after* loading the page, **refresh the page** so the content script injects.
3. Click the BetterSSC icon in the toolbar (you may need to pin it via the puzzle-piece menu).
4. Click **Probe this tab**.
5. Inspect the JSON. Click **Copy JSON** to grab the whole report.

You can also run `__betterssc_probe()` directly in DevTools console on any Substack page.

## What the report tells us

| Field | Meaning |
|---|---|
| `isLikelyChatPage` | URL pattern matched `/chat` or `/inbox`. |
| `selectorHits.chatContainer` | Which broad container selectors found anything. |
| `selectorHits.messageItem` | Which selectors find individual messages. The one with the highest count is probably the right one. |
| `selectorHits.composer` | Whether we found the textarea/contenteditable for sending messages. |
| `messageSample.winningSelector` | The selector we'll use for message extraction. |
| `messageSample.samples[*].textContent` | What the actual message text looks like. |
| `nextDataPresent` | If true, Substack inlines a JSON blob — parsing that is more reliable than DOM scraping. |

## Next steps (after the probe confirms feasibility)

- Lock in the winning selectors → build a stable message-extractor module.
- Decide whether to scrape the DOM or fetch from `__NEXT_DATA__` / internal `/api/v1/` endpoints.
- Build the overlay UI (three-pane Discord layout) and inject as a sibling of the current chat view.

## Files

- `manifest.json` — MV3 manifest. Permissions: `activeTab`, `scripting`, `storage`; host: `*.substack.com`.
- `content.js` — injected into every Substack page; listens for probe messages.
- `popup.html` / `popup.js` — toolbar UI with Probe + Copy buttons.
