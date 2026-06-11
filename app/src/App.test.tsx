import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { track } from "./analytics";
import { emitTauriEvent, setInvokeHandler } from "./__tests__/setup";

// Keep real implementations but wrap every export in a spy so tests can
// assert which analytics events the component pipeline emits.
vi.mock("./analytics", { spy: true });

function permissionHandler(opts: {
  ax?: boolean;
  im?: boolean;
  history?: Array<{ id: number; content: string; copied_at: string; char_count: number }>;
}) {
  return (cmd: string) => {
    if (cmd === "check_accessibility") return opts.ax ?? false;
    if (cmd === "check_input_monitoring") return opts.im ?? false;
    if (cmd === "get_history") return opts.history ?? [];
    if (cmd === "get_settings") {
      return {
        anon_id: "anon-test",
        opt_out: false,
        crash_opt_out: false,
        analytics_first_seen_version: "0.0.0-test",
        last_seen_version: "0.0.0-test",
        enable_long_press_paste: true,
        show_nudges: true,
      };
    }
    return undefined;
  };
}

describe("App routing", () => {
  it("first-run shows the onboarding tour", async () => {
    localStorage.clear();
    setInvokeHandler(permissionHandler({ ax: false, im: false }));
    render(<App />);
    expect(await screen.findByText(/Select to copy/)).toBeInTheDocument();
  });

  it("after onboarding seen, shows permission setup screen if perms missing", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    setInvokeHandler(permissionHandler({ ax: false, im: false }));
    render(<App />);
    expect(await screen.findByText(/Two quick permissions/)).toBeInTheDocument();
    // Scope the role-existence assertions to the .step-title elements so the
    // word "Accessibility" appearing elsewhere on the screen (e.g. in the
    // password-skip privacy note) doesn't trip getByText's uniqueness check.
    const titles = screen.getAllByText((_, el) =>
      el?.classList.contains("step-title") ?? false,
    );
    expect(titles.map(t => t.textContent)).toEqual(
      expect.arrayContaining(["Accessibility", "Input Monitoring"]),
    );
  });

  it("after both perms granted with activation seen, shows the main panel", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    localStorage.setItem("pluks.activation.v1.seen", "1");
    setInvokeHandler(permissionHandler({ ax: true, im: true }));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search history/)).toBeInTheDocument();
    });
  });

  it("empty history shows the 'Select any text' hint", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    localStorage.setItem("pluks.activation.v1.seen", "1");
    setInvokeHandler(permissionHandler({ ax: true, im: true, history: [] }));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Select any text to start collecting/)).toBeInTheDocument();
    });
  });

  it("history items render in the panel", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    localStorage.setItem("pluks.activation.v1.seen", "1");
    setInvokeHandler(
      permissionHandler({
        ax: true,
        im: true,
        history: [
          { id: 1, content: "snapshot one", copied_at: new Date().toISOString(), char_count: 12 },
          { id: 2, content: "snapshot two", copied_at: new Date().toISOString(), char_count: 12 },
        ],
      }),
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("snapshot one")).toBeInTheDocument();
      expect(screen.getByText("snapshot two")).toBeInTheDocument();
    });
  });

  it("Cmd+Shift+V returns to history view when Preferences was open", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    localStorage.setItem("pluks.activation.v1.seen", "1");
    setInvokeHandler(permissionHandler({ ax: true, im: true }));
    render(<App />);

    // Open Preferences via the gear button.
    const gear = await screen.findByTitle("Preferences");
    await userEvent.click(gear);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Search history/)).not.toBeInTheDocument();
    });

    // Simulate the global shortcut firing — Rust emits "keyboard-open".
    await act(async () => {
      emitTauriEvent("keyboard-open", undefined);
    });

    // Back on the history list.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search history/)).toBeInTheDocument();
    });
  });

  it("'history-added' clips appear in the list without firing a nudge", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    localStorage.setItem("pluks.activation.v1.seen", "1");
    const cmds: string[] = [];
    setInvokeHandler((cmd: string) => {
      cmds.push(cmd);
      return permissionHandler({ ax: true, im: true, history: [] })(cmd);
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search history/)).toBeInTheDocument();
    });

    await act(async () => {
      emitTauriEvent("history-added", {
        id: 7,
        content: "banked during onboarding",
        copied_at: new Date().toISOString(),
        char_count: 24,
      });
    });

    // The clip lands in the list…
    await waitFor(() => {
      expect(screen.getByText("banked during onboarding")).toBeInTheDocument();
    });
    // …but the capture/nudge pipeline never runs for it.
    expect(cmds).not.toContain("show_nudge");
    expect(localStorage.getItem("pluks.nudges.selects_total")).toBeNull();
  });

  it("'new-selection' clips are tracked as selection_captured", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    localStorage.setItem("pluks.activation.v1.seen", "1");
    setInvokeHandler(permissionHandler({ ax: true, im: true, history: [] }));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search history/)).toBeInTheDocument();
    });
    vi.mocked(track).mockClear();

    await act(async () => {
      emitTauriEvent("new-selection", {
        id: 8,
        content: "https://example.com/some/page",
        copied_at: new Date().toISOString(),
        char_count: 29,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("https://example.com/some/page")).toBeInTheDocument();
    });
    // Regression: the success path never reported to PostHog (only
    // capture-suppressed → selection_capture_failed was wired), so the
    // desktop app showed zero successful captures in analytics, ever.
    expect(track).toHaveBeenCalledWith("selection_captured", {
      kind: "url",
      char_count_bucket: "11-100",
      had_clipboard_change: true,
    });
  });

  it("titlebar shows count badge as N / 200", async () => {
    localStorage.clear();
    localStorage.setItem("pluks.onboarding.v1.seen", "1");
    localStorage.setItem("pluks.activation.v1.seen", "1");
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      content: `item-${i}`,
      copied_at: new Date().toISOString(),
      char_count: 6,
    }));
    setInvokeHandler(permissionHandler({ ax: true, im: true, history: items }));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/3 \/ 200/)).toBeInTheDocument();
    });
  });
});
