import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryItem } from "./App";
import { detect, type PasteAction } from "./detectors";

interface Props {
  items: HistoryItem[];
  onCopy: (id: number) => void;
  onDelete: (id: number) => void;
  onActiveChange?: (id: number) => void;
  onCopyTransformed?: (text: string) => void;
}

function timeAgo(ts: string, now: number): string {
  // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC — append Z so Date parses it as UTC.
  const ms = new Date(ts.includes("T") ? ts : ts + "Z").getTime();
  const secs = Math.max(0, Math.floor((now - ms) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return t?.tagName === "INPUT" || t?.tagName === "TEXTAREA";
}

export default function HistoryPanel({ items, onCopy, onDelete, onActiveChange, onCopyTransformed }: Props) {
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLUListElement>(null);

  const activeItem = items[active];
  const detections = useMemo(() => items.map(i => detect(i.content)), [items]);
  const activeDetection = detections[active] ?? null;

  useEffect(() => {
    if (items[active]) onActiveChange?.(items[active].id);
  }, [active, items, onActiveChange]);

  // Re-tick once a minute so timeAgo labels update without external triggers.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Keyboard navigation. Functional setters keep `active` out of the dep array,
  // so this listener doesn't churn on every arrow keypress.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(a => Math.min(a + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(a => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        setActive(a => { if (items[a]) onCopy(items[a].id); return a; });
      } else if (e.key === "Backspace" || e.key === "Delete") {
        // Don't delete an item when the user is editing text in the search input.
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        setActive(a => { if (items[a]) onDelete(items[a].id); return a; });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [items, onCopy, onDelete]);

  useEffect(() => { setActive(0); }, [items]);

  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const handleAction = (action: PasteAction) => {
    if (!activeItem || !onCopyTransformed) return;
    onCopyTransformed(action.transform(activeItem.content));
  };

  return (
    <>
      <ul className="history-list" ref={listRef}>
        {items.map((item, idx) => (
          <li
            key={item.id}
            className={`history-item ${idx === active ? "active" : ""}`}
            onMouseEnter={() => setActive(idx)}
            onClick={() => onCopy(item.id)}
          >
            <span className="item-preview">
              {detections[idx] && (
                <span className={`kind-badge kind-${detections[idx]!.kind}`}>
                  {detections[idx]!.badge}
                </span>
              )}
              {item.content.length > 120
                ? item.content.slice(0, 120) + "…"
                : item.content}
            </span>
            <div className="item-meta">
              <span className="item-chars">{item.char_count} chars</span>
              <span className="item-time">{timeAgo(item.copied_at, now)}</span>
              <button
                className="item-delete"
                title="Delete"
                onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
      {activeDetection && (
        <div className="paste-actions">
          <span className="paste-actions-label">Paste as</span>
          {activeDetection.actions.map(action => (
            <button
              key={action.label}
              className="paste-action"
              title={`Paste ${activeItem!.content.slice(0, 40)}… as ${action.label}`}
              onClick={(e) => { e.stopPropagation(); handleAction(action); }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
