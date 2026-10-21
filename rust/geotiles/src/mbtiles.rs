//! Minimal mbtiles writer (metadata + tiles, TMS tile_row).

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;

pub struct Mbtiles {
    conn: Connection,
}

pub struct TileRow {
    pub z: u32,
    pub x: u32,
    pub tms_y: u32,
    pub data: Vec<u8>,
}

impl Mbtiles {
    pub fn create(
        path: &Path,
        name: &str,
        format: &str,
        minzoom: u32,
        maxzoom: u32,
        bounds: (f64, f64, f64, f64),
    ) -> Result<Mbtiles> {
        if path.exists() {
            std::fs::remove_file(path).context("remove existing mbtiles")?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=OFF;
             PRAGMA synchronous=OFF;
             CREATE TABLE metadata (name TEXT, value TEXT);
             CREATE TABLE tiles (
               zoom_level INTEGER,
               tile_column INTEGER,
               tile_row INTEGER,
               tile_data BLOB
             );",
        )?;
        let meta = [
            ("name".to_string(), name.to_string()),
            ("format".to_string(), format.to_string()),
            ("minzoom".to_string(), minzoom.to_string()),
            ("maxzoom".to_string(), maxzoom.to_string()),
            (
                "bounds".to_string(),
                format!("{},{},{},{}", bounds.0, bounds.1, bounds.2, bounds.3),
            ),
            ("type".to_string(), "overlay".to_string()),
            ("version".to_string(), "1".to_string()),
        ];
        {
            let mut stmt = conn.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)")?;
            for (k, v) in &meta {
                stmt.execute([k, v])?;
            }
        }
        Ok(Mbtiles { conn })
    }

    pub fn write_batch(&mut self, rows: &[TileRow]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data)
                 VALUES (?, ?, ?, ?)",
            )?;
            for r in rows {
                stmt.execute(rusqlite::params![r.z, r.x, r.tms_y, r.data])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn finish(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS tile_index
             ON tiles (zoom_level, tile_column, tile_row);",
        )?;
        Ok(())
    }

    pub fn count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM tiles", [], |r| r.get(0))?)
    }
}
