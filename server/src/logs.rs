//! Logging: to stdout for `docker logs`, and to a ring buffer the admin console reads live.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::broadcast;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

/// Lines kept for the console: about a day of normal activity, a few hundred kilobytes.
const KEPT: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub id: u64,
    pub at: i64,
    pub level: &'static str,
    pub target: String,
    pub message: String,
    /// Structured fields, as `key=value` pairs.
    pub fields: String,
}

/// The console's buffer and its live feed.
#[derive(Clone)]
pub struct LogBuffer {
    inner: Arc<Mutex<(u64, VecDeque<LogEntry>)>>,
    feed: broadcast::Sender<LogEntry>,
}

impl LogBuffer {
    fn new() -> Self {
        let (feed, _) = broadcast::channel(256);
        Self { inner: Arc::new(Mutex::new((0, VecDeque::with_capacity(KEPT)))), feed }
    }

    pub fn recent(&self) -> Vec<LogEntry> {
        self.inner.lock().map(|guard| guard.1.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.feed.subscribe()
    }

    fn push(&self, mut entry: LogEntry) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.0 += 1;
            entry.id = guard.0;
            if guard.1.len() == KEPT {
                guard.1.pop_front();
            }
            guard.1.push_back(entry.clone());
        }
        // Nobody listening is the usual case.
        let _ = self.feed.send(entry);
    }
}

#[derive(Default)]
struct Fields {
    message: String,
    rest: String,
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.rest, "{}{}={value}", if self.rest.is_empty() { "" } else { " " }, field.name());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            let _ = write!(self.rest, "{}{}={value:?}", if self.rest.is_empty() { "" } else { " " }, field.name());
        }
    }
}

struct BufferLayer(LogBuffer);

impl<S: Subscriber> Layer<S> for BufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut fields = Fields::default();
        event.record(&mut fields);
        self.0.push(LogEntry {
            id: 0,
            at: crate::db::now_ms(),
            level: match *metadata.level() {
                Level::ERROR => "error",
                Level::WARN => "warn",
                Level::INFO => "info",
                Level::DEBUG => "debug",
                Level::TRACE => "trace",
            },
            target: metadata.target().to_owned(),
            message: fields.message,
            fields: fields.rest,
        });
    }
}

/// Installs the global subscriber. `filter` follows `RUST_LOG` syntax, such as `info,vixion=debug`.
pub fn init(filter: &str, json: bool) -> LogBuffer {
    let buffer = LogBuffer::new();
    // Dependencies are quiet unless asked: their info lines are noise here.
    let filter = EnvFilter::try_new(format!("warn,vixion={filter}"))
        .or_else(|_| EnvFilter::try_new(filter))
        .unwrap_or_else(|_| EnvFilter::new("warn,vixion=info"));
    let console = BufferLayer(buffer.clone());
    let registry = tracing_subscriber::registry().with(filter).with(console);
    if json {
        registry.with(tracing_subscriber::fmt::layer().json().flatten_event(true).with_current_span(false)).init();
    } else {
        // Colours only for a person at a terminal, not in `docker logs` or a journal.
        let ansi = std::io::IsTerminal::is_terminal(&std::io::stdout());
        registry.with(tracing_subscriber::fmt::layer().with_target(false).with_ansi(ansi).compact()).init();
    }
    buffer
}
