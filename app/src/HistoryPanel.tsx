import { useEffect, useRef, useState } from "react";
import type { HistoryItem } from "./App";

interface Props {
  items: HistoryItem[];
  onCopy: (id: number) => void;
  onDelete: (id: number) => void;
}

function timeAgo(ts: string): string {
  // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC — append Z so Date parses it as UTC
  const ms = new Date(ts.includes("T") ? ts : ts + "Z").getTime();
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function HistoryPanel({ items, onCopy, onDelete }: Props) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[active]) onCopy(items[active].id);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (items[active]) onDelete(items[active].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, items, onCopy, onDelete]);

  // Reset active index when items change
  useEffect(() => { setActive(0); }, [items]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <ul className="history-list" ref={listRef}>
      {items.map((item, idx) => (
        <li
          key={item.id}
          className={`history-item ${idx === active ? "active" : ""}`}
          onMouseEnter={() => setActive(idx)}
          onClick={() => onCopy(item.id)}
        >
          <span className="item-preview">
            {item.content.length > 120
              ? item.content.slice(0, 120) + "…"
              : item.content}
          </span>
          <div className="item-meta">
            <span className="item-chars">{item.char_count} chars</span>
            <span className="item-time">{timeAgo(item.copied_at)}</span>
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
  );
}
