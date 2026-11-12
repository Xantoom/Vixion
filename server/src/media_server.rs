//! Serving recordings: byte ranges straight from disk, behind signed links.
//!
//! The media routes carry no cookie and need none: a link is valid for one recording until it
//! expires, which is what lets them live on another origin than the interface (so a Cloudflare
//! Tunnel in front of the interface never carries video).

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::app::AppState;
use crate::error::{AppError, AppResult};
use crate::media::fmp4::FragmentIndex;
use crate::recorder::storage;

const CHUNK: usize = 256 * 1024;

/// Seek indexes of recordings being written, by stream, extended as they grow.
type LiveIndexes = std::sync::Mutex<std::collections::HashMap<i64, std::sync::Arc<std::sync::Mutex<FragmentIndex>>>>;

fn live_indexes() -> &'static LiveIndexes {
    static INDEXES: std::sync::OnceLock<LiveIndexes> = std::sync::OnceLock::new();
    INDEXES.get_or_init(Default::default)
}

/// The recording's whole fragments so far and an index of them: (bytes of the file served, index).
async fn live_view(id: i64, path: std::path::PathBuf) -> AppResult<(u64, bytes::Bytes)> {
    let index = {
        let mut indexes = live_indexes().lock().map_err(|_| AppError::internal("index lock"))?;
        if indexes.len() > 16 {
            indexes.clear();
        }
        std::sync::Arc::clone(indexes.entry(id).or_default())
    };
    tokio::task::spawn_blocking(move || -> std::io::Result<(u64, bytes::Bytes)> {
        let file = std::fs::File::open(&path)?;
        let length = file.metadata()?.len();
        let mut index = index.lock().map_err(|_| std::io::Error::other("index lock"))?;
        index.extend(&file, length)?;
        Ok((index.complete, bytes::Bytes::from(index.mfra())))
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
    .map_err(AppError::from)
}

pub fn router() -> Router<AppState> {
    Router::new().route("/media/{id}/{expires}/{signature}/{name}", get(serve).head(serve).options(preflight))
}

fn cors(headers: &mut HeaderMap) {
    // The signature is the credential; any page holding the link may read it.
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges, ETag"),
    );
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("cross-origin"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
}

async fn preflight() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    cors(headers);
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, HEAD, OPTIONS"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Range, If-Range, If-None-Match"));
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    response
}

#[derive(Deserialize)]
pub struct MediaQuery {
    #[serde(default)]
    dl: Option<u8>,
}

/// Parses a single `bytes=a-b`, `bytes=a-` or `bytes=-n` range against a length.
fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') || length == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let suffix: u64 = suffix.parse().ok()?;
            (length.saturating_sub(suffix), length - 1)
        }
        (start, "") => (start.parse().ok()?, length - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(length - 1)),
    };
    (start <= end && start < length).then_some((start, end))
}

async fn serve(
    State(app): State<AppState>,
    method: Method,
    Path((id, expires, signature, name)): Path<(i64, i64, String, String)>,
    Query(query): Query<MediaQuery>,
    request_headers: HeaderMap,
) -> Response {
    match serve_file(&app, &method, id, expires, &signature, &name, query.dl.is_some(), &request_headers).await {
        Ok(response) => response,
        Err(error) => {
            let mut response = error.into_response();
            cors(response.headers_mut());
            response
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn serve_file(
    app: &AppState,
    method: &Method,
    id: i64,
    expires: i64,
    signature: &str,
    name: &str,
    download: bool,
    request_headers: &HeaderMap,
) -> AppResult<Response> {
    if !app.keys.verify_media(&format!("video:{id}"), expires, signature) {
        return Err(AppError::new(StatusCode::FORBIDDEN, "expired_link", "this link expired: reload the page"));
    }
    let (dir, part, status): (String, i64, String) = app
        .db
        .read(move |conn| {
            Ok(conn.query_row("SELECT dir, part, status FROM streams WHERE id = ?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?)
        })
        .await?;
    let folder = storage::stream_dir(&app.config.streams_dir(), &dir).ok_or_else(AppError::not_found)?;
    let path = folder.join(storage::video_file(part));
    let mut file = tokio::fs::File::open(&path).await?;
    let meta = file.metadata().await?;
    let growing = status == "recording";
    if !growing && let Ok(mut indexes) = live_indexes().lock() {
        indexes.remove(&id);
    }
    // A recording still being written is served as a whole file: its fragments so far, then an index.
    let (on_disk, tail) = if growing { live_view(id, path.clone()).await? } else { (meta.len(), bytes::Bytes::new()) };
    let length = on_disk + tail.len() as u64;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_secs());
    let etag = format!("\"{length:x}-{modified:x}\"");

    let mut headers = HeaderMap::new();
    cors(&mut headers);
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if growing { "no-store" } else { "private, max-age=86400" }),
    );
    if !growing && let Ok(value) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, value);
    }
    if download {
        let ascii: String =
            name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' { c } else { '_' }).collect();
        if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{ascii}\"")) {
            headers.insert(header::CONTENT_DISPOSITION, value);
        }
    }
    if !growing && request_headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, headers).into_response());
    }

    // A range only applies when If-Range (if sent) still names this version of the file.
    let if_range_ok =
        request_headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).is_none_or(|value| value == etag);
    let range = request_headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|_| if_range_ok)
        .map(|value| parse_range(value, length));
    let (status, start, end) = match range {
        None => (StatusCode::OK, 0, length.saturating_sub(1)),
        Some(Some((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end),
        Some(None) => {
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{length}")) {
                headers.insert(header::CONTENT_RANGE, value);
            }
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response());
        }
    };
    let size = if length == 0 { 0 } else { end - start + 1 };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    if status == StatusCode::PARTIAL_CONTENT
        && let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{length}"))
    {
        headers.insert(header::CONTENT_RANGE, value);
    }
    if method == Method::HEAD || size == 0 {
        return Ok((status, headers).into_response());
    }
    // The part on disk, then the part of the index the range covers.
    let from_disk = if start < on_disk { (end + 1).min(on_disk) - start } else { 0 };
    let tail_from = usize::try_from(start.saturating_sub(on_disk)).unwrap_or(0);
    let tail_to = usize::try_from((end + 1).saturating_sub(on_disk)).unwrap_or(0).min(tail.len());
    let tail = tail.slice(tail_from.min(tail_to)..tail_to);
    let tail_stream = futures_util::stream::iter((!tail.is_empty()).then(|| Ok::<_, std::io::Error>(tail)));
    if from_disk == 0 {
        return Ok((status, headers, Body::from_stream(tail_stream)).into_response());
    }
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let disk = ReaderStream::with_capacity(file.take(from_disk), CHUNK);
    let body = Body::from_stream(futures_util::StreamExt::chain(disk, tail_stream));
    Ok((status, headers, body).into_response())
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=500-5000", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
    }
}
