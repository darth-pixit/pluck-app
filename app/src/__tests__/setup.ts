import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Tauri API mocks. The real @tauri-apps/api modules call into the host runtime,
// which doesn't exist under jsdom. We replace them with controllable stubs
// that individual tests can re-program via setInvokeHandler / emit.
// ---------------------------------------------------------------------------

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => unknown | Promise<unknown>;
type EventListener = (event: { payload: unknown }) => void;

let invokeHandler: InvokeHandler = () => undefined;
const eventListeners = new Map<string, Set<EventListener>>();

export function setInvokeHandler(fn: InvokeHandler) {
  invokeHandler = fn;
}

export function emitTauriEvent(name: string, payload: unknown) {
  const set = eventListeners.get(name);
  if (!set) return;
  for (const fn of set) fn({ payload });
}

export function resetTauriMocks() {
  invokeHandler = () => undefined;
  eventListeners.clear();
}

// jsdom doesn't implement scrollIntoView; HistoryPanel calls it whenever the
// active row changes. Stub it so the component doesn't blow up.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) =>
    Promise.resolve(invokeHandler(cmd, args)),
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: EventListener) => {
    if (!eventListeners.has(name)) eventListeners.set(name, new Set());
    eventListeners.get(name)!.add(handler);
    return Promise.resolve(() => {
      eventListeners.get(name)?.delete(handler);
    });
  }),
}));

const focusChangedListeners = new Set<EventListener>();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    onFocusChanged: vi.fn((handler: EventListener) => {
      focusChangedListeners.add(handler);
      return Promise.resolve(() => focusChangedListeners.delete(handler));
    }),
  }),
}));

export function emitFocusChange(focused: boolean) {
  for (const fn of focusChangedListeners) fn({ payload: focused as unknown });
}

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  getCurrentScope: () => ({ setUser: vi.fn(), setTag: vi.fn() }),
  ErrorBoundary: ({ children }: { children: unknown }) => children as React.ReactNode,
}));

beforeEach(() => {
  resetTauriMocks();
  focusChangedListeners.clear();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
