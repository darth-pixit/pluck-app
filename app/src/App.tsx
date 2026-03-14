import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import HistoryPanel from "./HistoryPanel";
import "./index.css";

export interface HistoryItem {
  id: number;
  content: string;
  copied_at: string;
  char_count: number;
}

export default function App() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [accessible, setAccessible] = useState(true);

  useEffect(() => {
    invoke<HistoryItem[]>("get_history").then(setItems).catch(console.error);
    invoke<boolean>("check_accessibility").then(setAccessible).catch(() => setAccessible(true));
  }, []);

  // Re-check accessibility every time the window is focused (user may have just granted it)
  useEffect(() => {
    const win = getCurrentWindow();
    let cleanup: (() => void) | undefined;
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        invoke<boolean>("check_accessibility").then(setAccessible).catch(() => {});
      } else {
        win.hide();
      }
    }).then((fn) => (cleanup = fn));
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const unlisten = listen<HistoryItem>("new-selection", (event) => {
      setItems((prev) => {
        if (prev[0]?.id === event.payload.id) return prev;
        return [event.payload, ...prev].slice(0, 100);
      });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleCopy = useCallback(async (id: number) => {
    await invoke("copy_item", { id });
    getCurrentWindow().hide();
  }, []);

  const handleDelete = useCallback(async (id: number) => {
    await invoke("delete_item", { id });
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const handleClear = useCallback(async () => {
    await invoke("clear_history");
    setItems([]);
  }, []);

  const filtered = query.trim()
    ? items.filter((i) => i.content.toLowerCase().includes(query.toLowerCase()))
    : items;

  return (
    <div className="panel">
      {/* Title bar — draggable, with traffic lights */}
      <div className="titlebar" data-tauri-drag-region>
        <div className="traffic-lights">
          <button
            className="tl tl-close"
            title="Close"
            onClick={() => getCurrentWindow().hide()}
          />
          <button
            className="tl tl-min"
            title="Minimise"
            onClick={() => getCurrentWindow().minimize()}
          />
          {/* green dot intentionally absent — resize has no meaning for this overlay */}
        </div>
        <span className="brand" data-tauri-drag-region>pluks</span>
        <span className="count">{items.length} / 100</span>
      </div>

      {/* Accessibility warning banner */}
      {!accessible && (
        <div className="access-banner">
          <span>Accessibility permission needed for auto-copy</span>
          <button
            className="access-btn"
            onClick={() => invoke("open_accessibility_settings")}
          >
            Open Settings
          </button>
        </div>
      )}

      <div className="search-row">
        <input
          autoFocus
          className="search"
          placeholder="Search history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          {query ? "No matches" : "Select any text to start collecting"}
        </div>
      ) : (
        <HistoryPanel items={filtered} onCopy={handleCopy} onDelete={handleDelete} />
      )}

      <div className="panel-footer">
        <button className="btn-clear" onClick={handleClear}>Clear all</button>
        <span className="hint">↩ copy · ⌫ delete · esc close</span>
      </div>
    </div>
  );
}
