const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const probeBtn = document.getElementById("probeBtn");
const copyBtn = document.getElementById("copyBtn");
const summaryEl = document.getElementById("summary");

const setStatus = (msg, isErr = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", isErr);
};

const summarizeReport = (r) => {
  if (!r) return "no report";
  const bubbleCount = (r.bubbleExtraction && r.bubbleExtraction.totalBubbles) || 0;
  const topScroller = r.scrollContainers && r.scrollContainers[0];
  const threadCount = (r.threadList && r.threadList.totalChatAnchors) || 0;
  const id = r.identity || {};
  const apiSmoke = Array.isArray(r.apiSmoke) ? r.apiSmoke : [];
  const ok = apiSmoke.filter((c) => c.status >= 200 && c.status < 300).length;
  const fail = apiSmoke.filter(
    (c) => !c.status || c.status >= 400 || c.error
  ).length;
  const ws = r.wsSmoke || {};
  const wsMsgs = (ws.events || []).filter((e) => e.kind === "ws-msg-in").length;
  const net = r.network || {};
  const netCounts = net.counts || {
    fetches: 0,
    xhrs: 0,
    wsConns: 0,
    wsMessages: 0,
  };
  return (
    `user=${id.userId || "?"} · bubbles=${bubbleCount} · ` +
    `topScroll=${topScroller ? topScroller.bubblesContained : 0} · ` +
    `chatAnchors=${threadCount} · ` +
    `apiSmoke=${ok}OK/${fail}FAIL · ` +
    `wsSmoke=${ws.ok ? "OK" : (ws.error ? `ERR:${ws.error}` : "skip")},${wsMsgs}msgsIn · ` +
    `net=${netCounts.fetches}F/${netCounts.xhrs}X/${netCounts.wsConns}WS/${netCounts.wsMessages}m`
  );
};

probeBtn.addEventListener("click", async () => {
  setStatus("Probing all frames…");
  outputEl.textContent = "";
  summaryEl.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || !tab.id) {
      setStatus("No active tab.", true);
      return;
    }
    if (!/^https:\/\/(.*\.)?substack\.com\//.test(tab.url || "")) {
      setStatus(`Not a Substack URL: ${tab.url}`, true);
      return;
    }

    // Probe is async — executeScript supports async functions natively.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: async () => {
        if (typeof window.__betterssc_probe !== "function") {
          return {
            ok: false,
            error: "Probe not loaded in this frame",
            frameUrl: location.href,
          };
        }
        try {
          return { ok: true, report: await window.__betterssc_probe() };
        } catch (e) {
          return {
            ok: false,
            error: String((e && e.stack) || e),
            frameUrl: location.href,
          };
        }
      },
    });

    const frameReports = results.map((r) => ({
      frameId: r.frameId,
      documentId: r.documentId,
      ...(r.result || { ok: false, error: "no result" }),
    }));

    const okReports = frameReports.filter((r) => r.ok && r.report);
    // Top frame is what we want — score by bubble count.
    okReports.sort((a, b) => {
      const ab = (a.report.bubbleExtraction && a.report.bubbleExtraction.totalBubbles) || 0;
      const bb = (b.report.bubbleExtraction && b.report.bubbleExtraction.totalBubbles) || 0;
      return bb - ab;
    });

    const aggregate = {
      tabUrl: tab.url,
      frameCount: frameReports.length,
      framesOkCount: okReports.length,
      frameSummaries: frameReports.map((r) => ({
        frameId: r.frameId,
        ok: r.ok,
        url: r.ok ? r.report.frameUrl : r.frameUrl || null,
        bubbles:
          r.ok && r.report.bubbleExtraction
            ? r.report.bubbleExtraction.totalBubbles
            : null,
        error: r.error || null,
      })),
      bestFrame: okReports[0] || null,
    };

    outputEl.textContent = JSON.stringify(aggregate, null, 2);
    if (aggregate.bestFrame && aggregate.bestFrame.report) {
      summaryEl.textContent = summarizeReport(aggregate.bestFrame.report);
    }
    setStatus(`OK · ${aggregate.framesOkCount}/${aggregate.frameCount} frames`);
  } catch (e) {
    setStatus(
      `Error: ${e && e.message ? e.message : String(e)}. After reloading the extension you must also refresh the Substack tab.`,
      true
    );
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(outputEl.textContent || "");
    setStatus("Copied to clipboard.");
  } catch (e) {
    setStatus(`Copy failed: ${e.message}`, true);
  }
});
