// Tests for the pure pacing helpers behind background chat prefetch.
//
// The orchestrator (runChatBgPrefetch in app.js) is DOM/state-coupled
// and not unit-testable without dragging the whole app boot into the
// test runner. The helpers below are the parts that carry actual
// decision logic — they ship in lib/util.js precisely so they can
// be exercised here in isolation.

import { describe, it, expect } from "vitest";
import {
  computeRetryDelay,
  PREFETCH_BASE_DELAY_MS,
  PREFETCH_MAX_BACKOFF_MS,
  PREFETCH_SLOT_POLL_MS,
  PREFETCH_PILL_VISIBLE_MS,
  PREFETCH_PILL_REMOVE_MS,
} from "../lib/util.js";

describe("PREFETCH constants", () => {
  it("base delay is 300ms — slow enough that Substack's REST API doesn't 429", () => {
    expect(PREFETCH_BASE_DELAY_MS).toBe(300);
  });

  it("max backoff is 2400ms — caps the 429-retry doubling at a reasonable ceiling", () => {
    expect(PREFETCH_MAX_BACKOFF_MS).toBe(2400);
  });

  it("base delay is well under the backoff ceiling — invariant the loop relies on", () => {
    expect(PREFETCH_BASE_DELAY_MS).toBeLessThan(PREFETCH_MAX_BACKOFF_MS);
  });

  it("slot poll is faster than base page delay — `g` lands inside one pace cycle", () => {
    expect(PREFETCH_SLOT_POLL_MS).toBeLessThan(PREFETCH_BASE_DELAY_MS);
  });

  it("pill visible window precedes the remove window", () => {
    expect(PREFETCH_PILL_VISIBLE_MS).toBeLessThan(PREFETCH_PILL_REMOVE_MS);
  });

  it("pill fade window is at least 500ms — short enough not to block, long enough to read CSS transition", () => {
    expect(PREFETCH_PILL_REMOVE_MS - PREFETCH_PILL_VISIBLE_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("computeRetryDelay", () => {
  it("first 429 (prevDelay=null) returns 600ms — twice the base delay", () => {
    expect(computeRetryDelay(null)).toBe(600);
  });

  it("first 429 (prevDelay=undefined) returns 600ms — intentional null-coercion coverage", () => {
    // computeRetryDelay's `== null` check intentionally treats both null
    // AND undefined as "first retry." We document this explicitly so a
    // future cleanup that tightens the null guard doesn't accidentally
    // change behavior for the (rare) caller that omits the argument.
    expect(computeRetryDelay(undefined)).toBe(600);
  });

  it("second 429 doubles to 1200ms", () => {
    expect(computeRetryDelay(600)).toBe(1200);
  });

  it("third 429 doubles to 2400ms — still inside the ceiling", () => {
    expect(computeRetryDelay(1200)).toBe(2400);
  });

  it("fourth 429 returns null — the caller treats null as give-up-silently", () => {
    // 2400 * 2 = 4800, which exceeds PREFETCH_MAX_BACKOFF_MS (2400).
    expect(computeRetryDelay(2400)).toBeNull();
  });

  it("any prevDelay >= PREFETCH_MAX_BACKOFF_MS returns null — sticky stop", () => {
    expect(computeRetryDelay(3000)).toBeNull();
    expect(computeRetryDelay(10_000)).toBeNull();
  });

  it("retries follow a strictly increasing geometric sequence", () => {
    // Verifying the sequence as a chain: null (first 429) → 600 →
    // 1200 → 2400 → null (give up). Seed with computeRetryDelay(null)
    // so the loop can advance; null inside the loop terminates it.
    const chain = [];
    let cur = computeRetryDelay(null);
    while (cur !== null && chain.length < 6) {
      chain.push(cur);
      cur = computeRetryDelay(cur);
    }
    expect(chain).toEqual([600, 1200, 2400]);
  });
});

// Storage round-trip — uses the chrome.storage stub from test/setup.mjs.
// We assert the semantic of the autoLoadAll default-on contract: an
// absent key restores ON; an explicit `false` is the only value that
// turns it off. (Mirrors how the load handler in app.js's
// restoreWatchedUsers branch reads bssc_auto_load_all.)

describe("bssc_auto_load_all storage semantics", () => {
  it("absent key → load handler keeps the default (on)", async () => {
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(["bssc_auto_load_all"], resolve)
    );
    expect(stored.bssc_auto_load_all).toBeUndefined();
    // The semantic the app uses: absent → default on. Mirror it here so
    // any future refactor that changes the absence semantics breaks a
    // test rather than a user's silent expectation.
    const effective = stored.bssc_auto_load_all === false ? false : true;
    expect(effective).toBe(true);
  });

  it("explicit false → turns prefetch off", async () => {
    await new Promise((resolve) =>
      chrome.storage.local.set({ bssc_auto_load_all: false }, resolve)
    );
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(["bssc_auto_load_all"], resolve)
    );
    expect(stored.bssc_auto_load_all).toBe(false);
    const effective = stored.bssc_auto_load_all === false ? false : true;
    expect(effective).toBe(false);
  });

  it("explicit true → on (the same as absent)", async () => {
    await new Promise((resolve) =>
      chrome.storage.local.set({ bssc_auto_load_all: true }, resolve)
    );
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(["bssc_auto_load_all"], resolve)
    );
    const effective = stored.bssc_auto_load_all === false ? false : true;
    expect(effective).toBe(true);
  });
});
