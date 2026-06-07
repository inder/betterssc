// BetterSSC Network Hook — runs in the PAGE'S MAIN JS world at document_start.
// Patches fetch / XMLHttpRequest / WebSocket so we can see every network call
// Substack makes. The buffer is stored on `window.__bsscNet` and surfaced to
// the ISOLATED-world content script via a CustomEvent bridge.
//
// The content script asks for the latest snapshot by:
//   document.dispatchEvent(new CustomEvent('bssc-get-net'))
// and listens on `bssc-net`, where detail is a JSON STRING (strings cross the
// isolated/main world boundary cleanly; arbitrary objects do not).

(() => {
  if (window.__bsscNetInstalled) return;
  window.__bsscNetInstalled = true;

  const MAX_PER_BUCKET = 2000;
  const buf = {
    startedAtISO: new Date().toISOString(),
    fetches: [],
    xhrs: [],
    wsConns: [],
    wsMessages: [],
  };
  window.__bsscNet = buf;

  const truncate = (s, n) => (s == null ? null : String(s).slice(0, n));
  const push = (bucket, entry) => {
    if (bucket.length < MAX_PER_BUCKET) bucket.push(entry);
  };

  // ---------- fetch ----------
  try {
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url =
        typeof input === "string"
          ? input
          : (input && (input.url || input.toString())) || "";
      const method =
        (init && init.method) || (input && input.method) || "GET";
      const start = performance.now();
      const reqBody =
        init && init.body && typeof init.body === "string"
          ? truncate(init.body, 400)
          : null;
      try {
        const res = await origFetch(input, init);
        const ms = Math.round(performance.now() - start);
        let preview = null;
        try {
          const clone = res.clone();
          const text = await clone.text();
          preview = truncate(text, 800);
        } catch (_) {}
        push(buf.fetches, {
          url,
          method,
          status: res.status,
          ms,
          reqBody,
          preview,
          atISO: new Date().toISOString(),
        });
        return res;
      } catch (e) {
        push(buf.fetches, {
          url,
          method,
          error: String(e && e.message ? e.message : e),
          atISO: new Date().toISOString(),
        });
        throw e;
      }
    };
  } catch (e) {
    console.warn("[BetterSSC] fetch hook failed:", e);
  }

  // ---------- XMLHttpRequest ----------
  try {
    const OrigXHR = window.XMLHttpRequest;
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__bsscMeta = {
        method,
        url,
        atISO: new Date().toISOString(),
      };
      return origOpen.apply(this, arguments);
    };
    OrigXHR.prototype.send = function (body) {
      const meta = this.__bsscMeta || {};
      const start = performance.now();
      const reqBody = typeof body === "string" ? truncate(body, 400) : null;
      this.addEventListener("loadend", () => {
        let preview = null;
        try {
          preview = truncate(this.responseText, 800);
        } catch (_) {}
        push(buf.xhrs, {
          url: meta.url,
          method: meta.method,
          status: this.status,
          ms: Math.round(performance.now() - start),
          reqBody,
          preview,
          atISO: meta.atISO,
        });
      });
      return origSend.apply(this, arguments);
    };
  } catch (e) {
    console.warn("[BetterSSC] XHR hook failed:", e);
  }

  // ---------- WebSocket ----------
  try {
    const OrigWS = window.WebSocket;
    const WrappedWS = function (url, protocols) {
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      const meta = {
        url: String(url),
        protocols: protocols || null,
        atISO: new Date().toISOString(),
        opened: false,
        closed: false,
        closeCode: null,
        messagesIn: 0,
        messagesOut: 0,
      };
      push(buf.wsConns, meta);
      ws.addEventListener("open", () => {
        meta.opened = true;
      });
      ws.addEventListener("close", (e) => {
        meta.closed = true;
        meta.closeCode = e.code;
      });
      ws.addEventListener("message", (e) => {
        meta.messagesIn++;
        let data = null;
        try {
          data = truncate(
            typeof e.data === "string" ? e.data : "[binary]",
            500
          );
        } catch (_) {}
        push(buf.wsMessages, {
          dir: "in",
          url: meta.url,
          data,
          atISO: new Date().toISOString(),
        });
      });
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        meta.messagesOut++;
        push(buf.wsMessages, {
          dir: "out",
          url: meta.url,
          data: truncate(typeof data === "string" ? data : "[binary]", 500),
          atISO: new Date().toISOString(),
        });
        return origSend(data);
      };
      return ws;
    };
    // Preserve constants + prototype so libraries that read them still work.
    WrappedWS.CONNECTING = OrigWS.CONNECTING;
    WrappedWS.OPEN = OrigWS.OPEN;
    WrappedWS.CLOSING = OrigWS.CLOSING;
    WrappedWS.CLOSED = OrigWS.CLOSED;
    WrappedWS.prototype = OrigWS.prototype;
    window.WebSocket = WrappedWS;
  } catch (e) {
    console.warn("[BetterSSC] WebSocket hook failed:", e);
  }

  // ---------- inlined page state ----------
  const pageGlobals = () => {
    // v0.0.4: Substack actually uses _preloads + _analyticsConfig (assigned
    // via window._foo = JSON.parse("...") at page load).
    const keys = [
      "__INITIAL_STATE__",
      "__PRELOADED_STATE__",
      "_state",
      "_preloads",
      "_analyticsConfig",
      "__REDUX_STATE__",
      "__APOLLO_STATE__",
      "__NEXT_DATA__",
      "__SUBSTACK__",
      "__SUBSTACK_BOOT_DATA__",
      "_substackChat",
      "_subscribe",
      "_substack",
    ];
    const out = {};
    for (const k of keys) {
      try {
        const v = window[k];
        if (v === undefined) continue;
        const t = typeof v;
        if (t === "string") {
          out[k] = { type: "string", length: v.length, preview: v.slice(0, 300) };
        } else if (t === "object" && v !== null) {
          let topKeys = [];
          try {
            topKeys = Object.keys(v).slice(0, 50);
          } catch (_) {}
          out[k] = { type: "object", topLevelKeys: topKeys };
        } else {
          out[k] = { type: t, value: String(v).slice(0, 200) };
        }
      } catch (_) {}
    }
    // Also list any script tags whose textContent looks like JSON state.
    const scriptTags = Array.from(document.querySelectorAll("script"))
      .filter((s) => !s.src && s.textContent && s.textContent.length > 200)
      .slice(0, 8)
      .map((s) => {
        const t = s.textContent || "";
        return {
          id: s.id || null,
          type: s.type || null,
          length: t.length,
          looksLikeJson:
            /^\s*[\{\[]/.test(t.trim()) ||
            t.includes("window.") ||
            t.includes("__STATE__"),
          preview: t.slice(0, 240),
        };
      });
    return { globals: out, inlineScripts: scriptTags };
  };

  // ---------- bridge ----------
  document.addEventListener("bssc-get-net", () => {
    let pg = { globals: {}, inlineScripts: [] };
    try {
      pg = pageGlobals();
    } catch (e) {
      pg.error = String(e);
    }
    const payload = {
      startedAtISO: buf.startedAtISO,
      capturedAtISO: new Date().toISOString(),
      counts: {
        fetches: buf.fetches.length,
        xhrs: buf.xhrs.length,
        wsConns: buf.wsConns.length,
        wsMessages: buf.wsMessages.length,
      },
      fetches: buf.fetches,
      xhrs: buf.xhrs,
      wsConns: buf.wsConns,
      wsMessages: buf.wsMessages,
      pageGlobals: pg,
    };
    document.dispatchEvent(
      new CustomEvent("bssc-net", { detail: JSON.stringify(payload) })
    );
  });

  // v0.0.4: ISOLATED world asks for a single page global by name (e.g.
  // "_analyticsConfig"); we serialize and return up to 8KB.
  document.addEventListener("bssc-get-global", (ev) => {
    const name = (ev && ev.detail) || "";
    const out = { key: name, type: null, value: null, error: null };
    try {
      const v = window[name];
      out.type = typeof v;
      if (v === undefined) {
        out.error = "undefined";
      } else if (v === null) {
        out.value = null;
      } else if (typeof v === "string") {
        out.value = v.slice(0, 8000);
      } else {
        try {
          out.value = JSON.stringify(v).slice(0, 8000);
        } catch (e) {
          out.error = "stringify-failed: " + String(e);
        }
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    document.dispatchEvent(
      new CustomEvent("bssc-global-value", { detail: JSON.stringify(out) })
    );
  });

  console.log("[BetterSSC v0.0.4] Network hook installed (MAIN world).");
})();
