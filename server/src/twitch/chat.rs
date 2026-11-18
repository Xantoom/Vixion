//! Chat recording, anonymously over IRC.
//!
//! Every message is appended to `chat.ndjson` with the wall-clock time Twitch stamped it with;
//! the player lines it up with the video through the recording's timeline.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls_platform_verifier::ConfigVerifierExt as _;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpStream;
use tokio::sync::watch;

const HOST: &str = "irc.chat.twitch.tv";
const PORT: u16 = 6697;

/// One line of `chat.ndjson`. Keys are short: a busy channel writes millions of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatLine {
    /// Wall-clock time, Unix milliseconds.
    pub t: i64,
    /// `m` message, `a` action (/me), `n` notice (subscription, raid…), `d` one message deleted,
    /// `x` a user's messages cleared (or all, when `u` is empty).
    pub k: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub u: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub n: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub c: String,
    /// Badges, as Twitch sends them: `subscriber/12,premium/1`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub b: String,
    /// What the badges stand for, when Twitch says: `subscriber/14` (exact months), `founder/3`,
    /// `predictions/Team A`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub bi: String,
    /// Twitch emotes and where they are: `25:0-4,12-16/1902:6-10`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub e: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub m: String,
    /// Message ID, or the target of a deletion.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub i: String,
    /// The system text of a notice ("X subscribed for 12 months").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s: String,
}

fn unescape_tag(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some(':') => out.push(';'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Parses one IRC line into a chat line, when it is something worth keeping.
pub fn parse_irc(line: &str) -> Option<ChatLine> {
    let (tags, rest) = match line.strip_prefix('@') {
        Some(tagged) => tagged.split_once(' ')?,
        None => ("", line),
    };
    let rest = rest.strip_prefix(':').unwrap_or(rest);
    let (prefix, rest) = rest.split_once(' ')?;
    let (command, rest) = rest.split_once(' ').unwrap_or((rest, ""));
    let trailing = rest.split_once(" :").map_or("", |(_, text)| text);
    let tag = |name: &str| {
        tags.split(';')
            .find_map(|pair| pair.split_once('=').filter(|(key, _)| *key == name).map(|(_, value)| unescape_tag(value)))
            .unwrap_or_default()
    };
    let login = prefix.split('!').next().unwrap_or_default().to_owned();
    let t = tag("tmi-sent-ts").parse().unwrap_or_else(|_| crate::db::now_ms());
    let base = ChatLine {
        t,
        k: String::new(),
        u: String::new(),
        n: tag("display-name"),
        c: tag("color"),
        b: tag("badges"),
        bi: tag("badge-info"),
        e: tag("emotes"),
        m: String::new(),
        i: tag("id"),
        s: String::new(),
    };
    match command {
        "PRIVMSG" => {
            let (kind, text) = match trailing.strip_prefix("\u{1}ACTION ").and_then(|t| t.strip_suffix('\u{1}')) {
                Some(action) => ("a", action),
                None => ("m", trailing),
            };
            Some(ChatLine { k: kind.into(), u: login, m: text.to_owned(), ..base })
        }
        "USERNOTICE" => {
            Some(ChatLine { k: "n".into(), u: tag("login"), m: trailing.to_owned(), s: tag("system-msg"), ..base })
        }
        "CLEARMSG" => Some(ChatLine { k: "d".into(), u: tag("login"), i: tag("target-msg-id"), ..base }),
        "CLEARCHAT" => Some(ChatLine { k: "x".into(), u: trailing.to_owned(), i: String::new(), ..base }),
        _ => None,
    }
}

/// Records `login`'s chat into `path` until `stop` turns true. Reconnects on its own.
pub async fn record(login: String, path: std::path::PathBuf, mut stop: watch::Receiver<bool>, count: Arc<AtomicU64>) {
    let file = match tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await {
        Ok(file) => file,
        Err(error) => {
            tracing::error!(%login, %error, "can't open the chat file");
            return;
        }
    };
    let mut out = BufWriter::new(file);
    let mut backoff = Duration::from_secs(1);
    while !*stop.borrow() {
        match session(&login, &mut out, &mut stop, &count).await {
            Ok(()) => break,
            Err(error) => {
                tracing::warn!(%login, %error, "chat disconnected, reconnecting");
                tokio::select! {
                    () = tokio::time::sleep(backoff) => {}
                    // The recording ended without saying so (it crashed): nothing left to wait for.
                    changed = stop.changed() => if changed.is_err() { break },
                }
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
        }
    }
    if let Err(error) = out.flush().await {
        tracing::error!(%login, %error, "can't write the chat file");
    }
}

/// Longest wait for a line before the connection is taken for dead.
const SILENCE: Duration = Duration::from_secs(360);

/// Resolves once the recording asks to stop, or once it is gone without asking (it crashed):
/// a closed channel would otherwise wake the loop again and again.
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|stop| *stop).await;
}

async fn session(
    login: &str,
    out: &mut BufWriter<tokio::fs::File>,
    stop: &mut watch::Receiver<bool>,
    count: &AtomicU64,
) -> std::io::Result<()> {
    let config = rustls::ClientConfig::with_platform_verifier().map_err(std::io::Error::other)?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let name = ServerName::try_from(HOST).map_err(std::io::Error::other)?;
    let connect = async {
        let tcp = TcpStream::connect((HOST, PORT)).await?;
        connector.connect(name, tcp).await
    };
    // Connecting is bounded in time, and stopping doesn't wait for it.
    let tls = tokio::select! {
        tls = tokio::time::timeout(Duration::from_secs(10), connect) => tls??,
        () = stopped(stop) => return Ok(()),
    };
    let (reader, mut writer) = tokio::io::split(tls);
    let nick = format!("justinfan{}", 10_000 + u32::from_le_bytes(crate::crypto::random_bytes::<4>()) % 89_999);
    writer
        .write_all(
            format!(
                "CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS SCHMOOPIIE\r\nNICK {nick}\r\nJOIN #{login}\r\n"
            )
            .as_bytes(),
        )
        .await?;
    tracing::debug!(%login, "chat connected");
    let mut lines = BufReader::new(reader).lines();
    let mut flush = tokio::time::interval(Duration::from_secs(2));
    let mut serialized = Vec::with_capacity(512);
    // Twitch pings every five minutes: silence for longer means the link is dead. The deadline
    // moves only when a line arrives, not every time another branch wakes the loop.
    let silence = tokio::time::sleep(SILENCE);
    tokio::pin!(silence);
    loop {
        tokio::select! {
            () = stopped(stop) => {
                out.flush().await?;
                return Ok(());
            }
            _ = flush.tick() => out.flush().await?,
            () = &mut silence => return Err(std::io::ErrorKind::TimedOut.into()),
            line = lines.next_line() => {
                silence.as_mut().reset(tokio::time::Instant::now() + SILENCE);
                let Some(line) = line? else { return Err(std::io::ErrorKind::UnexpectedEof.into()) };
                if let Some(payload) = line.strip_prefix("PING") {
                    writer.write_all(format!("PONG{payload}\r\n").as_bytes()).await?;
                    continue;
                }
                if line.contains(" RECONNECT") && !line.contains("PRIVMSG") {
                    return Err(std::io::Error::other("server asked to reconnect"));
                }
                if let Some(chat) = parse_irc(&line) {
                    serialized.clear();
                    if serde_json::to_writer(&mut serialized, &chat).is_ok() {
                        serialized.push(b'\n');
                        out.write_all(&serialized).await?;
                        if chat.k == "m" || chat.k == "a" {
                            count.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_messages() {
        let line = "@badge-info=subscriber/14;badges=subscriber/12;color=#FF4500;display-name=Some\\sOne;emotes=25:0-4;id=abc;tmi-sent-ts=1700000000000 \
            :someone!someone@someone.tmi.twitch.tv PRIVMSG #chan :Kappa hello";
        let chat = parse_irc(line).expect("message");
        assert_eq!((chat.k.as_str(), chat.u.as_str(), chat.n.as_str()), ("m", "someone", "Some One"));
        assert_eq!((chat.m.as_str(), chat.e.as_str(), chat.t), ("Kappa hello", "25:0-4", 1_700_000_000_000));
        assert_eq!((chat.b.as_str(), chat.bi.as_str()), ("subscriber/12", "subscriber/14"));
        let action = parse_irc(":a!a@a PRIVMSG #chan :\u{1}ACTION waves\u{1}").expect("action");
        assert_eq!((action.k.as_str(), action.m.as_str()), ("a", "waves"));
    }
}
