import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./updater", () => {
  const listeners = new Set<(s: unknown) => void>();
  return {
    subscribeUpdateStatus: vi.fn((fn: (s: unknown) => void) => {
      listeners.add(fn);
      fn({ phase: "idle" });
      return () => listeners.delete(fn);
    }),
    installStagedUpdate: vi.fn().mockResolvedValue(undefined),
    markUpdateNoticeDismissed: vi.fn(),
    shouldShowNoticeFor: vi.fn().mockReturnValue(true),
    __setStatus: (s: unknown) => listeners.forEach((fn) => fn(s)),
  };
});

import UpdateBanner from "./UpdateBanner";
import * as updater from "./updater";
const rawSetStatus = (updater as unknown as { __setStatus: (s: unknown) => void }).__setStatus;
const setStatus = (s: unknown) => act(() => rawSetStatus(s));

describe("UpdateBanner", () => {
  it("renders nothing when phase is 'idle'", () => {
    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when phase is 'checking' or 'downloading'", () => {
    const { container } = render(<UpdateBanner />);
    setStatus({ phase: "checking" });
    expect(container.querySelector(".update-banner")).toBeNull();
    setStatus({ phase: "downloading", progress: 0.5 });
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("shows compact 'Updating…' line during installing phase", () => {
    render(<UpdateBanner />);
    setStatus({ phase: "installing" });
    expect(screen.getByText(/Updating Pluks/)).toBeInTheDocument();
  });

  it("renders version + highlights when phase is 'ready'", () => {
    render(<UpdateBanner />);
    setStatus({
      phase: "ready",
      version: "1.2.3",
      highlights: ["faster startup", "fixes JSON detection"],
    });
    expect(screen.getByText(/Pluks 1\.2\.3 is ready/)).toBeInTheDocument();
    expect(screen.getByText("faster startup")).toBeInTheDocument();
    expect(screen.getByText("fixes JSON detection")).toBeInTheDocument();
  });

  it("'Install & restart' button calls installStagedUpdate", () => {
    render(<UpdateBanner />);
    setStatus({ phase: "ready", version: "1.2.3", highlights: [] });
    fireEvent.click(screen.getByRole("button", { name: /Install & restart/i }));
    expect(updater.installStagedUpdate).toHaveBeenCalled();
  });

  it("'Later' button dismisses and calls markUpdateNoticeDismissed", () => {
    render(<UpdateBanner />);
    setStatus({ phase: "ready", version: "1.2.3", highlights: [] });
    fireEvent.click(screen.getByRole("button", { name: /Later/i }));
    expect(updater.markUpdateNoticeDismissed).toHaveBeenCalledWith("1.2.3");
  });

  it("× button dismisses banner", () => {
    render(<UpdateBanner />);
    setStatus({ phase: "ready", version: "1.2.3", highlights: [] });
    fireEvent.click(screen.getByLabelText(/Dismiss update notice/i));
    expect(updater.markUpdateNoticeDismissed).toHaveBeenCalledWith("1.2.3");
  });

  it("hides itself when shouldShowNoticeFor returns false", () => {
    (updater.shouldShowNoticeFor as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const { container } = render(<UpdateBanner />);
    setStatus({ phase: "ready", version: "1.2.3", highlights: [] });
    expect(container.querySelector(".update-banner")).toBeNull();
  });
});
