use rusqlite::{params, Connection, Result, Row};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: i64,
    pub content: String,
    pub copied_at: String,
    pub char_count: usize,
}

pub struct Database {
    conn: Connection,
    row_count: usize,
}

fn map_row(row: &Row) -> rusqlite::Result<HistoryItem> {
    let content: String = row.get(1)?;
    let char_count = content.chars().count();
    Ok(HistoryItem {
        id: row.get(0)?,
        content,
        copied_at: row.get(2)?,
        char_count,
    })
}

impl Database {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let conn = Connection::open(&db_path)?;

        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS history (
               id         INTEGER PRIMARY KEY AUTOINCREMENT,
               content    TEXT NOT NULL,
               copied_at  DATETIME DEFAULT (datetime('now'))
             );
             CREATE INDEX IF NOT EXISTS idx_copied_at ON history(copied_at DESC);",
        )?;

        let row_count: usize = conn
            .query_row("SELECT COUNT(*) FROM history", [], |r| {
                r.get::<_, i64>(0).map(|n| n as usize)
            })
            .unwrap_or(0);

        Ok(Self { conn, row_count })
    }

    /// Insert a new entry. If it duplicates the most-recent entry, return that row unchanged.
    /// Trims to HISTORY_LIMIT only when actually exceeded.
    pub fn insert(&mut self, content: &str) -> Result<HistoryItem> {
        let most_recent: Option<String> = self
            .conn
            .query_row(
                "SELECT content FROM history ORDER BY copied_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();

        if most_recent.as_deref() == Some(content) {
            return self.conn.query_row(
                "SELECT id, content, copied_at FROM history ORDER BY copied_at DESC LIMIT 1",
                [],
                map_row,
            );
        }

        // RETURNING folds INSERT + post-insert SELECT into one statement.
        let item: HistoryItem = self.conn.query_row(
            "INSERT INTO history (content) VALUES (?1) RETURNING id, content, copied_at",
            params![content],
            map_row,
        )?;
        self.row_count += 1;

        if self.row_count > HISTORY_LIMIT {
            let removed = self.conn.execute(
                "DELETE FROM history WHERE id NOT IN (
                   SELECT id FROM history ORDER BY copied_at DESC LIMIT ?1
                 )",
                params![HISTORY_LIMIT as i64],
            )?;
            self.row_count = self.row_count.saturating_sub(removed);
        }

        Ok(item)
    }

    pub fn get_all(&self) -> Result<Vec<HistoryItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, content, copied_at FROM history ORDER BY copied_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![HISTORY_LIMIT as i64], map_row)?;
        let mut out = Vec::with_capacity(HISTORY_LIMIT);
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_content_by_id(&self, id: i64) -> Result<Option<String>> {
        match self.conn.query_row(
            "SELECT content FROM history WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(text) => Ok(Some(text)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM history WHERE id = ?1", params![id])?;
        self.row_count = self.row_count.saturating_sub(n);
        Ok(())
    }

    pub fn clear_all(&mut self) -> Result<()> {
        self.conn.execute("DELETE FROM history", [])?;
        self.row_count = 0;
        Ok(())
    }
}
