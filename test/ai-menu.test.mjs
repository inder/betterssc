// Structural smoke test for the *AI header dropdown.
//
// The actual hover-reveal + click-routing logic lives in app.js's
// wireAiMenu(), which isn't exported (app.js is the extension entry
// point, not a module). So we assert the HTML scaffolding the wiring
// depends on: the wrapper, button aria, and the two action items with
// the data-attributes the router dispatches on. If a future cleanup
// renames data-ai-action="summary"/"ask" or drops a menu item without
// updating wireAiMenu in tandem, this test breaks loudly.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_HTML_PATH = path.join(__dirname, "..", "app.html");

let doc;

beforeAll(() => {
  // Strip <link rel="stylesheet"> + <script src="…"> before parsing so
  // happy-dom doesn't try to fetch them and fail with an unhandled
  // rejection. We only care about the structural markup here.
  const raw = readFileSync(APP_HTML_PATH, "utf8");
  const html = raw
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "");
  const parser = new globalThis.DOMParser();
  doc = parser.parseFromString(html, "text/html");
});

describe("*AI button dropdown markup", () => {
  it("wraps the button in an .ai-menu container", () => {
    const menu = doc.getElementById("aiMenu");
    expect(menu).not.toBeNull();
    expect(menu.classList.contains("ai-menu")).toBe(true);
  });

  it("preserves the legacy #aiInsightsBtn id inside the wrapper", () => {
    const btn = doc.getElementById("aiInsightsBtn");
    expect(btn).not.toBeNull();
    expect(btn.closest(".ai-menu")).not.toBeNull();
  });

  it("button advertises haspopup + initial collapsed state for a11y", () => {
    const btn = doc.getElementById("aiInsightsBtn");
    expect(btn.getAttribute("aria-haspopup")).toBe("true");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders an .ai-menu-pop with role=menu", () => {
    const pop = doc.querySelector(".ai-menu-pop");
    expect(pop).not.toBeNull();
    expect(pop.getAttribute("role")).toBe("menu");
  });

  it("offers exactly two action items: summary + ask", () => {
    const items = doc.querySelectorAll(".ai-menu-item");
    expect(items).toHaveLength(2);
    const actions = Array.from(items).map((el) =>
      el.getAttribute("data-ai-action")
    );
    expect(actions).toEqual(["summary", "ask"]);
  });

  it("each item has role=menuitem (keyboard nav contract)", () => {
    const items = doc.querySelectorAll(".ai-menu-item");
    for (const item of items) {
      expect(item.getAttribute("role")).toBe("menuitem");
    }
  });

  it("each item carries a visible title + sub label (not just an icon)", () => {
    const items = doc.querySelectorAll(".ai-menu-item");
    for (const item of items) {
      const title = item.querySelector(".ai-menu-title");
      const sub = item.querySelector(".ai-menu-sub");
      expect(title).not.toBeNull();
      expect(sub).not.toBeNull();
      expect(title.textContent.trim().length).toBeGreaterThan(0);
      expect(sub.textContent.trim().length).toBeGreaterThan(0);
    }
  });
});
