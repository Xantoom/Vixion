//! The JSON API the interface talks to, under `/api`.

mod account;
mod admin;
mod streamers;
pub(crate) mod streams;

pub use streams::{media_resource, set_global_retention};

use axum::Router;
use axum::middleware;
use axum::routing::{get, patch, post};

use crate::app::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/setup", get(account::setup_needed).post(account::setup))
        .route("/auth/login", post(account::login))
        .route("/auth/logout", post(account::logout))
        .route("/me", get(account::me).patch(account::update_me))
        .route("/streamers", get(streamers::list).post(streamers::add))
        .route("/streamers/{id}", patch(streamers::update).delete(streamers::remove))
        .route("/channels/{login}", get(streamers::channel))
        .route("/twitch/search", get(streamers::search))
        .route("/streamers/{id}/stop", post(streamers::stop))
        .route("/streams/{id}", get(streams::detail).patch(streams::update).delete(streams::remove))
        .route("/streams/{id}/chat", get(streams::chat_window))
        .route("/streams/{id}/chat-assets", get(streamers::chat_assets))
        .route("/streams/{id}/chat.json", get(streams::chat_json))
        .route("/streams/{id}/chat.ass", get(streams::chat_ass))
        .route("/streams/{id}/thumbnail", get(streams::thumbnail))
        .route("/stats", get(admin::stats))
        .route("/settings", get(admin::get_settings).put(admin::put_settings))
        .route("/settings/twitch-token", get(admin::reveal_twitch_token))
        .route("/users", get(admin::list_users).post(admin::create_user))
        .route("/users/{id}", patch(admin::update_user).delete(admin::delete_user))
        .route("/roles", get(admin::list_roles).post(admin::create_role))
        .route("/roles/{id}", patch(admin::update_role).delete(admin::delete_role))
        .route("/logs", get(admin::logs))
        .route("/logs/live", get(admin::logs_live))
        .route("/alerts", get(admin::alerts))
        .route("/alerts/{id}/dismiss", post(admin::dismiss_alert))
        .layer(middleware::from_fn(crate::auth::require_app_header))
}

/// Accepts a JSON body field that may be absent (leave as is) or null (clear).
pub(crate) fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}
