use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: i64,
    pub content: String,
    pub copied_at: String,
    pub char_count: usize,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        // Ensure parent directory exists
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

        Ok(Self { conn })
    }

    /// Insert a new entry. If the same content is already the most recent entry, skip.
    /// Trims to 100 entries after insert.
    pub fn insert(&mut self, content: &str) -> Result<HistoryItem> {
        // Deduplicate against the most recent entry
        let most_recent: Option<String> = self
            .conn
            .query_row(
                "SELECT content FROM history ORDER BY copied_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();

        if most_recent.as_deref() == Some(content) {
            // Return the existing top item refreshed
            return self.conn.query_row(
                "SELECT id, content, copied_at FROM history ORDER BY copied_at DESC LIMIT 1",
                [],
                |row| {
                    let text: String = row.get(1)?;
                    let len = text.chars().count();
                    Ok(HistoryItem {
                        id: row.get(0)?,
                        content: text,
                        copied_at: row.get(2)?,
                        char_count: len,
                    })
                },
            );
        }

        self.conn.execute(
            "INSERT INTO history (content) VALUES (?1)",
            params![content],
        )?;
        let id = self.conn.last_insert_rowid();

        // Trim to 100 entries (keep the newest)
        self.conn.execute(
            "DELETE FROM history WHERE id NOT IN (
               SELECT id FROM history ORDER BY copied_at DESC LIMIT 100
             )",
            [],
        )?;

        // Re-query so copied_at is always the SQLite-generated ISO datetime
        self.conn.query_row(
            "SELECT id, content, copied_at FROM history WHERE id = ?1",
            params![id],
            |row| {
                let text: String = row.get(1)?;
                let len = text.chars().count();
                Ok(HistoryItem {
                    id: row.get(0)?,
                    content: text,
                    copied_at: row.get(2)?,
                    char_count: len,
                })
            },
        )
    }

    pub fn get_all(&self) -> Result<Vec<HistoryItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, content, copied_at FROM history ORDER BY copied_at DESC LIMIT 100",
        )?;
        let items = stmt.query_map([], |row| {
            let text: String = row.get(1)?;
            let len = text.chars().count();
            Ok(HistoryItem {
                id: row.get(0)?,
                content: text,
                copied_at: row.get(2)?,
                char_count: len,
            })
        })?;

        let mut result = Vec::new();
        for item in items {
            result.push(item?);
        }
        Ok(result)
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM history WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_all(&mut self) -> Result<()> {
        self.conn.execute("DELETE FROM history", [])?;
        Ok(())
    }
}

