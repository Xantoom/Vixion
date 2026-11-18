//! SQLite access.
//!
//! One connection writes and a few read, in WAL mode, so a long listing never waits for a write.
//! Calls run on Tokio's blocking pool: SQLite is fast enough that a thread hop costs more than
//! the query, but it must never block the async workers. A call waits for a free connection
//! before it takes a thread, so queued calls don't fill the pool that other work needs.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags};

use crate::error::AppError;

/// Schema versions, applied in order. Never edit a shipped entry: append a new one.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial.sql"),
    include_str!("../migrations/002_channel_art.sql"),
    include_str!("../migrations/003_lookup_indexes.sql"),
    include_str!("../migrations/004_stopped_by_hand.sql"),
];

const READERS: usize = 3;

#[derive(Clone)]
pub struct Db {
    writer: Arc<Mutex<Connection>>,
    readers: Arc<Vec<Mutex<Connection>>>,
    /// One permit per connection, waited for asynchronously.
    writer_turn: Arc<tokio::sync::Semaphore>,
    reader_turns: Arc<tokio::sync::Semaphore>,
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -2000;",
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
        Ok(Self {
            writer: Arc::new(Mutex::new(writer)),
            readers: Arc::new(readers),
            writer_turn: Arc::new(tokio::sync::Semaphore::new(1)),
            reader_turns: Arc::new(tokio::sync::Semaphore::new(READERS)),
        })
    }

    /// Runs `f` on the writing connection.
    pub async fn write<T, F>(&self, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, AppError> + Send + 'static,
    {
        let writer = Arc::clone(&self.writer);
        let turn = Arc::clone(&self.writer_turn).acquire_owned().await;
        tokio::task::spawn_blocking(move || {
            let _turn = turn;
            // A panic in an earlier call poisons the lock, but leaves the connection sound: SQLite
            // rolled back what that call had open. Refusing it would stop every write until restart.
            let mut conn = writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            f(&mut conn)
        })
        .await
        .map_err(|error| AppError::internal(format!("database task failed: {error}")))?
    }

    /// Runs `f` on a reading connection: a free one, once there is one.
    pub async fn read<T, F>(&self, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, AppError> + Send + 'static,
    {
        let readers = Arc::clone(&self.readers);
        let turn = Arc::clone(&self.reader_turns).acquire_owned().await;
        tokio::task::spawn_blocking(move || {
            let _turn = turn;
            // Poisoned or not, as for the writer: a read leaves nothing half done.
            let guard = readers
                .iter()
                .find_map(|reader| match reader.try_lock() {
                    Ok(guard) => Some(guard),
                    Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
                    Err(std::sync::TryLockError::WouldBlock) => None,
                })
                .unwrap_or_else(|| readers[0].lock().unwrap_or_else(std::sync::PoisonError::into_inner));
            f(&guard)
        })
        .await
        .map_err(|error| AppError::internal(format!("database task failed: {error}")))?
    }
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    let current: usize = conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?.try_into().unwrap_or(0);
    if current > MIGRATIONS.len() {
        // A newer version made this database: what it added is left alone, and may not be read.
        tracing::warn!(database = current, known = MIGRATIONS.len(), "the database comes from a newer Vixion");
        return Ok(());
    }
    if current > 0 && current < MIGRATIONS.len() {
        backup(conn, current);
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let applied = conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", index + 1));
        if let Err(error) = applied {
            // Nothing of a failed step stays: the next start tries it again from the same point.
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
        tracing::info!(version = index + 1, "database migrated");
    }
    Ok(())
}

/// A copy of the database as it was before an update changed it, next to it: the way back if
/// the update goes wrong. Only the latest copy for each version is kept.
fn backup(conn: &Connection, version: usize) {
    let Ok(Some(path)) = conn.query_row("PRAGMA database_list", [], |row| row.get::<_, Option<String>>(2)) else {
        return;
    };
    if path.is_empty() {
        return;
    }
    let target = format!("{path}.before-v{}", version + 1);
    let _ = std::fs::remove_file(&target);
    match conn.execute("VACUUM INTO ?1", [&target]) {
        Ok(_) => tracing::info!(copy = target, "database saved before updating it"),
        Err(error) => tracing::warn!(%error, "can't save the database before updating it"),
    }
}

/// Milliseconds since the Unix epoch: the only time format stored.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_migration_applies_once_in_order() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, i64::try_from(MIGRATIONS.len()).unwrap());
        // Starting again changes nothing.
        migrate(&conn).unwrap();
    }

    #[test]
    fn an_older_database_keeps_its_rows() {
        let dir = std::env::temp_dir().join(format!("vixion-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vixion.db");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!("BEGIN; {}; PRAGMA user_version = 1; COMMIT;", MIGRATIONS[0])).unwrap();
            conn.execute("INSERT INTO settings (key, value) VALUES ('app', '{\"retention_days\":0}')", []).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        migrate(&conn).unwrap();
        let kept: String =
            conn.query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| row.get(0)).unwrap();
        assert!(kept.contains("\"retention_days\":0"));
        assert!(dir.join("vixion.db.before-v2").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
