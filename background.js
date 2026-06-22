// BetterSSC background service worker (MV3, module).
// Responsibilities:
//   1. Handle toolbar action clicks → open app.html in a new tab, passing
//      the current Substack chat URL parameters when available.
//   2. Relay notification triggers from app.js to chrome.notifications.
//   3. Maintain unread-mention badge on the toolbar icon.

import { CRYPTO_TICKERS } from "./lib/tickers.js";

const APP_PAGE = "app.html";

// ---- Stock/crypto price lookups (for the rolling ticker bar) ----
//
// Fetched HERE in the service worker, not in the app page: a background
// fetch to a host listed in `host_permissions` is NOT subject to page-CORS,
// so we can read Yahoo's JSON. The v8 chart endpoint is crumb/cookie-free
// (unlike the v7 /quote endpoint). "Recent enough" price is the goal — we
// read meta.regularMarketPrice + chartPreviousClose for the % change.
//
// Crypto symbols map to the "<SYM>-USD" Yahoo pair (BTC → BTC-USD).
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

const yahooSymbol = (symbol) =>
  CRYPTO_TICKERS.has(symbol) ? `${symbol}-USD` : symbol;

async function fetchOnePrice(symbol) {
  const url =
    YAHOO_CHART +
    encodeURIComponent(yahooSymbol(symbol)) +
    "?range=1d&interval=1d";
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const meta =
    data &&
    data.chart &&
    Array.isArray(data.chart.result) &&
    data.chart.result[0] &&
    data.chart.result[0].meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") {
    throw new Error("no price in response");
  }
  const price = meta.regularMarketPrice;
  const prev =
    typeof meta.chartPreviousClose === "number"
      ? meta.chartPreviousClose
      : typeof meta.previousClose === "number"
        ? meta.previousClose
        : null;
  // Guard prev === 0 (new/odd listings) so we never divide by zero — keep
  // this consistent with the `change` guard above.
  const change = prev != null ? price - prev : null;
  const changePct = prev != null && prev !== 0 ? (change / prev) * 100 : null;
  return {
    symbol,
    price,
    change,
    changePct,
    currency: meta.currency || "USD",
    asOf: Date.now(),
  };
}

// Resolve a batch of symbols, each independently (one failure doesn't sink
// the batch). Returns { prices: { SYM: {...} | {error} } }.
async function fetchPrices(symbols) {
  const out = {};
  const uniq = [...new Set((symbols || []).map((s) => String(s).toUpperCase()))];
  await Promise.all(
    uniq.map(async (sym) => {
      try {
        out[sym] = await fetchOnePrice(sym);
      } catch (e) {
        out[sym] = { symbol: sym, error: (e && e.message) || "fetch failed" };
      }
    })
  );
  return out;
}

const parseSubstackChatUrl = (url) => {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)substack\.com$/.test(u.hostname)) return null;
    // /chat/<pubId>/post/<postUuid>?... or /chat/<pubId>?...
    const m = u.pathname.match(/^\/chat\/(\d+)(?:\/post\/([a-f0-9-]+))?/);
    if (!m) return null;
    return {
      publicationId: m[1],
      postUuid: m[2] || null,
      targetReplyId: u.searchParams.get("targetReplyId"),
    };
  } catch (_) {
    return null;
  }
};

const buildAppUrl = (params) => {
  const base = chrome.runtime.getURL(APP_PAGE);
  if (!params) return base;
  const qs = new URLSearchParams();
  if (params.publicationId) qs.set("pub", params.publicationId);
  if (params.postUuid) qs.set("post", params.postUuid);
  if (params.targetReplyId) qs.set("reply", params.targetReplyId);
  const qsStr = qs.toString();
  return qsStr ? `${base}?${qsStr}` : base;
};

const findExistingAppTab = async () => {
  const base = chrome.runtime.getURL(APP_PAGE);
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && t.url.startsWith(base)) || null;
};

chrome.action.onClicked.addListener(async (clickedTab) => {
  let chatParams = parseSubstackChatUrl(clickedTab && clickedTab.url);

  // If the clicked tab isn't a chat tab, look across all windows for a
  // substack chat tab and use that one.
  if (!chatParams) {
    const allTabs = await chrome.tabs.query({
      url: ["https://substack.com/chat/*", "https://*.substack.com/chat/*"],
    });
    for (const t of allTabs) {
      const parsed = parseSubstackChatUrl(t.url);
      if (parsed && parsed.postUuid) {
        chatParams = parsed;
        break;
      }
    }
  }

  const targetUrl = buildAppUrl(chatParams);

  // If app is already open, focus it. Otherwise open a new tab.
  const existing = await findExistingAppTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url: targetUrl });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: targetUrl });
  }
});

// ---- Notifications ----
//
// app.js posts {type: "notify", title, message, mentionRef} when an @mention
// arrives. We forward to chrome.notifications and remember the mentionRef so
// onClicked can scroll to it in the app.

const NOTIFICATION_REFS = new Map(); // notificationId → {appTabId, mentionRef}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Reject messages from anything that isn't part of this extension. Content
  // scripts, the app page, and the background script itself all share
  // chrome.runtime.id. Defense in depth — external_connectable isn't enabled
  // in the manifest but pinning this anyway avoids hostile-page spam.
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || !msg.type) return;
  if (msg.type === "notify") {
    // If the sender passes a stable notificationId, reuse it — Chrome
    // will REPLACE the existing notification of that id instead of
    // stacking.
    const id =
      msg.notificationId ||
      `bssc-${Date.now()}-${Math.floor(performance.now() * 1000) % 1000000}`;
    console.log("[BetterSSC SW] notify request", {
      id,
      title: msg.title,
      message: (msg.message || "").slice(0, 80),
    });
    // First check the OS-level permission. If macOS or Chrome are blocking
    // notifications, getPermissionLevel returns "denied" and create() will
    // silently no-op. Log it so the user can see WHY no notification appears.
    chrome.notifications.getPermissionLevel((level) => {
      console.log("[BetterSSC SW] permission level:", level);
      if (level !== "granted") {
        console.warn(
          "[BetterSSC SW] notification BLOCKED by OS or Chrome — " +
            "check macOS System Settings → Notifications → Google Chrome, " +
            "and chrome://settings/content/notifications"
        );
      }
    });
    chrome.notifications.create(
      id,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon128.png"),
        title: msg.title || "BetterSSC",
        message: msg.message || "",
        priority: 2,
      },
      (createdId) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[BetterSSC SW] notifications.create error:",
            chrome.runtime.lastError.message
          );
        } else {
          console.log("[BetterSSC SW] notification CREATED:", createdId);
        }
      }
    );
    NOTIFICATION_REFS.set(id, {
      appTabId: sender && sender.tab && sender.tab.id,
      mentionRef: msg.mentionRef || null,
    });
    sendResponse({ ok: true, notificationId: id });
    return true;
  }
  if (msg.type === "setBadge") {
    const text = msg.count > 0 ? String(msg.count) : "";
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: "#f23f42" });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "fetchPrices") {
    fetchPrices(msg.symbols)
      .then((prices) => sendResponse({ ok: true, prices }))
      .catch((e) =>
        sendResponse({ ok: false, error: (e && e.message) || "failed" })
      );
    return true; // keep the message channel open for the async response
  }
});

// Drop the ref when the notification auto-dismisses or is swiped away
// without being clicked. Without this NOTIFICATION_REFS leaked entries
// for every alert that wasn't acted on.
chrome.notifications.onClosed.addListener((id) => {
  NOTIFICATION_REFS.delete(id);
});

chrome.notifications.onClicked.addListener(async (id) => {
  const ref = NOTIFICATION_REFS.get(id);
  if (!ref) return;
  if (ref.appTabId) {
    try {
      await chrome.tabs.update(ref.appTabId, { active: true });
      if (ref.mentionRef) {
        await chrome.tabs.sendMessage(ref.appTabId, {
          type: "focusMessage",
          messageId: ref.mentionRef,
        });
      }
    } catch (_) {}
  }
  chrome.notifications.clear(id);
  NOTIFICATION_REFS.delete(id);
});
