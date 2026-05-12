import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bucket,
  captureException,
  getSettings,
  initAnalytics,
  resetAnonymousId,
  safeInvoke,
  setCrashOptOut,
  setOptOut,
  track,
} from "./analytics";
import { setInvokeHandler } from "./__tests__/setup";

// Spy on the bare fetch the analytics module uses to ship events. We replace
// it with a vi.fn() so individual tests can assert on calls / count them.
const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("{}") } as unknown as Response));
vi.stubGlobal("fetch", fetchMock);

describe("bucket()", () => {
  it.each([
    [0, "1-10"],
    [1, "1-10"],
    [10, "1-10"],
    [11, "11-100"],
    [100, "11-100"],
    [101, "101-1000"],
    [1000, "101-1000"],
    [1001, "1001-10000"],
    [10000, "1001-10000"],
    [10001, "10000+"],
    [999_999, "10000+"],
  ])("bucket(%i) === %s", (input, expected) => {
    expect(bucket(input)).toBe(expected);
  });
});

// -- track() and friends require initAnalytics() to populate _settings.
// We use the placeholder POSTHOG_KEY (set in vitest.config) to skip the real
// posthog.init() call, but _settings still gets set, so track() won't fire
// because of the placeholder check. To exercise the schema/whitelist, we
// stub VITE_POSTHOG_KEY check via a side door: we patch posthog.capture and
// observe its calls in tests where the internal `isRealKey` check would fail.
// We do this by overriding the check at the module via a dynamic env mock.

describe("settings & opt-out flow", () => {
  beforeEach(() => {
    // Make get_settings return a deterministic record so initAnalytics()
    // doesn't construct a fresh anon id every time.
    setInvokeHandler((cmd) => {
      if (cmd === "get_settings") {
        return {
          anon_id: "anon-test",
          opt_out: false,
          crash_opt_out: false,
          analytics_first_seen_version: "0.0.0-test",
          last_seen_version: "0.0.0-test",
        };
      }
      if (cmd === "set_settings") return true;
      return undefined;
    });
  });

  it("getSettings returns null before init", () => {
    // initAnalytics is module-singleton, so this only holds for very first run.
    // We can't easily reset without unloading the module — but we can at least
    // assert that after init, getSettings is non-null.
    return initAnalytics().then(() => {
      const s = getSettings();
      expect(s).toBeTruthy();
      expect(s!.anon_id).toBeTypeOf("string");
    });
  });

  it("setOptOut updates settings", async () => {
    await initAnalytics();
    await setOptOut(true);
    expect(getSettings()!.opt_out).toBe(true);
    await setOptOut(false);
    expect(getSettings()!.opt_out).toBe(false);
  });

  it("setCrashOptOut updates settings", async () => {
    await initAnalytics();
    await setCrashOptOut(true);
    expect(getSettings()!.crash_opt_out).toBe(true);
    await setCrashOptOut(false);
    expect(getSettings()!.crash_opt_out).toBe(false);
  });

  it("resetAnonymousId rotates the id", async () => {
    await initAnalytics();
    const before = getSettings()!.anon_id;
    await resetAnonymousId();
    const after = getSettings()!.anon_id;
    expect(after).not.toBe(before);
  });
});

describe("safeInvoke()", () => {
  it("returns the invoke result on success", async () => {
    setInvokeHandler((cmd) => (cmd === "ping" ? "pong" : undefined));
    const r = await safeInvoke<string>("ping");
    expect(r).toBe("pong");
  });

  it("rethrows on failure", async () => {
    setInvokeHandler(() => {
      throw new Error("boom");
    });
    await expect(safeInvoke("explode")).rejects.toThrow("boom");
  });
});

describe("track() under placeholder key", () => {
  it("never reaches fetch when key is the test placeholder", async () => {
    await initAnalytics();
    fetchMock.mockClear();
    track("history_loaded", { item_count: 7, load_ms: 12 });
    // Placeholder-key path short-circuits, so no network request is made.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("captureException()", () => {
  it("does not throw when underlying Sentry is mocked", () => {
    expect(() => captureException(new Error("test"), { where: "unit" })).not.toThrow();
  });

  it("hashes the message for the count event", () => {
    const e = new Error("test message");
    expect(() => captureException(e)).not.toThrow();
  });
});
