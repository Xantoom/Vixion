//! One error type for the whole server.
//!
//! An error carries the HTTP status it answers with and a stable code the interface translates.
//! Internal details are logged, never sent: the client sees `internal` and nothing else.

use std::borrow::Cow;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    /// Stable, machine-readable: the interface maps it to a translated sentence.
    pub code: &'static str,
    pub message: Cow<'static, str>,
    /// What caused it, when it comes from another error: kept for `source()`, never sent.
    pub source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self { status, code, message: message.into(), source: None }
    }

    /// Keeps the error this one comes from.
    #[must_use]
    pub fn with_source(mut self, source: impl std::error::Error + Send + Sync + 'static) -> Self {
        self.source = Some(Box::new(source));
        self
    }

    pub fn internal(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    pub fn bad_request(code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "not found")
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "sign in first")
    }

    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "not allowed")
    }

    pub fn conflict(code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status.as_u16(), self.message)
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_deref().map(|source| source as &(dyn std::error::Error + 'static))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let message = if self.status.is_server_error() {
            tracing::error!(code = self.code, "{}", self.message);
            Cow::Borrowed("internal error")
        } else {
            self.message
        };
        (self.status, axum::Json(serde_json::json!({ "error": self.code, "message": message }))).into_response()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::QueryReturnedNoRows => Self::not_found().with_source(error),
            rusqlite::Error::SqliteFailure(ref inner, _)
                if inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
            {
                Self::conflict("exists", "already exists").with_source(error)
            }
            other => Self::internal(format!("database: {other}")).with_source(other),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Self::not_found().with_source(error);
        }
        Self::internal(format!("io: {error}")).with_source(error)
    }
}

impl From<reqwest::Error> for AppError {
    fn from(error: reqwest::Error) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "upstream", format!("twitch: {error}")).with_source(error)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(format!("json: {error}")).with_source(error)
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_what_caused_it() {
        let error = AppError::from(std::io::Error::new(std::io::ErrorKind::StorageFull, "disk full"));
        let source = std::error::Error::source(&error).expect("a source");
        assert_eq!(source.to_string(), "disk full");
    }
}
