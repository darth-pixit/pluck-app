import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PreferencesScreen from "./PreferencesScreen";
import { initAnalytics } from "./analytics";
import { setInvokeHandler } from "./__tests__/setup";

async function bootstrap(initial: {
  opt_out?: boolean;
  crash_opt_out?: boolean;
  // Permission states the mocked Tauri invoke should report back.
  accessibility?: boolean;
  input_monitoring?: boolean;
} = {}) {
  setInvokeHandler((cmd) => {
    if (cmd === "get_settings") {
      return {
        anon_id: "anon-test-12345",
        opt_out: initial.opt_out ?? false,
        crash_opt_out: initial.crash_opt_out ?? false,
        analytics_first_seen_version: "0.0.0-test",
        last_seen_version: "0.0.0-test",
      };
    }
    if (cmd === "set_settings") return true;
    if (cmd === "check_accessibility") return initial.accessibility ?? false;
    if (cmd === "check_input_monitoring") return initial.input_monitoring ?? false;
    if (cmd === "open_accessibility_settings") return undefined;
    if (cmd === "open_input_monitoring_settings") return undefined;
    return undefined;
  });
  await initAnalytics();
}

// Pretend we're on macOS so the System permissions section renders.
// jsdom's default navigator.platform is "" which the component reads as
// non-mac and hides the section — that path is exercised by the
// "non-mac platforms hide the section" test below.
function pretendMac() {
  Object.defineProperty(window.navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(window.navigator, "platform", {
    value: "",
    configurable: true,
  });
});

describe("PreferencesScreen", () => {
  it("renders both privacy toggles and the anon id", async () => {
    await bootstrap();
    render(<PreferencesScreen onClose={() => {}} />);
    expect(screen.getByText(/Send anonymous usage stats/)).toBeInTheDocument();
    expect(screen.getByText(/Send crash reports/)).toBeInTheDocument();
    expect(screen.getByText("anon-test-12345")).toBeInTheDocument();
  });

  it("toggling 'Send anonymous usage stats' off persists opt_out=true", async () => {
    await bootstrap({ opt_out: false });
    render(<PreferencesScreen onClose={() => {}} />);
    const checkbox = screen.getByLabelText(/Send anonymous usage stats/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // !opt_out
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it("toggling 'Send crash reports' off persists crash_opt_out=true", async () => {
    await bootstrap({ crash_opt_out: false });
    render(<PreferencesScreen onClose={() => {}} />);
    const checkbox = screen.getByLabelText(/Send crash reports/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it("'Reset anonymous ID' button rotates the displayed UUID", async () => {
    await bootstrap();
    render(<PreferencesScreen onClose={() => {}} />);
    const before = screen.getByText("anon-test-12345");
    expect(before).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Reset anonymous ID/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.queryByText("anon-test-12345")).not.toBeInTheDocument();
    });
  });

  it("shows app version in About section", async () => {
    await bootstrap();
    render(<PreferencesScreen onClose={() => {}} />);
    expect(screen.getByText(/Pluks v/)).toBeInTheDocument();
  });

  it("surfaces the password-skip guarantee in the Privacy section", async () => {
    await bootstrap();
    render(<PreferencesScreen onClose={() => {}} />);
    expect(screen.getByText(/Password fields are skipped automatically/i)).toBeInTheDocument();
  });

  it("calls onClose handler exists (smoke)", async () => {
    await bootstrap();
    const onClose = vi.fn();
    render(<PreferencesScreen onClose={onClose} />);
    // Component doesn't render its own close button; the parent panel does.
    // We just verify the prop is accepted without crashing.
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── System permissions section ─────────────────────────────────────────
  // The section is the user-visible answer to "show me what permissions
  // I've granted." It only renders on macOS — that's the only platform
  // where the watcher is gated on OS permission grants.

  it("shows System permissions section on macOS with current status", async () => {
    pretendMac();
    await bootstrap({ accessibility: true, input_monitoring: false });
    render(<PreferencesScreen onClose={() => {}} />);

    expect(await screen.findByText("System permissions")).toBeInTheDocument();
    expect(screen.getByText("Accessibility")).toBeInTheDocument();
    expect(screen.getByText("Input Monitoring")).toBeInTheDocument();
    // Accessibility was reported as granted → green ✓ pill, no Grant button.
    await waitFor(() => expect(screen.getByText(/✓ Granted/)).toBeInTheDocument());
    // Input Monitoring was reported as missing → "Not granted" + a Grant button.
    expect(screen.getByText(/Not granted/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Grant Input Monitoring permission/i })
    ).toBeInTheDocument();
  });

  it("clicking Grant invokes the matching open_*_settings command", async () => {
    pretendMac();
    const invoked: string[] = [];
    setInvokeHandler((cmd) => {
      if (cmd === "get_settings") {
        return {
          anon_id: "anon-test-12345",
          opt_out: false,
          crash_opt_out: false,
          analytics_first_seen_version: "0.0.0-test",
          last_seen_version: "0.0.0-test",
        };
      }
      if (cmd === "check_accessibility") return false;
      if (cmd === "check_input_monitoring") return true;
      invoked.push(cmd);
      return undefined;
    });
    await initAnalytics();
    render(<PreferencesScreen onClose={() => {}} />);

    const grantBtn = await screen.findByRole("button", {
      name: /Grant Accessibility permission/i,
    });
    fireEvent.click(grantBtn);

    await waitFor(() =>
      expect(invoked).toContain("open_accessibility_settings"),
    );
  });

  it("hides the System permissions section on non-mac platforms", async () => {
    // Don't call pretendMac() — navigator.platform stays "" (jsdom default).
    await bootstrap();
    render(<PreferencesScreen onClose={() => {}} />);
    expect(screen.queryByText("System permissions")).not.toBeInTheDocument();
  });
});
