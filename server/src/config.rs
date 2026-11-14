//! Process configuration, read once from the environment at start-up.
//!
//! Everything that changes how the process is wired (addresses, folders, certificates) lives here.
//! What an administrator tunes while the app runs (retention, codecs, tokens) lives in the
//! database instead; see [`crate::settings`].

use std::net::SocketAddr;
use std::path::PathBuf;

use instant_acme::LetsEncrypt;

/// Where the media listener's certificate comes from.
#[derive(Debug, Clone)]
pub enum TlsSource {
    /// Let's Encrypt through a DNS-01 challenge on Cloudflare: no port 80 or 443 needed.
    AcmeCloudflare {
        email: String,
        api_token: String,
        /// The ACME directory: Let's Encrypt, its staging server, or another CA.
        directory: String,
    },
    /// PEM files the administrator manages.
    Files { cert: PathBuf, key: PathBuf },
}

#[derive(Debug, Clone)]
pub struct Config {
    /// The database, the secret key and certificates (`VIXION_DATA_DIR`).
    pub data_dir: PathBuf,
    /// The recordings (`VIXION_RECORDINGS_DIR`), by default `streams` in the data folder.
    pub recordings_dir: PathBuf,
    /// The interface and its API (`--port`).
    pub http_addr: SocketAddr,
    /// The video, on a port of its own so that it never goes through a tunnel (`--video-port`).
    pub media_addr: SocketAddr,
    /// Origin the browser uses for media, such as `https://media.example.com` behind a proxy
    /// (`VIXION_MEDIA_PUBLIC_URL`). Without it, see [`Config::media_origin`].
    pub media_public_url: Option<String>,
    /// The media host name, for certificates and dynamic DNS.
    pub media_domain: String,
    /// Set when the media listener serves HTTPS itself.
    pub tls: Option<TlsSource>,
    /// Keeps the media domain's A record on the current public address (Cloudflare only).
    pub ddns: bool,
    /// The port the media listener is reached on from outside, when the router or Docker maps
    /// another one (`VIXION_MEDIA_PUBLIC_PORT`).
    pub media_public_port: Option<u16>,
    /// Asks the router to forward that port here by UPnP, as Plex does (`VIXION_UPNP`).
    pub upnp: bool,
    pub log_json: bool,
    /// Whether a reverse proxy (Cloudflare, Caddy, nginx…) stands in front: only then are the
    /// client address headers it adds believed (`VIXION_TRUST_PROXY`).
    pub trust_proxy: bool,
    pub log_filter: String,
    /// The `auth-token` cookie of a Twitch account, from `VIXION_TWITCH_TOKEN`,
    /// `VIXION_TWITCH_TOKEN_FILE` or `--twitch-token`. With Turbo or a subscription, no ads.
    pub twitch_token: Option<String>,
}

/// A Twitch `auth-token` as pasted: an optional `OAuth ` prefix, then letters and digits.
pub fn parse_twitch_token(raw: &str) -> Result<String, ConfigError> {
    let token = raw.trim().trim_start_matches("OAuth ").trim();
    if token.is_empty() || token.len() > 64 || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ConfigError("the Twitch token must be the auth-token cookie: about 30 letters and digits".into()));
    }
    Ok(token.to_owned())
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

fn flag(name: &str) -> bool {
    var(name).is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

/// The interface's port by default: away from those self-hosted apps usually take.
pub const HTTP_PORT: u16 = 6280;
pub const VIDEO_PORT: u16 = 6281;

/// A port (`6280`), listened to on every interface, or an address (`127.0.0.1:6280`).
pub fn parse_addr(value: &str) -> Result<SocketAddr, ConfigError> {
    let value = value.trim();
    match value.parse::<u16>() {
        Ok(port) => Ok(SocketAddr::from(([0, 0, 0, 0], port))),
        Err(_) => {
            value.parse().map_err(|_| ConfigError(format!("`{value}` is not a port or an address like 127.0.0.1:6280")))
        }
    }
}

impl Config {
    /// Reads `VIXION_*` variables. Only the Twitch token is needed, and only to serve; the rest
    /// is for reaching the video from the internet.
    pub fn from_env() -> Result<Self, ConfigError> {
        let data_dir = PathBuf::from(var("VIXION_DATA_DIR").unwrap_or_else(|| "./data".to_owned()));
        let recordings_dir = var("VIXION_RECORDINGS_DIR").map_or_else(|| data_dir.join("streams"), PathBuf::from);
        let http_addr = SocketAddr::from(([0, 0, 0, 0], HTTP_PORT));
        let media_addr = SocketAddr::from(([0, 0, 0, 0], VIDEO_PORT));
        let media_domain = var("VIXION_MEDIA_DOMAIN").unwrap_or_default();
        let media_public_port = var("VIXION_MEDIA_PUBLIC_PORT")
            .map(|port| port.parse::<u16>().map_err(|_| ConfigError(format!("VIXION_MEDIA_PUBLIC_PORT: `{port}`"))))
            .transpose()?;

        let tls = if let (Some(cert), Some(key)) = (var("VIXION_TLS_CERT"), var("VIXION_TLS_KEY")) {
            Some(TlsSource::Files { cert: cert.into(), key: key.into() })
        } else if let Some(api_token) = var("VIXION_CLOUDFLARE_API_TOKEN") {
            let email = var("VIXION_ACME_EMAIL").unwrap_or_default();
            let directory = var("VIXION_ACME_DIRECTORY").unwrap_or_else(|| {
                let staging = flag("VIXION_ACME_STAGING");
                let server = if staging { LetsEncrypt::Staging } else { LetsEncrypt::Production };
                server.url().to_owned()
            });
            Some(TlsSource::AcmeCloudflare { email, api_token, directory })
        } else {
            None
        };

        if tls.is_some() && media_domain.is_empty() {
            return Err(ConfigError("HTTPS video needs its domain: set VIXION_MEDIA_DOMAIN".into()));
        }
        if tls.is_none() && !media_domain.is_empty() {
            return Err(ConfigError(
                "VIXION_MEDIA_DOMAIN serves the video in HTTPS: set VIXION_CLOUDFLARE_API_TOKEN (Let's Encrypt) \
                 or VIXION_TLS_CERT and VIXION_TLS_KEY"
                    .into(),
            ));
        }
        let media_public_url = var("VIXION_MEDIA_PUBLIC_URL").map(|url| url.trim_end_matches('/').to_owned());

        let twitch_token = match (var("VIXION_TWITCH_TOKEN"), var("VIXION_TWITCH_TOKEN_FILE")) {
            (Some(token), _) => {
                Some(parse_twitch_token(&token).map_err(|error| ConfigError(format!("VIXION_TWITCH_TOKEN: {error}")))?)
            }
            (None, Some(path)) => {
                let text = std::fs::read_to_string(&path)
                    .map_err(|error| ConfigError(format!("VIXION_TWITCH_TOKEN_FILE: {path}: {error}")))?;
                Some(
                    parse_twitch_token(&text)
                        .map_err(|error| ConfigError(format!("VIXION_TWITCH_TOKEN_FILE: {error}")))?,
                )
            }
            (None, None) => None,
        };

        Ok(Self {
            twitch_token,
            data_dir,
            recordings_dir,
            http_addr,
            media_addr,
            media_public_url,
            media_domain,
            ddns: flag("VIXION_DDNS"),
            media_public_port,
            upnp: flag("VIXION_UPNP"),
            tls,
            log_json: var("VIXION_LOG_FORMAT").is_some_and(|format| format.eq_ignore_ascii_case("json")),
            trust_proxy: flag("VIXION_TRUST_PROXY"),
            log_filter: var("VIXION_LOG").unwrap_or_else(|| "info".to_owned()),
        })
    }

    /// The video port seen from outside.
    pub fn video_public_port(&self) -> u16 {
        self.media_public_port.unwrap_or(self.media_addr.port())
    }

    /// Where the browser asks for the video, seen from a page on `host` (its `Host` header): the
    /// address set, the HTTPS domain, or else the same host at the video port.
    pub fn media_origin(&self, host: &str) -> String {
        let port = self.video_public_port();
        if let Some(url) = &self.media_public_url {
            return url.clone();
        }
        if !self.media_domain.is_empty() {
            return if port == 443 {
                format!("https://{}", self.media_domain)
            } else {
                format!("https://{}:{port}", self.media_domain)
            };
        }
        // The host without its port, brackets kept around an IPv6 address.
        let name = match host.rsplit_once(':') {
            Some((name, port)) if !port.contains(']') && !name.is_empty() => name,
            _ => host,
        };
        format!("http://{name}:{port}")
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("vixion.db")
    }

    pub fn streams_dir(&self) -> PathBuf {
        self.recordings_dir.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            data_dir: PathBuf::new(),
            recordings_dir: PathBuf::new(),
            http_addr: parse_addr("6280").unwrap(),
            media_addr: parse_addr("127.0.0.1:6281").unwrap(),
            media_public_url: None,
            media_domain: String::new(),
            tls: None,
            ddns: false,
            media_public_port: None,
            upnp: false,
            log_json: false,
            trust_proxy: false,
            log_filter: String::new(),
            twitch_token: None,
        }
    }

    #[test]
    fn the_video_is_found_next_to_the_interface() {
        let mut config = config();
        assert_eq!(config.media_origin("nas.lan:6280"), "http://nas.lan:6281");
        assert_eq!(config.media_origin("[::1]:6280"), "http://[::1]:6281");
        assert_eq!(config.media_origin("[::1]"), "http://[::1]:6281");
        assert_eq!(config.media_origin("192.168.1.50"), "http://192.168.1.50:6281");
        config.media_public_port = Some(443);
        config.media_domain = "media.example.com".into();
        assert_eq!(config.media_origin("nas.lan:6280"), "https://media.example.com");
        config.media_public_url = Some("https://video.example.com".into());
        assert_eq!(config.media_origin("nas.lan:6280"), "https://video.example.com");
    }

    #[test]
    fn reads_ports_and_addresses() {
        assert_eq!(parse_addr("7000").unwrap().to_string(), "0.0.0.0:7000");
        assert_eq!(parse_addr("127.0.0.1:7000").unwrap().to_string(), "127.0.0.1:7000");
        assert!(parse_addr("seven").is_err());
    }
}
