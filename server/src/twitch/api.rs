//! Twitch's web API: channel information, live status, and the playback token for HLS.
//!
//! This is the API twitch.tv itself uses, with its public client ID: no developer application or
//! secret is needed. It is not documented, so every response is read defensively.

use std::time::Duration;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::hls::{self, Variant};

const CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL: &str = "https://gql.twitch.tv/gql";
const PLAYBACK_TOKEN_HASH: &str = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
/// A desktop browser: some edges answer differently to unknown clients.
pub const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
/// The most users one query may ask about.
const BATCH: usize = 100;
pub const BATCH_SIZE: usize = BATCH;

#[derive(Debug)]
pub enum TwitchError {
    Http(reqwest::Error),
    Status(u16),
    /// Too many requests: Twitch asks to wait, for this long when it says.
    RateLimited(Option<Duration>),
    /// Twitch wants a browser-computed integrity token: not something a server can provide.
    Integrity,
    /// The token was rejected (expired, revoked, or not a token).
    BadToken,
    Unexpected(String),
}

impl std::fmt::Display for TwitchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(error) => write!(f, "network: {error}"),
            Self::Status(code) => write!(f, "Twitch answered {code}"),
            Self::RateLimited(_) => f.write_str("Twitch asked to slow down"),
            Self::Integrity => f.write_str("Twitch asked for an integrity check"),
            Self::BadToken => f.write_str("the Twitch token was refused"),
            Self::Unexpected(what) => write!(f, "unexpected answer: {what}"),
        }
    }
}

impl std::error::Error for TwitchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Http(error) => Some(error),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for TwitchError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl From<crate::body::BodyError> for TwitchError {
    fn from(error: crate::body::BodyError) -> Self {
        match error {
            crate::body::BodyError::Http(error) => Self::Http(error),
            too_large @ crate::body::BodyError::TooLarge(_) => Self::Unexpected(too_large.to_string()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStream {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub game: Option<Game>,
    #[serde(default, rename = "previewImageURL")]
    pub preview_image_url: Option<String>,
    #[serde(default)]
    pub viewers_count: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Game {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub login: String,
    pub display_name: String,
    #[serde(default, rename = "profileImageURL")]
    pub profile_image_url: Option<String>,
    #[serde(default, rename = "bannerImageURL")]
    pub banner_image_url: Option<String>,
    #[serde(default)]
    pub stream: Option<LiveStream>,
}

impl Channel {
    /// Live, and not a rerun of an old broadcast.
    pub fn live(&self) -> Option<&LiveStream> {
        self.stream.as_ref().filter(|stream| stream.kind.as_deref().is_none_or(|kind| kind == "live"))
    }
}

const CHANNEL_FIELDS: &str = "id login displayName profileImageURL(width: 150) bannerImageURL \
    stream { id title createdAt type viewersCount game { name } previewImageURL(width: 640, height: 360) }";

#[derive(Clone)]
pub struct TwitchApi {
    http: reqwest::Client,
}

impl TwitchApi {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    async fn gql(&self, body: Value, token: Option<&str>) -> Result<Value, TwitchError> {
        let mut request =
            self.http.post(GQL).header("Client-ID", CLIENT_ID).json(&body).timeout(Duration::from_secs(15));
        if let Some(token) = token {
            request = request.header("Authorization", format!("OAuth {token}"));
        }
        let response = request.send().await?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TwitchError::BadToken);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()?.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            return Err(TwitchError::RateLimited(wait));
        }
        if !status.is_success() {
            return Err(TwitchError::Status(status.as_u16()));
        }
        let bytes = crate::body::read(response, crate::body::JSON).await?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|error| TwitchError::Unexpected(format!("not JSON: {error}")))?;
        if let Some(errors) = value.get("errors").and_then(Value::as_array) {
            let text = errors.iter().filter_map(|e| e.get("message")?.as_str()).collect::<Vec<_>>().join("; ");
            if text.contains("integrity") {
                return Err(TwitchError::Integrity);
            }
            if value.get("data").is_none_or(Value::is_null) {
                return Err(TwitchError::Unexpected(text));
            }
        }
        Ok(value)
    }

    async fn channels(&self, field: &str, keys: &[String]) -> Result<Vec<Channel>, TwitchError> {
        let mut out = Vec::with_capacity(keys.len());
        for chunk in keys.chunks(BATCH) {
            let kind = if field == "ids" { "[ID!]" } else { "[String!]" };
            let query = format!("query($keys: {kind}) {{ users({field}: $keys) {{ {CHANNEL_FIELDS} }} }}");
            let value = self.gql(json!({ "query": query, "variables": { "keys": chunk } }), None).await?;
            let users = value.pointer("/data/users").and_then(Value::as_array).cloned().unwrap_or_default();
            out.extend(
                users.into_iter().filter(|user| !user.is_null()).filter_map(|user| serde_json::from_value(user).ok()),
            );
        }
        Ok(out)
    }

    /// Channels by Twitch user ID; IDs survive renames, so monitoring uses them. At most
    /// [`BATCH_SIZE`] per call: the caller paces the batches.
    pub async fn channels_by_id(&self, ids: &[String]) -> Result<Vec<Channel>, TwitchError> {
        self.channels("ids", ids).await
    }

    /// A channel by its login (the name in its URL).
    pub async fn channel_by_login(&self, login: &str) -> Result<Option<Channel>, TwitchError> {
        Ok(self.channels("logins", &[login.to_owned()]).await?.into_iter().next())
    }

    /// The signed token the video servers want, for one player type.
    async fn playback_token(
        &self,
        login: &str,
        player: &str,
        token: Option<&str>,
    ) -> Result<(String, String), TwitchError> {
        let body = json!({
            "operationName": "PlaybackAccessToken",
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": PLAYBACK_TOKEN_HASH } },
            "variables": { "isLive": true, "login": login, "isVod": false, "vodID": "", "playerType": player, "platform": "web" },
        });
        let value = self.gql(body, token).await?;
        let access = value.pointer("/data/streamPlaybackAccessToken").filter(|v| !v.is_null());
        let Some(access) = access else { return Err(TwitchError::Unexpected("no playback token".into())) };
        let signature = access.get("signature").and_then(Value::as_str);
        let value = access.get("value").and_then(Value::as_str);
        match (value, signature) {
            (Some(value), Some(signature)) => Ok((value.to_owned(), signature.to_owned())),
            _ => Err(TwitchError::Unexpected("incomplete playback token".into())),
        }
    }

    /// The renditions of a live channel, for one player type.
    pub async fn variants(
        &self,
        login: &str,
        player: &str,
        token: Option<&str>,
        h264_only: bool,
    ) -> Result<Vec<Variant>, TwitchError> {
        let (value, signature) = self.playback_token(login, player, token).await?;
        let codecs = if h264_only { "h264" } else { "av1,h265,h264" };
        let p = u32::from_le_bytes(crate::crypto::random_bytes::<4>()) % 9_999_999;
        let response = self
            .http
            .get(format!("https://usher.ttvnw.net/api/v2/channel/hls/{login}.m3u8"))
            .query(&[
                ("token", value.as_str()),
                ("sig", signature.as_str()),
                ("allow_source", "true"),
                ("allow_audio_only", "true"),
                ("fast_bread", "true"),
                ("playlist_include_framerate", "true"),
                // Without it, Enhanced Broadcasting renditions (1440p HEVC, AV1) are left out.
                ("multigroup_video", "true"),
                ("reassignments_supported", "true"),
                ("supported_codecs", codecs),
                ("platform", "web"),
                ("p", &p.to_string()),
            ])
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        match response.status().as_u16() {
            200 => Ok(hls::parse_multivariant(&crate::body::text(response, crate::body::TEXT).await?)),
            // Offline or not yet playable.
            404 => Ok(Vec::new()),
            403 => Err(TwitchError::BadToken),
            code => Err(TwitchError::Status(code)),
        }
    }

    pub async fn get_text(&self, url: &str) -> Result<String, TwitchError> {
        let response = self.http.get(url).timeout(Duration::from_secs(10)).send().await?;
        if !response.status().is_success() {
            return Err(TwitchError::Status(response.status().as_u16()));
        }
        Ok(crate::body::text(response, crate::body::TEXT).await?)
    }

    pub async fn get_bytes(&self, url: &str, timeout: Duration) -> Result<bytes::Bytes, TwitchError> {
        let response = self.http.get(url).timeout(timeout).send().await?;
        if !response.status().is_success() {
            return Err(TwitchError::Status(response.status().as_u16()));
        }
        Ok(crate::body::read(response, crate::body::MEDIA).await?)
    }
}

/// A channel found by name, for the search box.
#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub login: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub followers: i64,
    pub live: bool,
    pub game: Option<String>,
}

/// What a channel page shows of a channel, watched or not.
#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub banner_url: Option<String>,
    pub description: Option<String>,
    pub followers: i64,
    pub partner: bool,
    pub created_at: Option<i64>,
    pub live: Option<ProfileLive>,
    pub last_broadcast: Option<i64>,
    /// Past broadcasts Twitch still keeps.
    pub videos: Vec<Video>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileLive {
    pub title: Option<String>,
    pub game: Option<String>,
    pub viewers: i64,
    pub since: Option<i64>,
    pub preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Video {
    pub id: String,
    pub title: String,
    pub duration_s: i64,
    pub created_at: Option<i64>,
    pub views: i64,
    pub thumbnail_url: Option<String>,
    pub game: Option<String>,
}

fn text(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn number(value: &Value, pointer: &str) -> i64 {
    value.pointer(pointer).and_then(Value::as_i64).unwrap_or(0)
}

fn time(value: &Value, pointer: &str) -> Option<i64> {
    value.pointer(pointer).and_then(Value::as_str).and_then(super::hls::parse_iso8601)
}

impl TwitchApi {
    /// Channels whose name starts like the query, the most followed first.
    pub async fn search(&self, query: &str) -> Result<Vec<SearchHit>, TwitchError> {
        let body = json!({
            "query": "query($q: String!) { searchUsers(userQuery: $q, first: 8) { edges { node { \
                login displayName profileImageURL(width: 70) followers { totalCount } stream { id game { name } } } } } }",
            "variables": { "q": query },
        });
        let value = self.gql(body, None).await?;
        let edges = value.pointer("/data/searchUsers/edges").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(edges
            .iter()
            .filter_map(|edge| {
                let node = edge.get("node")?;
                Some(SearchHit {
                    login: text(node, "/login")?,
                    display_name: text(node, "/displayName")?,
                    avatar_url: text(node, "/profileImageURL"),
                    followers: number(node, "/followers/totalCount"),
                    live: node.get("stream").is_some_and(|stream| !stream.is_null()),
                    game: text(node, "/stream/game/name"),
                })
            })
            .collect())
    }

    /// A channel's public page: who they are, whether they are live, their recent broadcasts.
    pub async fn profile(&self, login: &str) -> Result<Option<Profile>, TwitchError> {
        let body = json!({
            "query": "query($login: String!) { user(login: $login) { id login displayName description \
                profileImageURL(width: 300) bannerImageURL createdAt followers { totalCount } roles { isPartner } \
                lastBroadcast { startedAt } \
                stream { id title createdAt type viewersCount game { name } previewImageURL(width: 640, height: 360) } \
                videos(first: 12, type: ARCHIVE, sort: TIME) { edges { node { id title lengthSeconds createdAt \
                viewCount previewThumbnailURL(width: 640, height: 360) game { name } } } } } }",
            "variables": { "login": login },
        });
        let value = self.gql(body, None).await?;
        let Some(user) = value.pointer("/data/user").filter(|user| !user.is_null()) else { return Ok(None) };
        let (Some(id), Some(login), Some(display_name)) =
            (text(user, "/id"), text(user, "/login"), text(user, "/displayName"))
        else {
            return Ok(None);
        };
        let live = user.get("stream").filter(|stream| {
            !stream.is_null() && stream.get("type").and_then(Value::as_str).is_none_or(|kind| kind == "live")
        });
        let videos = user.pointer("/videos/edges").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(Some(Profile {
            id,
            login,
            display_name,
            avatar_url: text(user, "/profileImageURL"),
            banner_url: text(user, "/bannerImageURL"),
            description: text(user, "/description"),
            followers: number(user, "/followers/totalCount"),
            partner: user.pointer("/roles/isPartner").and_then(Value::as_bool).unwrap_or(false),
            created_at: time(user, "/createdAt"),
            live: live.map(|stream| ProfileLive {
                title: text(stream, "/title"),
                game: text(stream, "/game/name"),
                viewers: number(stream, "/viewersCount"),
                since: time(stream, "/createdAt"),
                preview_url: text(stream, "/previewImageURL"),
            }),
            last_broadcast: time(user, "/lastBroadcast/startedAt"),
            videos: videos
                .iter()
                .filter_map(|edge| {
                    let node = edge.get("node")?;
                    Some(Video {
                        id: text(node, "/id")?,
                        title: text(node, "/title").unwrap_or_default(),
                        duration_s: number(node, "/lengthSeconds"),
                        created_at: time(node, "/createdAt"),
                        views: number(node, "/viewCount"),
                        // Twitch gives a placeholder while a broadcast is still running.
                        thumbnail_url: text(node, "/previewThumbnailURL").filter(|url| !url.contains("404_processing")),
                        game: text(node, "/game/name"),
                    })
                })
                .collect(),
        }))
    }

    /// Chat badge images, `set/version` to URL: the global ones, overridden by the channel's own.
    /// Badge pictures and titles ("1-Year Subscriber"), by `set/version`: global ones, then the channel's.
    pub async fn badges(&self, channel_id: &str) -> Result<HashMap<String, [String; 2]>, TwitchError> {
        const FIELDS: &str = "setID version title imageURL(size: DOUBLE)";
        let body = json!({
            "query": format!("query($id: ID!) {{ badges {{ {FIELDS} }} user(id: $id) {{ broadcastBadges {{ {FIELDS} }} }} }}"),
            "variables": { "id": channel_id },
        });
        let value = self.gql(body, None).await?;
        let mut out = HashMap::new();
        for pointer in ["/data/badges", "/data/user/broadcastBadges"] {
            for badge in value.pointer(pointer).and_then(Value::as_array).into_iter().flatten() {
                if let (Some(set), Some(version), Some(url)) =
                    (text(badge, "/setID"), text(badge, "/version"), text(badge, "/imageURL"))
                {
                    let title = text(badge, "/title").unwrap_or_default();
                    out.insert(format!("{set}/{version}"), [url, title]);
                }
            }
        }
        Ok(out)
    }
}

/// Logins are 1 to 25 letters, digits and underscores.
pub fn valid_login(login: &str) -> bool {
    (1..=25).contains(&login.len()) && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}
