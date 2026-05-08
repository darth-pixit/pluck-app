import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import HistoryPanel from "./HistoryPanel";
import type { HistoryItem } from "./App";

function items(...specs: Array<{ id: number; content: string; copied_at?: string }>): HistoryItem[] {
  return specs.map((s) => ({
    id: s.id,
    content: s.content,
    copied_at: s.copied_at ?? new Date(Date.now() - 60_000).toISOString(),
    char_count: s.content.length,
  }));
}

describe("HistoryPanel", () => {
  it("renders an empty list without crashing", () => {
    const { container } = render(
      <HistoryPanel items={[]} onCopy={() => {}} onDelete={() => {}} />,
    );
    expect(container.querySelector(".history-list")?.children.length).toBe(0);
  });

  it("renders one row per item", () => {
    render(
      <HistoryPanel
        items={items({ id: 1, content: "alpha" }, { id: 2, content: "beta" })}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  it("truncates content longer than 120 chars in the preview", () => {
    const long = "x".repeat(200);
    render(
      <HistoryPanel items={items({ id: 1, content: long })} onCopy={() => {}} onDelete={() => {}} />,
    );
    const preview = screen.getByText(/x{50,}…$/);
    expect(preview.textContent!.length).toBeLessThanOrEqual(121); // 120 + ellipsis
  });

  it("clicking a row calls onCopy with that id", () => {
    const onCopy = vi.fn();
    render(
      <HistoryPanel
        items={items({ id: 42, content: "hello" })}
        onCopy={onCopy}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("hello"));
    expect(onCopy).toHaveBeenCalledWith(42);
  });

  it("clicking ✕ calls onDelete with via='click' and stops propagation", () => {
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <HistoryPanel
        items={items({ id: 7, content: "todelete" })}
        onCopy={onCopy}
        onDelete={onDelete}
      />,
    );
    const del = container.querySelector(".item-delete")!;
    fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledWith(7, "click");
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("Enter key triggers onCopy on the active row", () => {
    const onCopy = vi.fn();
    render(
      <HistoryPanel
        items={items(
          { id: 1, content: "a", copied_at: new Date(Date.now() - 60_000).toISOString() },
          { id: 2, content: "b" },
        )}
        onCopy={onCopy}
        onDelete={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onCopy).toHaveBeenCalledWith(1);
  });

  it("Backspace triggers onDelete with via='keyboard'", () => {
    const onDelete = vi.fn();
    render(
      <HistoryPanel
        items={items({ id: 5, content: "doomed" })}
        onCopy={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(onDelete).toHaveBeenCalledWith(5, "keyboard");
  });

  it("Backspace inside an INPUT does NOT trigger delete", () => {
    const onDelete = vi.fn();
    render(
      <>
        <input data-testid="search" />
        <HistoryPanel
          items={items({ id: 5, content: "kept" })}
          onCopy={() => {}}
          onDelete={onDelete}
        />
      </>,
    );
    const input = screen.getByTestId("search");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("ArrowDown moves active row, ArrowUp moves it back", () => {
    const onActiveChange = vi.fn();
    render(
      <HistoryPanel
        items={items(
          { id: 1, content: "a", copied_at: new Date(Date.now() - 60_000).toISOString() },
          { id: 2, content: "b" },
          { id: 3, content: "c" },
        )}
        onCopy={() => {}}
        onDelete={() => {}}
        onActiveChange={onActiveChange}
      />,
    );
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    // After: active should be id 2 (started 0 → 1 → 2 → 1)
    const calls = onActiveChange.mock.calls.map((c) => c[0]);
    expect(calls).toContain(2);
    expect(calls).toContain(3);
  });

  it("renders smart-paste actions for detected URL row", () => {
    render(
      <HistoryPanel
        items={items({ id: 1, content: "https://example.com" })}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText("Plain")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(screen.getByText("HTML <a>")).toBeInTheDocument();
    expect(screen.getByText("No params")).toBeInTheDocument();
  });

  it("does NOT render smart-paste actions for plain text", () => {
    const { container } = render(
      <HistoryPanel
        items={items({ id: 1, content: "just some words" })}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(container.querySelector(".paste-actions")).toBeNull();
  });

  it("clicking a smart-paste action calls onCopyTransformed with kind+label", () => {
    const onCopyTransformed = vi.fn();
    render(
      <HistoryPanel
        items={items({ id: 1, content: "https://example.com/x?y=1" })}
        onCopy={() => {}}
        onDelete={() => {}}
        onCopyTransformed={onCopyTransformed}
      />,
    );
    fireEvent.click(screen.getByText("Markdown"));
    expect(onCopyTransformed).toHaveBeenCalledWith(
      "[example.com](https://example.com/x?y=1)",
      "Markdown",
      "url",
    );
  });

  it("renders kind badge with correct text", () => {
    render(
      <HistoryPanel
        items={items({ id: 1, content: "alice@example.com" })}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText("Email")).toBeInTheDocument();
  });

  it("auto-skips fresh top row to row 2", () => {
    const onActiveChange = vi.fn();
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 60_000).toISOString();
    render(
      <HistoryPanel
        items={[
          { id: 1, content: "fresh", copied_at: fresh, char_count: 5 },
          { id: 2, content: "old", copied_at: old, char_count: 3 },
        ]}
        onCopy={() => {}}
        onDelete={() => {}}
        onActiveChange={onActiveChange}
      />,
    );
    expect(onActiveChange).toHaveBeenCalledWith(2);
  });
});
