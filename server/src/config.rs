//! Process configuration, read once from the environment at start-up.
//!
//! Everything that changes how the process is wired (addresses, folders, certificates) lives here.
//! What an administrator tunes while the app runs (retention, codecs, tokens) lives in the
//! database instead; see [`crate::settings`].

use std::net::SocketAddr;
use std::path::PathBuf;

use instant_acme::LetsEncrypt;

/// How recordings reach the browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaMode {
    /// Served by the main listener, under `/media`. Fine on a local network, but a Cloudflare
    /// Tunnel in front of the main port would then carry video.
    Same,
    /// A second plain HTTP listener; something else (Caddy, Traefik) terminates TLS in front of it.
    Http,
    /// A second listener with its own certificate, from Let's Encrypt or from files.
    Https,
}

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
    pub http_addr: SocketAddr,
    pub media_mode: MediaMode,
    pub media_addr: SocketAddr,
    /// Origin the browser uses for media, such as `https://media.example.com:8443`. Empty in
    /// [`MediaMode::Same`], where media URLs are relative.
    pub media_public_url: String,
    /// The media host name, for certificates and dynamic DNS.
    pub media_domain: String,
    pub tls: Option<TlsSource>,
    /// Keeps the media domain's A record on the current public address (Cloudflare only).
    pub ddns: bool,
    /// The port the media listener is reached on from outside (`VIXION_MEDIA_PUBLIC_PORT`).
    pub media_public_port: u16,
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

fn addr(name: &str, default: &str) -> Result<SocketAddr, ConfigError> {
    let value = var(name).unwrap_or_else(|| default.to_owned());
    value.parse().map_err(|_| ConfigError(format!("{name}: `{value}` is not an address like 0.0.0.0:8080")))
}

impl Config {
    /// Reads `VIXION_*` variables. Every one has a default that works on a single machine.
    pub fn from_env() -> Result<Self, ConfigError> {
        let data_dir = PathBuf::from(var("VIXION_DATA_DIR").unwrap_or_else(|| "./data".to_owned()));
        let recordings_dir = var("VIXION_RECORDINGS_DIR").map_or_else(|| data_dir.join("streams"), PathBuf::from);
        let http_addr = addr("VIXION_HTTP_ADDR", "0.0.0.0:8080")?;
        let media_addr = addr("VIXION_MEDIA_ADDR", "0.0.0.0:8443")?;
        let media_domain = var("VIXION_MEDIA_DOMAIN").unwrap_or_default();
        let media_public_port = var("VIXION_MEDIA_PUBLIC_PORT")
            .map(|port| port.parse::<u16>().map_err(|_| ConfigError(format!("VIXION_MEDIA_PUBLIC_PORT: `{port}`"))))
            .transpose()?
            .unwrap_or(media_addr.port());

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

        let media_mode = match var("VIXION_MEDIA_MODE").as_deref() {
            Some("same") => MediaMode::Same,
            Some("http") => MediaMode::Http,
            Some("https") => MediaMode::Https,
            Some(other) => return Err(ConfigError(format!("VIXION_MEDIA_MODE: `{other}` is not same, http or https"))),
            None if tls.is_some() && !media_domain.is_empty() => MediaMode::Https,
            None => MediaMode::Same,
        };
        if media_mode == MediaMode::Https {
            if media_domain.is_empty() {
                return Err(ConfigError("VIXION_MEDIA_DOMAIN is required for HTTPS media".into()));
            }
            if tls.is_none() {
                return Err(ConfigError(
                    "HTTPS media needs VIXION_CLOUDFLARE_API_TOKEN (Let's Encrypt) or VIXION_TLS_CERT and VIXION_TLS_KEY"
                        .into(),
                ));
            }
        }

        let media_public_url = match (&media_mode, var("VIXION_MEDIA_PUBLIC_URL")) {
            (MediaMode::Same, _) => String::new(),
            (_, Some(url)) => url.trim_end_matches('/').to_owned(),
            (MediaMode::Https, None) if media_public_port == 443 => format!("https://{media_domain}"),
            (MediaMode::Https, None) => format!("https://{media_domain}:{media_public_port}"),
            (MediaMode::Http, None) => {
                return Err(ConfigError("VIXION_MEDIA_PUBLIC_URL is required when VIXION_MEDIA_MODE=http".into()));
            }
        };

        let upnp = flag("VIXION_UPNP");
        if upnp && media_mode == MediaMode::Same {
            // The main listener carries the interface in plain HTTP: never opened to the internet.
            return Err(ConfigError("VIXION_UPNP opens the media port: set VIXION_MEDIA_MODE to https".into()));
        }

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
            media_mode,
            media_addr,
            media_public_url,
            media_domain,
            ddns: flag("VIXION_DDNS"),
            media_public_port,
            upnp,
            tls,
            log_json: var("VIXION_LOG_FORMAT").is_some_and(|format| format.eq_ignore_ascii_case("json")),
            trust_proxy: flag("VIXION_TRUST_PROXY"),
            log_filter: var("VIXION_LOG").unwrap_or_else(|| "info".to_owned()),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("vixion.db")
    }

    pub fn streams_dir(&self) -> PathBuf {
        self.recordings_dir.clone()
    }
}
