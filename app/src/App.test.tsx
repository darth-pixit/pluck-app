import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { setInvokeHandler } from "./__tests__/setup";

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

  it("titlebar shows count badge as N / 100", async () => {
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
      expect(screen.getByText(/3 \/ 100/)).toBeInTheDocument();
    });
  });
});
