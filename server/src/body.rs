//! Answers read with a ceiling: a server, or any device on the local network, could otherwise
//! send an endless body and fill memory.

use bytes::{Bytes, BytesMut};

/// A playlist, a description or an error page.
pub const TEXT: usize = 4 << 20;
/// An API's JSON answer: emote sets can be large.
pub const JSON: usize = 16 << 20;
/// A video segment or a picture.
pub const MEDIA: usize = 64 << 20;

#[derive(Debug)]
pub enum BodyError {
    Http(reqwest::Error),
    /// Longer than the ceiling given, in bytes.
    TooLarge(usize),
}

impl std::fmt::Display for BodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(error) => write!(f, "{error}"),
            Self::TooLarge(limit) => write!(f, "the answer is larger than {limit} bytes"),
        }
    }
}

impl std::error::Error for BodyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Http(error) => Some(error),
            Self::TooLarge(_) => None,
        }
    }
}

impl From<reqwest::Error> for BodyError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

/// The whole body, unless it is longer than `limit` bytes.
pub async fn read(mut response: reqwest::Response, limit: usize) -> Result<Bytes, BodyError> {
    let announced = response.content_length().and_then(|length| usize::try_from(length).ok());
    if announced.is_some_and(|length| length > limit) {
        return Err(BodyError::TooLarge(limit));
    }
    let mut body = BytesMut::with_capacity(announced.unwrap_or(0));
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > limit {
            return Err(BodyError::TooLarge(limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}

/// The body as text, unless it is longer than `limit` bytes. Anything not UTF-8 is replaced.
pub async fn text(response: reqwest::Response, limit: usize) -> Result<String, BodyError> {
    let bytes = read(response, limit).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
