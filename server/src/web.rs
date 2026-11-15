//! The interface: built by Bun into `web/dist`, embedded in the binary, served with the
//! security headers every page gets.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

use crate::app::AppState;

#[derive(Embed)]
#[folder = "../web/dist"]
#[allow_missing = true]
#[exclude = "*.map"]
struct Assets;

fn accepts(headers: &HeaderMap, encoding: &str) -> bool {
    headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|part| part.trim().starts_with(encoding)))
}

/// Serves a built file, precompressed when the browser takes it; unknown paths get the app,
/// which routes them itself.
pub async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("media/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (path, found) = match Assets::get(path) {
        Some(file) if !path.is_empty() => (path, Some(file)),
        // A missing file with an extension is a missing file, not a page.
        _ if path.rsplit('/').next().is_some_and(|name| name.contains('.')) => (path, None),
        _ => ("index.html", Assets::get("index.html")),
    };
    let Some(file) = found else {
        let fallback = if Assets::get("index.html").is_none() {
            "The interface was not built: run `bun run build` in web/, then build the server again."
        } else {
            "not found"
        };
        return (StatusCode::NOT_FOUND, fallback).into_response();
    };

    let mut response_headers = HeaderMap::new();
    let mime = file.metadata.mimetype().to_owned();
    if let Ok(value) = HeaderValue::from_str(&mime) {
        response_headers.insert(header::CONTENT_TYPE, value);
    }
    response_headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    let mut body = file.data;
    for (encoding, extension) in [("br", "br"), ("gzip", "gz")] {
        if accepts(&headers, encoding)
            && let Some(compressed) = Assets::get(&format!("{path}.{extension}"))
        {
            body = compressed.data;
            response_headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
            break;
        }
    }
    (StatusCode::OK, response_headers, Body::from(body.into_owned())).into_response()
}

/// Where the browser asks for the video, from the host the page was loaded on.
pub fn media_origin(app: &AppState, headers: &HeaderMap) -> String {
    let header = |name| headers.get(name).and_then(|value| value.to_str().ok());
    // A proxy's own Host is believed only when it is trusted.
    let forwarded = app.config.trust_proxy.then(|| header("x-forwarded-host")).flatten();
    let host = forwarded.or_else(|| header("host")).unwrap_or("localhost");
    app.config.media_origin(host.split(',').next().unwrap_or(host).trim())
}

/// The inline scripts of the page (the theme, set before anything is drawn), allowed by their
/// hash: `'sha256-…'` sources for `script-src`, worked out once from the embedded page.
fn inline_scripts() -> &'static str {
    static SOURCES: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SOURCES.get_or_init(|| {
        Assets::get("index.html")
            .map(|file| inline_script_hashes(&String::from_utf8_lossy(&file.data)))
            .unwrap_or_default()
    })
}

fn inline_script_hashes(html: &str) -> String {
    use base64::Engine as _;
    let mut sources = String::new();
    let mut rest = html;
    while let Some(start) = rest.find("<script") {
        rest = &rest[start..];
        let Some(open_end) = rest.find('>') else { break };
        let tag = &rest[..open_end];
        let body = &rest[open_end + 1..];
        let Some(close) = body.find("</script>") else { break };
        if !tag.contains("src=") && !body[..close].trim().is_empty() {
            let digest = crate::crypto::sha256(&body.as_bytes()[..close]);
            sources.push_str(" 'sha256-");
            sources.push_str(&base64::engine::general_purpose::STANDARD.encode(digest));
            sources.push('\'');
        }
        rest = &body[close..];
    }
    sources
}

/// Headers that keep pages from being framed, sniffed or made to load foreign code.
pub async fn security_headers(State(app): State<AppState>, request: Request, next: Next) -> Response {
    let media = media_origin(&app, request.headers());
    let mut response = next.run(request).await;
    let csp = format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'{inline}; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob: https://static-cdn.jtvnw.net https://cdn.7tv.app https://cdn.betterttv.net \
         https://cdn.frankerfacez.com; font-src 'self'; \
         connect-src 'self' {media}; media-src 'self' blob: {media}; worker-src 'self' blob:; \
         object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        inline = inline_scripts(),
    );
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&csp) {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
    }
    // Trusted Types, reported in the console for now rather than enforced: the page installs a
    // `default` policy that lets only its own and blob: script URLs through.
    headers.insert(
        header::CONTENT_SECURITY_POLICY_REPORT_ONLY,
        HeaderValue::from_static("require-trusted-types-for 'script'; trusted-types default"),
    );
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    );
    headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    response
}

#[cfg(test)]
mod tests {
    use super::inline_script_hashes;

    #[test]
    fn hashes_inline_scripts_only() {
        let html = r#"<head><script>a()</script><script type="module" src="/x.js"></script></head>"#;
        // sha256("a()"), base64.
        assert_eq!(inline_script_hashes(html), " 'sha256-qVpDBgj7bpq5hMAcGp3AOc79J3Y1Z4HvySTwKrWDoy4='");
        assert_eq!(inline_script_hashes("<p>no script</p>"), "");
    }
}
