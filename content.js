// BetterSSC DOM Probe — content script v0.0.3
//
// Goal: full scope-mapping pass before we build anything.
// What we now know from v0.0.1 / v0.0.2:
//   - Single top frame, no iframe, no shadow DOM, not Next.js.
//   - Substack uses CSS Modules: stable prefix + 6-char hash suffix.
//   - Message bubble is [class*="bubble-"]. Row is [class*="reactionsHoverZone-"].
//   - Composer is [class*="composer-"] form with .tiptap.ProseMirror inside.
//   - isFirst-/incoming-/outgoing-/reactions-N- encode message state in classes.
//
// What this probe answers:
//   A. Bubble-anchored extraction — sender, timestamp, avatar, reply ctx, attachments.
//   B. Scroll container — content-driven, not composer-walking.
//   C. Thread/channel list — anchor-list scan.
//   D. Top-bar / header.
//   E. Member roster / presence.
//   F. Data attribute inventory.
//   G. CSS variable inventory.
//   H. Network dump via the MAIN-world hook (bssc-get-net / bssc-net).
//   I. Inlined page state (window.__INITIAL_STATE__ etc, via the bridge).

(() => {
  const PROBE_VERSION = "0.0.4";

  // ---------- generic helpers ----------

  const classListArr = (el) => Array.from((el && el.classList) || []);
  const hasClassPrefix = (el, prefix) =>
    classListArr(el).some((c) => c.startsWith(prefix));
  const trimText = (s, n) => ((s || "").trim().slice(0, n));

  // ---------- A. Bubble-anchored extraction ----------

  const findRowFromBubble = (bubble) => {
    let cur = bubble;
    while (cur && cur !== document.body) {
      if (
        hasClassPrefix(cur, "reactionsHoverZone-") ||
        hasClassPrefix(cur, "actionsWrapper-")
      ) {
        // Walk up while consecutive ancestors also have reactionsHoverZone-
        // (there are two nested zones). Stop at the OUTER one.
        let outer = cur;
        while (
          outer.parentElement &&
          hasClassPrefix(outer.parentElement, "reactionsHoverZone-")
        ) {
          outer = outer.parentElement;
        }
        return outer;
      }
      cur = cur.parentElement;
    }
    return bubble.parentElement;
  };

  const harvestRow = (row) => {
    if (!row) return null;
    const anchors = Array.from(row.querySelectorAll("a[href]"))
      .slice(0, 8)
      .map((a) => ({
        href: a.getAttribute("href"),
        text: trimText(a.textContent, 80),
        rel: a.getAttribute("rel"),
      }));
    const images = Array.from(row.querySelectorAll("img"))
      .slice(0, 5)
      .map((img) => ({
        src: img.src || img.getAttribute("src"),
        alt: img.alt,
        widthHeight: `${img.naturalWidth || img.width}x${img.naturalHeight || img.height}`,
      }));
    const times = Array.from(
      row.querySelectorAll("time[datetime], [datetime]")
    )
      .slice(0, 5)
      .map((t) => ({
        tagName: t.tagName,
        datetime: t.getAttribute("datetime"),
        text: trimText(t.textContent, 60),
      }));
    const titles = Array.from(row.querySelectorAll("[title]"))
      .filter((e) => {
        const t = e.getAttribute("title") || "";
        return /\d{1,2}:\d{2}|am|pm|\d{4}/i.test(t);
      })
      .slice(0, 5)
      .map((e) => ({
        title: e.getAttribute("title"),
        text: trimText(e.textContent, 40),
      }));
    const dataAttrs = {};
    if (row.attributes) {
      for (const a of row.attributes) {
        if (a.name.startsWith("data-")) dataAttrs[a.name] = a.value;
      }
    }
    return { anchors, images, times, titles, dataAttrs };
  };

  const harvestBubble = (bubble) => {
    const classes = classListArr(bubble);
    const stateClasses = {
      isFirst: classes.find((c) => c.startsWith("isFirst-")) || null,
      isLast: classes.find((c) => c.startsWith("isLast-")) || null,
      incoming: classes.find((c) => c.startsWith("incoming-")) || null,
      outgoing: classes.find((c) => c.startsWith("outgoing-")) || null,
      reactions: classes.find((c) => /^reactions-\d+-/.test(c)) || null,
    };
    const row = findRowFromBubble(bubble);
    const rowHarvest = harvestRow(row);

    // Walk up to find a wrapper that contains a profile anchor or an avatar —
    // that's the sender group container (for grouped messages).
    let groupCtx = null;
    let cur = row && row.parentElement;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      const profileLinks = Array.from(
        cur.querySelectorAll('a[href*="/p/"], a[href*="@"], a[href*="/profile"]')
      );
      const avatars = Array.from(cur.querySelectorAll("img"));
      if (profileLinks.length || avatars.length) {
        groupCtx = {
          ancestorDepthFromRow: i + 1,
          tagName: cur.tagName,
          classList: classListArr(cur).slice(0, 12),
          childCount: cur.childElementCount,
          profileLinks: profileLinks.slice(0, 3).map((a) => ({
            href: a.getAttribute("href"),
            text: trimText(a.textContent, 80),
          })),
          avatars: avatars.slice(0, 3).map((img) => ({
            src: img.src || img.getAttribute("src"),
            alt: img.alt,
          })),
        };
        break;
      }
      cur = cur.parentElement;
    }

    return {
      bubble: {
        text: trimText(bubble.textContent, 300),
        classes: classes.slice(0, 16),
        stateClasses,
        inlineStyle: bubble.getAttribute("style") || null,
        cssVars: extractCssVarsFromStyle(bubble.getAttribute("style") || ""),
      },
      row: row && {
        tagName: row.tagName,
        classes: classListArr(row).slice(0, 12),
        rectHeight: Math.round(row.getBoundingClientRect().height),
        outerHTMLPreview: row.outerHTML.slice(0, 1500),
      },
      rowHarvest,
      groupCtx,
    };
  };

  const extractCssVarsFromStyle = (style) => {
    const out = {};
    if (!style) return out;
    const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);?/g;
    let m;
    while ((m = re.exec(style))) {
      out[m[1]] = m[2].trim().slice(0, 120);
    }
    return out;
  };

  const bubbleExtraction = () => {
    const bubbles = Array.from(document.querySelectorAll('[class*="bubble-"]'));
    const samples = [];
    const stride = Math.max(1, Math.floor(bubbles.length / 5));
    for (let i = 0; i < bubbles.length && samples.length < 5; i += stride) {
      samples.push(harvestBubble(bubbles[i]));
    }
    return {
      totalBubbles: bubbles.length,
      sampleStride: stride,
      samples,
    };
  };

  // ---------- B. Scroll container discovery (content-driven) ----------

  const discoverScrollContainers = () => {
    const candidates = [];
    const all = document.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) {
        const bubbleCount = el.querySelectorAll('[class*="bubble-"]').length;
        candidates.push({
          tagName: el.tagName,
          classes: classListArr(el).slice(0, 10),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          bubblesContained: bubbleCount,
          rectTop: Math.round(el.getBoundingClientRect().top),
          rectHeight: Math.round(el.getBoundingClientRect().height),
        });
      }
    }
    candidates.sort((a, b) => b.bubblesContained - a.bubblesContained);
    return candidates.slice(0, 10);
  };

  // ---------- C. Thread/channel list discovery ----------

  const discoverThreadList = () => {
    // Pattern: a region containing multiple anchor links to other chat URLs.
    const allAnchors = Array.from(document.querySelectorAll("a[href]"));
    const chatAnchors = allAnchors.filter((a) => {
      const h = a.getAttribute("href") || "";
      return /\/chat(\/|\?|$)/.test(h);
    });

    // Group anchors by nearest common ancestor at small depths.
    const groups = new Map();
    for (const a of chatAnchors) {
      let p = a.parentElement;
      // Walk up 3 levels — that's usually the list wrapper.
      for (let i = 0; i < 3 && p; i++) p = p.parentElement;
      if (!p) continue;
      const key = p;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }

    const candidates = [];
    for (const [container, anchors] of groups.entries()) {
      if (anchors.length < 2) continue;
      candidates.push({
        containerTag: container.tagName,
        containerClasses: classListArr(container).slice(0, 10),
        anchorCount: anchors.length,
        anchorPreview: anchors.slice(0, 6).map((a) => ({
          href: a.getAttribute("href"),
          text: trimText(a.textContent, 60),
        })),
      });
    }
    candidates.sort((a, b) => b.anchorCount - a.anchorCount);
    return {
      totalChatAnchors: chatAnchors.length,
      candidates: candidates.slice(0, 6),
    };
  };

  // ---------- D. Top-bar / header ----------

  const headerProbe = () => {
    // Look for a likely header: position-fixed/sticky element at the top, or
    // any element containing the document.title fragment.
    const out = [];
    const all = document.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (
        (cs.position === "fixed" || cs.position === "sticky") &&
        el.getBoundingClientRect().top < 80 &&
        el.getBoundingClientRect().height < 200
      ) {
        out.push({
          tagName: el.tagName,
          classes: classListArr(el).slice(0, 10),
          text: trimText(el.textContent, 200),
          rect: {
            top: Math.round(el.getBoundingClientRect().top),
            height: Math.round(el.getBoundingClientRect().height),
            width: Math.round(el.getBoundingClientRect().width),
          },
        });
      }
      if (out.length >= 8) break;
    }
    return out;
  };

  // ---------- E. Member roster / presence ----------

  const memberProbe = () => {
    // Substack chat may show "X people" / a roster button somewhere.
    // We look for lists of small avatars or text matching "members".
    const all = document.querySelectorAll(
      '[class*="member"], [class*="Member"], [class*="participants"], [class*="Participants"], [class*="roster"], [class*="Roster"]'
    );
    return Array.from(all)
      .slice(0, 10)
      .map((el) => ({
        tagName: el.tagName,
        classes: classListArr(el).slice(0, 10),
        text: trimText(el.textContent, 200),
        childCount: el.childElementCount,
      }));
  };

  // ---------- F. Data attribute inventory ----------

  const dataAttrInventory = () => {
    const tally = new Map();
    const examples = new Map();
    const all = document.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el.attributes) continue;
      for (const a of el.attributes) {
        if (a.name.startsWith("data-")) {
          tally.set(a.name, (tally.get(a.name) || 0) + 1);
          if (!examples.has(a.name)) {
            examples.set(a.name, trimText(a.value, 80));
          }
        }
      }
    }
    return Array.from(tally.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([name, count]) => ({
        name,
        count,
        example: examples.get(name),
      }));
  };

  // ---------- G. CSS variable inventory ----------

  const cssVarInventory = () => {
    // Root vars
    const rootStyle = document.documentElement.getAttribute("style") || "";
    const computedRoot = getComputedStyle(document.documentElement);
    // We can't enumerate ALL CSS custom props from getComputedStyle, but inline ones we can.
    const rootInline = extractCssVarsFromStyle(rootStyle);
    // Sample <body> too
    const bodyInline = extractCssVarsFromStyle(
      (document.body && document.body.getAttribute("style")) || ""
    );
    // Try a few known prop names from CSS — we can read computed value if we know the name.
    const tryNames = [
      "--color-bg-primary",
      "--color-bg-secondary",
      "--color-text-primary",
      "--color-chat-author-bg-overlay",
      "--color-bg-accent-themed",
      "--color-accent",
      "--font-sans",
      "--font-mono",
      "--border-radius",
    ];
    const computed = {};
    for (const n of tryNames) {
      const v = computedRoot.getPropertyValue(n).trim();
      if (v) computed[n] = v.slice(0, 120);
    }
    return { rootInline, bodyInline, computedKnown: computed };
  };

  // ---------- H. Network bridge ----------

  const getNetworkDump = () =>
    new Promise((resolve) => {
      let done = false;
      const handler = (e) => {
        if (done) return;
        done = true;
        document.removeEventListener("bssc-net", handler);
        try {
          resolve(JSON.parse(e.detail));
        } catch (err) {
          resolve({ error: "parse-failed", raw: trimText(e.detail, 400) });
        }
      };
      document.addEventListener("bssc-net", handler);
      document.dispatchEvent(new CustomEvent("bssc-get-net"));
      setTimeout(() => {
        if (done) return;
        done = true;
        document.removeEventListener("bssc-net", handler);
        resolve({
          error: "timeout — main-world hook not responding (was page reloaded after install?)",
        });
      }, 1500);
    });

  // v0.0.4: ask the MAIN-world hook for a single page global by name.
  const getPageGlobal = (name) =>
    new Promise((resolve) => {
      let done = false;
      const handler = (e) => {
        if (done) return;
        try {
          const parsed = JSON.parse(e.detail);
          if (parsed && parsed.key === name) {
            done = true;
            document.removeEventListener("bssc-global-value", handler);
            resolve(parsed);
          }
        } catch (_) {}
      };
      document.addEventListener("bssc-global-value", handler);
      document.dispatchEvent(
        new CustomEvent("bssc-get-global", { detail: name })
      );
      setTimeout(() => {
        if (done) return;
        done = true;
        document.removeEventListener("bssc-global-value", handler);
        resolve({ key: name, error: "timeout" });
      }, 1500);
    });

  // ---------- v0.0.4: identity, API smoke test, WS smoke test ----------

  const getUserIdentity = async () => {
    const ac = await getPageGlobal("_analyticsConfig");
    if (!ac || ac.error || !ac.value) return { error: ac && ac.error };
    try {
      const obj = JSON.parse(ac.value);
      const u = (obj && obj.user) || {};
      return {
        userId: u.id || null,
        name: u.name || null,
        email: u.email || null,
        anonymousId: obj.anonymousId || null,
        propertiesKeys: obj.properties ? Object.keys(obj.properties).slice(0, 20) : [],
      };
    } catch (e) {
      return { error: "parse-failed: " + String(e), raw: trimText(ac.value, 400) };
    }
  };

  const smokeTestOne = async (label, path) => {
    const t0 = performance.now();
    try {
      const res = await fetch(path, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const ms = Math.round(performance.now() - t0);
      const text = await res.text();
      let topLevelKeys = null;
      let arrayLen = null;
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j)) {
          arrayLen = j.length;
          topLevelKeys = j[0] ? Object.keys(j[0]).slice(0, 12) : [];
        } else if (j && typeof j === "object") {
          topLevelKeys = Object.keys(j).slice(0, 20);
        }
      } catch (_) {}
      return {
        label,
        path,
        status: res.status,
        ms,
        bytes: text.length,
        topLevelKeys,
        arrayLen,
        preview: trimText(text, 240),
      };
    } catch (e) {
      return {
        label,
        path,
        error: String((e && e.message) || e),
        ms: Math.round(performance.now() - t0),
      };
    }
  };

  const runApiSmoke = async ({ publicationId, postUuid, userId, userHandle }) => {
    const calls = [];
    if (postUuid) {
      calls.push([
        "comments-initial-asc",
        `/api/v1/community/posts/${postUuid}/comments?order=asc&initial=true`,
      ]);
      calls.push([
        "comments-newest-desc",
        `/api/v1/community/posts/${postUuid}/comments?order=desc`,
      ]);
    }
    calls.push(["inbox-all", "/api/v1/messages/inbox?tab=all"]);
    calls.push(["unread-count", "/api/v1/messages/unread-count"]);
    calls.push(["blocks-ids", "/api/v1/blocks/ids"]);
    calls.push(["activity-unread", "/api/v1/activity/unread"]);
    calls.push(["reactions-library", "/api/v1/threads/reactions"]);
    if (publicationId) {
      calls.push([
        "publication-public",
        `/api/v1/publication/public/${publicationId}`,
      ]);
    }
    if (userId && userHandle) {
      calls.push([
        "user-public-profile",
        `/api/v1/user/${userId}-${userHandle}/public_profile/self`,
      ]);
    }
    if (userId) {
      calls.push([
        "realtime-token-user-only",
        `/api/v1/realtime/token?channels=user%3A${userId}`,
      ]);
      if (publicationId) {
        calls.push([
          "realtime-token-user+chat",
          `/api/v1/realtime/token?channels=user%3A${userId}%2Cchat%3A${publicationId}%3Aall_subscribers`,
        ]);
      }
    }

    const results = [];
    for (const [label, path] of calls) {
      const r = await smokeTestOne(label, path);
      results.push(r);
    }
    return results;
  };

  // Open a fresh WebSocket, authenticate with a realtime JWT, subscribe to the
  // user channel, listen for `listenMs` milliseconds, then close. Reports the
  // full message log so we can see the WS protocol's frame shape.
  const runWsSmoke = async ({ userId, publicationId, listenMs = 3500 }) => {
    if (!userId) return { error: "no userId — cannot get realtime token" };
    const events = [];
    let ws = null;
    const t0 = performance.now();
    const log = (evt) =>
      events.push({
        ms: Math.round(performance.now() - t0),
        ...evt,
      });
    try {
      const channels = publicationId
        ? `user%3A${userId}%2Cchat%3A${publicationId}%3Aall_subscribers`
        : `user%3A${userId}`;
      const tokenRes = await fetch(
        `/api/v1/realtime/token?channels=${channels}`,
        { credentials: "include" }
      );
      if (!tokenRes.ok) {
        return { error: `token fetch failed: ${tokenRes.status}` };
      }
      const tokenJson = await tokenRes.json();
      const endpoint = tokenJson.endpoint || "wss://zyncrealtime.substack.com";
      const token = tokenJson.token;
      const permissions = tokenJson.permissions || [];
      log({ kind: "token-fetched", endpoint, permissions, expiry: tokenJson.expiry });

      ws = new WebSocket(endpoint);
      await new Promise((resolve, reject) => {
        ws.onopen = () => {
          log({ kind: "ws-open" });
          ws.send(JSON.stringify({ token }));
          resolve();
        };
        ws.onerror = (e) => {
          log({ kind: "ws-error", message: String(e && e.message) });
          reject(new Error("ws onerror"));
        };
        setTimeout(() => reject(new Error("ws open timeout")), 3000);
      });

      ws.onmessage = (e) => {
        let data = null;
        try {
          data = typeof e.data === "string" ? e.data.slice(0, 600) : "[binary]";
        } catch (_) {}
        log({ kind: "ws-msg-in", data });
      };
      ws.onclose = (e) => {
        log({ kind: "ws-close", code: e.code, reason: e.reason });
      };

      await new Promise((resolve) => setTimeout(resolve, listenMs));
      try {
        ws.close();
      } catch (_) {}
      return { ok: true, events };
    } catch (e) {
      try {
        if (ws) ws.close();
      } catch (_) {}
      return {
        error: String((e && e.message) || e),
        events,
      };
    }
  };

  // ---------- main probe ----------

  const SELECTOR_HYPOTHESES = {
    bubble: ['[class*="bubble-"]'],
    rowWrapper: ['[class*="reactionsHoverZone-"]'],
    reactionsContainer: ['[class*="reactionsContainer-"]'],
    composer: ['[class*="composer-"]'],
    inputBox: ['[class*="inputBox-"]'],
    contentEditable: ['[contenteditable="true"]'],
  };

  const matchAll = (selectors) => {
    const out = [];
    for (const sel of selectors) {
      try {
        const found = document.querySelectorAll(sel);
        out.push({ selector: sel, count: found.length });
      } catch (_) {}
    }
    return out;
  };

  const probe = async () => {
    const url = location.href;
    const path = location.pathname;
    const m = path.match(/\/chat\/(\d+)(?:\/post\/([a-f0-9-]+))?/);
    const publicationId = m ? m[1] : null;
    const postUuid = m && m[2] ? m[2] : null;

    const isLikelyChatPage =
      /\/chat(\/|$)/.test(path) || /\/inbox(\/|$)/.test(path);
    const isChatListView = isLikelyChatPage && !postUuid;
    const isChatPostView = isLikelyChatPage && !!postUuid;

    const report = {
      probeVersion: PROBE_VERSION,
      capturedAtISO: new Date().toISOString(),
      isTopFrame: window === window.top,
      frameUrl: url,
      framePathname: path,
      pageType: {
        isLikelyChatPage,
        isChatListView,
        isChatPostView,
        publicationId,
        postUuid,
      },
      title: document.title,
      bodyClasses: classListArr(document.body),
      domStats: {
        totalElements: document.getElementsByTagName("*").length,
        articles: document.querySelectorAll("article").length,
        mains: document.querySelectorAll("main").length,
        navs: document.querySelectorAll("nav").length,
        iframes: document.querySelectorAll("iframe").length,
        anchors: document.querySelectorAll("a[href]").length,
        images: document.querySelectorAll("img").length,
      },
      anchorCounts: matchAll(SELECTOR_HYPOTHESES.bubble).concat(
        matchAll(SELECTOR_HYPOTHESES.rowWrapper),
        matchAll(SELECTOR_HYPOTHESES.reactionsContainer),
        matchAll(SELECTOR_HYPOTHESES.composer),
        matchAll(SELECTOR_HYPOTHESES.inputBox),
        matchAll(SELECTOR_HYPOTHESES.contentEditable)
      ),
      bubbleExtraction: bubbleExtraction(),
      scrollContainers: discoverScrollContainers(),
      threadList: discoverThreadList(),
      headerCandidates: headerProbe(),
      memberCandidates: memberProbe(),
      dataAttrs: dataAttrInventory(),
      cssVars: cssVarInventory(),
      identity: null,
      apiSmoke: null,
      wsSmoke: null,
      network: null,
    };

    // v0.0.4: identity (from _analyticsConfig via MAIN bridge)
    try {
      report.identity = await getUserIdentity();
    } catch (e) {
      report.identity = { error: String(e) };
    }

    // Find user handle for endpoints that need it.
    // _analyticsConfig doesn't contain handle directly — fall back to extracting
    // from the inbox response or leave null. Most endpoints only need userId.
    const userId = report.identity && report.identity.userId;

    // Probe the inbox once early to discover handle for the public_profile endpoint.
    let userHandle = null;
    if (userId) {
      try {
        const r = await fetch("/api/v1/messages/inbox?tab=all", {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (r.ok) {
          const j = await r.json();
          // Threads include the user's own publication info with handle.
          // We don't always need this — leave null if not found.
          const threads = (j && j.threads) || [];
          for (const t of threads) {
            if (t && t.user && t.user.id === userId && t.user.handle) {
              userHandle = t.user.handle;
              break;
            }
            if (t && t.publication && t.publication.author_id === userId && t.publication.author_handle) {
              userHandle = t.publication.author_handle;
              break;
            }
          }
        }
      } catch (_) {}
    }

    // API smoke test — calls every known read endpoint.
    if (userId || postUuid || publicationId) {
      try {
        report.apiSmoke = await runApiSmoke({
          publicationId,
          postUuid,
          userId,
          userHandle,
        });
      } catch (e) {
        report.apiSmoke = { error: String(e) };
      }
    }

    // WebSocket smoke test — separate connection so we don't interfere with
    // Substack's own WS. Listens 3.5s and reports message log.
    if (userId) {
      try {
        report.wsSmoke = await runWsSmoke({
          userId,
          publicationId,
          listenMs: 3500,
        });
      } catch (e) {
        report.wsSmoke = { error: String(e) };
      }
    }

    // Finally dump the passive network hook buffer (includes any traffic the
    // user generated during the probe window — sends, reactions, chat switches).
    try {
      report.network = await getNetworkDump();
    } catch (e) {
      report.network = { error: String(e) };
    }

    return report;
  };

  // Sync sendMessage fallback (returns instantly, callers should prefer executeScript).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "BETTERSSC_PROBE") {
      probe()
        .then((report) => sendResponse({ ok: true, report }))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.stack) || e) })
        );
      return true;
    }
  });

  // Expose globally for popup's executeScript and manual console use.
  window.__betterssc_probe = probe;
  console.log(
    `[BetterSSC v${PROBE_VERSION}] DOM probe loaded in frame: ${location.href}`
  );
})();
