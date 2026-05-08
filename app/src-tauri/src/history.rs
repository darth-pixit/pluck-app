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
               copied_at  DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
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
                "SELECT content FROM history ORDER BY copied_at DESC, id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();

        if most_recent.as_deref() == Some(content) {
            return self.conn.query_row(
                "SELECT id, content, copied_at FROM history ORDER BY copied_at DESC, id DESC LIMIT 1",
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
                   SELECT id FROM history ORDER BY copied_at DESC, id DESC LIMIT ?1
                 )",
                params![HISTORY_LIMIT as i64],
            )?;
            self.row_count = self.row_count.saturating_sub(removed);
        }

        Ok(item)
    }

    pub fn get_all(&self) -> Result<Vec<HistoryItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, content, copied_at FROM history ORDER BY copied_at DESC, id DESC LIMIT ?1",
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh_db() -> (Database, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("test.db");
        let db = Database::new(path).expect("open db");
        (db, dir)
    }

    #[test]
    fn empty_db_returns_no_rows() {
        let (db, _d) = fresh_db();
        assert_eq!(db.get_all().unwrap().len(), 0);
    }

    #[test]
    fn insert_returns_item_with_assigned_id() {
        let (mut db, _d) = fresh_db();
        let item = db.insert("hello world").unwrap();
        assert!(item.id > 0);
        assert_eq!(item.content, "hello world");
        assert_eq!(item.char_count, 11);
    }

    #[test]
    fn insert_persists_and_returns_in_get_all() {
        let (mut db, _d) = fresh_db();
        db.insert("first").unwrap();
        db.insert("second").unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), 2);
        // Newest first by copied_at DESC
        assert_eq!(all[0].content, "second");
        assert_eq!(all[1].content, "first");
    }

    #[test]
    fn duplicate_top_row_does_not_double_insert() {
        let (mut db, _d) = fresh_db();
        db.insert("dupe").unwrap();
        db.insert("dupe").unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].content, "dupe");
    }

    #[test]
    fn non_top_duplicate_inserts_a_new_row() {
        let (mut db, _d) = fresh_db();
        db.insert("a").unwrap();
        db.insert("b").unwrap();
        // Now "a" is no longer the top, re-inserting it should land as a new row.
        db.insert("a").unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].content, "a");
    }

    #[test]
    fn history_is_capped_at_100() {
        let (mut db, _d) = fresh_db();
        for i in 0..120 {
            db.insert(&format!("item-{:03}", i)).unwrap();
        }
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), HISTORY_LIMIT);
        // Newest 100 retained — item-119 is on top.
        assert_eq!(all[0].content, "item-119");
        // Oldest 20 dropped.
        assert!(all.iter().all(|i| i.content != "item-000"));
        assert!(all.iter().all(|i| i.content != "item-019"));
    }

    #[test]
    fn get_content_by_id_roundtrip() {
        let (mut db, _d) = fresh_db();
        let item = db.insert("look me up").unwrap();
        let found = db.get_content_by_id(item.id).unwrap();
        assert_eq!(found.as_deref(), Some("look me up"));
    }

    #[test]
    fn get_content_by_id_returns_none_for_missing() {
        let (db, _d) = fresh_db();
        assert!(db.get_content_by_id(999_999).unwrap().is_none());
    }

    #[test]
    fn delete_removes_a_row_and_count() {
        let (mut db, _d) = fresh_db();
        db.insert("keep").unwrap();
        let doomed = db.insert("doomed").unwrap();
        db.delete(doomed.id).unwrap();
        let all = db.get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].content, "keep");
    }

    #[test]
    fn delete_unknown_id_is_noop() {
        let (mut db, _d) = fresh_db();
        db.insert("a").unwrap();
        db.delete(999_999).unwrap();
        assert_eq!(db.get_all().unwrap().len(), 1);
    }

    #[test]
    fn clear_all_empties_history() {
        let (mut db, _d) = fresh_db();
        for i in 0..10 {
            db.insert(&format!("x-{}", i)).unwrap();
        }
        db.clear_all().unwrap();
        assert_eq!(db.get_all().unwrap().len(), 0);
    }

    #[test]
    fn char_count_counts_unicode_codepoints_not_bytes() {
        let (mut db, _d) = fresh_db();
        let item = db.insert("éñü").unwrap(); // 3 chars, 6 bytes
        assert_eq!(item.char_count, 3);
    }

    #[test]
    fn database_persists_across_reopens() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("persist.db");
        {
            let mut db = Database::new(path.clone()).unwrap();
            db.insert("survives").unwrap();
        }
        let db2 = Database::new(path).unwrap();
        let all = db2.get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].content, "survives");
    }

    #[test]
    fn very_long_content_roundtrips() {
        let (mut db, _d) = fresh_db();
        let long = "x".repeat(50_000);
        let item = db.insert(&long).unwrap();
        assert_eq!(item.char_count, 50_000);
        assert_eq!(db.get_content_by_id(item.id).unwrap().unwrap().len(), 50_000);
    }
}
