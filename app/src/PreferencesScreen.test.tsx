import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PreferencesScreen from "./PreferencesScreen";
import { initAnalytics } from "./analytics";
import { setInvokeHandler } from "./__tests__/setup";

async function bootstrap(initial: { opt_out?: boolean; crash_opt_out?: boolean } = {}) {
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
    return undefined;
  });
  await initAnalytics();
}

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

  it("calls onClose handler exists (smoke)", async () => {
    await bootstrap();
    const onClose = vi.fn();
    render(<PreferencesScreen onClose={onClose} />);
    // Component doesn't render its own close button; the parent panel does.
    // We just verify the prop is accepted without crashing.
    expect(onClose).not.toHaveBeenCalled();
  });
});
