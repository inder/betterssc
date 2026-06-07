// Vitest setup. Runs before every test file.
//
// Stubs the chrome.* APIs the extension uses so tests can run in pure
// Node + happy-dom without needing a real Chrome runtime.

import { vi } from "vitest";

const chromeStub = {
  storage: {
    local: {
      _store: new Map(),
      get(keys, cb) {
        const result = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) {
          if (this._store.has(k)) result[k] = this._store.get(k);
        }
        if (cb) cb(result);
        return Promise.resolve(result);
      },
      set(obj, cb) {
        for (const [k, v] of Object.entries(obj)) this._store.set(k, v);
        if (cb) cb();
        return Promise.resolve();
      },
      _reset() {
        this._store.clear();
      },
    },
  },
  runtime: {
    id: "test-extension-id",
    sendMessage: vi.fn((msg, cb) => {
      if (cb) cb({ ok: true });
      return Promise.resolve({ ok: true });
    }),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    getURL: (path) => `chrome-extension://test/${path}`,
  },
  tabs: {
    query: vi.fn(() => Promise.resolve([])),
    sendMessage: vi.fn(() => Promise.resolve({ ok: true })),
    update: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve(null)),
  },
  scripting: {
    executeScript: vi.fn(() => Promise.resolve([{ result: null }])),
  },
  notifications: {
    create: vi.fn(),
    clear: vi.fn(),
    onClicked: { addListener: vi.fn() },
    onClosed: { addListener: vi.fn() },
  },
  action: {
    onClicked: { addListener: vi.fn() },
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
  windows: {
    update: vi.fn(() => Promise.resolve()),
  },
};

globalThis.chrome = chromeStub;

// Reset storage between tests so they're isolated.
import { beforeEach } from "vitest";
beforeEach(() => {
  chromeStub.storage.local._reset();
  Object.values(chromeStub.runtime).forEach(
    (v) => v && typeof v.mockReset === "function" && v.mockReset()
  );
});
