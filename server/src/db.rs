//! SQLite access.
//!
//! One connection writes and a few read, in WAL mode, so a long listing never waits for a write.
//! Calls run on Tokio's blocking pool: SQLite is fast enough that a thread hop costs more than
//! the query, but it must never block the async workers.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags};

use crate::error::AppError;

/// Schema versions, applied in order. Never edit a shipped entry: append a new one.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial.sql"),
    include_str!("../migrations/002_channel_art.sql"),
    include_str!("../migrations/003_lookup_indexes.sql"),
];

const READERS: usize = 3;

#[derive(Clone)]
pub struct Db {
    writer: Arc<Mutex<Connection>>,
    readers: Arc<Vec<Mutex<Connection>>>,
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -8000;",
    )
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let writer = Connection::open(path)?;
        configure(&writer)?;
        migrate(&writer)?;
        let readers = (0..READERS)
            .map(|_| {
                let conn = Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
                )?;
                configure(&conn)?;
                Ok(Mutex::new(conn))
            })
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Self { writer: Arc::new(Mutex::new(writer)), readers: Arc::new(readers) })
    }

    /// Runs `f` on the writing connection.
    pub async fn write<T, F>(&self, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, AppError> + Send + 'static,
    {
        let writer = Arc::clone(&self.writer);
        tokio::task::spawn_blocking(move || {
            let mut conn = writer.lock().map_err(|_| AppError::internal("database lock poisoned"))?;
            f(&mut conn)
        })
        .await
        .map_err(|error| AppError::internal(format!("database task failed: {error}")))?
    }

    /// Runs `f` on a reading connection: the first free one, else the first.
    pub async fn read<T, F>(&self, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, AppError> + Send + 'static,
    {
        let readers = Arc::clone(&self.readers);
        tokio::task::spawn_blocking(move || {
            let guard = readers
                .iter()
                .find_map(|reader| reader.try_lock().ok())
                .map_or_else(|| readers[0].lock(), Ok)
                .map_err(|_| AppError::internal("database lock poisoned"))?;
            f(&guard)
        })
        .await
        .map_err(|error| AppError::internal(format!("database task failed: {error}")))?
    }
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    let current: usize = conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?.try_into().unwrap_or(0);
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", index + 1))?;
        tracing::info!(version = index + 1, "database migrated");
    }
    Ok(())
}

/// Milliseconds since the Unix epoch: the only time format stored.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}
