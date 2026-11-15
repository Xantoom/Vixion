//! What a chat replay needs beyond the messages: badge pictures, and the emotes of 7TV, BetterTTV
//! and FrankerFaceZ, which Twitch doesn't mark in the message (its own emotes are in the tags).
//!
//! Lists are fetched per channel and kept an hour: they change rarely and every viewer of a
//! recording asks for the same ones. Expired lists are dropped, not just refreshed. A provider that fails only leaves its emotes out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::api::TwitchApi;

const KEEP: Duration = Duration::from_secs(3600);
/// After a provider failed: asked again soon rather than an hour without its emotes.
const KEEP_INCOMPLETE: Duration = Duration::from_secs(120);
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Default, Serialize)]
pub struct ChatAssets {
    /// `set/version` to picture.
    pub badges: HashMap<String, String>,
    /// Word to picture, at 1x and 2x.
    pub emotes: HashMap<String, [String; 2]>,
}

/// When it was fetched, how long it stays, and the assets.
type Cached = (Instant, Duration, Arc<ChatAssets>);

#[derive(Default)]
pub struct ChatAssetCache {
    entries: Mutex<HashMap<String, Cached>>,
}

impl ChatAssetCache {
    /// Lets expired lists go: otherwise every channel ever recorded keeps its emotes for good.
    pub fn purge(&self) {
        if let Ok(mut map) = self.entries.lock() {
            map.retain(|_, (at, keep, _)| at.elapsed() < *keep);
            map.shrink_to_fit();
        }
    }

    pub async fn get(&self, twitch: &TwitchApi, http: &reqwest::Client, channel_id: &str) -> Arc<ChatAssets> {
        let cached = self.entries.lock().ok().and_then(|map| map.get(channel_id).cloned());
        if let Some((at, keep, assets)) = cached
            && at.elapsed() < keep
        {
            return assets;
        }
        let (badges, seventv, bttv, ffz) = tokio::join!(
            twitch.badges(channel_id),
            seventv(http, channel_id),
            bttv(http, channel_id),
            ffz(http, channel_id),
        );
        let complete = badges.is_ok() && ffz.is_some() && bttv.is_some() && seventv.is_some();
        let mut assets = ChatAssets { badges: badges.unwrap_or_default(), emotes: HashMap::new() };
        // Later sets win a name: the channel's own over globals, 7TV over the older services.
        for set in [ffz, bttv, seventv] {
            assets.emotes.extend(set.unwrap_or_default());
        }
        let assets = Arc::new(assets);
        let keep = if complete { KEEP } else { KEEP_INCOMPLETE };
        if let Ok(mut map) = self.entries.lock() {
            map.retain(|_, (at, keep, _)| at.elapsed() < *keep);
            map.insert(channel_id.to_owned(), (Instant::now(), keep, Arc::clone(&assets)));
        }
        assets
    }
}

/// A provider's answer: Some(None) when it has nothing for this channel, None when it failed.
async fn fetch(http: &reqwest::Client, url: &str) -> Option<Option<Value>> {
    let response = http.get(url).timeout(TIMEOUT).send().await.ok()?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Some(None);
    }
    if !response.status().is_success() {
        return None;
    }
    let bytes = crate::body::read(response, crate::body::JSON).await.ok()?;
    serde_json::from_slice(&bytes).ok().map(Some)
}

fn str_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

async fn seventv(http: &reqwest::Client, channel_id: &str) -> Option<Vec<(String, [String; 2])>> {
    let user = format!("https://7tv.io/v3/users/twitch/{channel_id}");
    let (global, channel) = tokio::join!(fetch(http, "https://7tv.io/v3/emote-sets/global"), fetch(http, &user));
    let (global, channel) = (global?, channel?);
    let sets = [global.as_ref(), channel.as_ref().and_then(|user| user.get("emote_set"))];
    sets.into_iter()
        .flatten()
        .filter_map(|set| set.get("emotes")?.as_array())
        .flatten()
        .filter_map(|emote| {
            let name = str_at(emote, "name")?;
            let id = emote.pointer("/data/id").and_then(Value::as_str).or_else(|| str_at(emote, "id"))?;
            let url = |size: u8| format!("https://cdn.7tv.app/emote/{id}/{size}x.webp");
            Some((name.to_owned(), [url(1), url(2)]))
        })
        .collect::<Vec<_>>()
        .into()
}

async fn bttv(http: &reqwest::Client, channel_id: &str) -> Option<Vec<(String, [String; 2])>> {
    let user = format!("https://api.betterttv.net/3/cached/users/twitch/{channel_id}");
    let (global, channel) =
        tokio::join!(fetch(http, "https://api.betterttv.net/3/cached/emotes/global"), fetch(http, &user));
    let (global, channel) = (global?, channel?);
    let lists = [
        global.as_ref(),
        channel.as_ref().and_then(|user| user.get("sharedEmotes")),
        channel.as_ref().and_then(|user| user.get("channelEmotes")),
    ];
    lists
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|emote| {
            let (name, id) = (str_at(emote, "code")?, str_at(emote, "id")?);
            let url = |size: u8| format!("https://cdn.betterttv.net/emote/{id}/{size}x");
            Some((name.to_owned(), [url(1), url(2)]))
        })
        .collect::<Vec<_>>()
        .into()
}

async fn ffz(http: &reqwest::Client, channel_id: &str) -> Option<Vec<(String, [String; 2])>> {
    let url = format!("https://api.betterttv.net/3/cached/frankerfacez/users/twitch/{channel_id}");
    let Some(list) = fetch(http, &url).await? else { return Some(Vec::new()) };
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|emote| {
            let name = str_at(emote, "code")?;
            let images = emote.get("images")?;
            let small = str_at(images, "1x")?.to_owned();
            let large = str_at(images, "2x").map_or_else(|| small.clone(), str::to_owned);
            Some((name.to_owned(), [small, large]))
        })
        .collect::<Vec<_>>()
        .into()
}
