//! HTTPS for the media listener: a certificate from Let's Encrypt (DNS-01 on Cloudflare, so no
//! port 80 or 443 is needed) or from files, swapped in place when renewed. Optionally keeps the
//! media domain's DNS record on the current public address.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, NewAccount, NewOrder, OrderStatus,
    RetryPolicy,
};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

use crate::alerts::Level;
use crate::app::AppState;
use crate::config::TlsSource;
use crate::db::now_ms;

/// Renew once this share of the certificate's lifetime has passed: certificates last from six
/// days to ninety, depending on the authority and the year.
const RENEW_AT: f64 = 2.0 / 3.0;

#[derive(Debug, Default)]
pub struct CertSlot(RwLock<Option<Arc<CertifiedKey>>>);

impl ResolvesServerCert for CertSlot {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.0.read().ok()?.clone()
    }
}

impl CertSlot {
    fn set(&self, key: CertifiedKey) {
        if let Ok(mut slot) = self.0.write() {
            *slot = Some(Arc::new(key));
        }
    }

    fn is_set(&self) -> bool {
        self.0.read().is_ok_and(|slot| slot.is_some())
    }
}

fn certified_key(chain_pem: &[u8], key_pem: &[u8]) -> Result<CertifiedKey, String> {
    let chain = rustls_pemfile::certs(&mut &*chain_pem).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let key = rustls_pemfile::private_key(&mut &*key_pem).map_err(|e| e.to_string())?.ok_or("no private key")?;
    let provider = rustls::crypto::ring::default_provider();
    CertifiedKey::from_der(chain, key, &provider).map_err(|e| e.to_string())
}

/// Accepted TLS connections, for `axum::serve`.
pub struct TlsListener {
    connections: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    local: SocketAddr,
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.connections.recv().await {
            Some(connection) => connection,
            // The acceptor stopped: wait forever, the process is shutting down.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.local)
    }
}

/// Binds the media address with TLS. Handshakes run on their own tasks, so a slow client
/// never holds up others.
pub async fn listen(addr: SocketAddr, slot: Arc<CertSlot>) -> std::io::Result<TlsListener> {
    let listener = TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    let mut config = rustls::ServerConfig::builder().with_no_client_auth().with_cert_resolver(slot);
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let (sender, connections) = mpsc::channel(64);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, peer)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let _ = tcp.set_nodelay(true);
            let (acceptor, sender) = (acceptor.clone(), sender.clone());
            tokio::spawn(async move {
                if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await {
                    let _ = sender.send((stream, peer)).await;
                }
            });
        }
    });
    Ok(TlsListener { connections, local })
}

struct AcmeFiles {
    account: PathBuf,
    chain: PathBuf,
    key: PathBuf,
}

fn acme_files(data_dir: &Path, domain: &str, directory: &str) -> AcmeFiles {
    let dir = data_dir.join("certificates");
    // One account per ACME directory: moving from staging to production must not reuse it.
    let tag: String = crate::crypto::sha256(directory.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect();
    AcmeFiles {
        account: dir.join(format!("acme-account-{tag}.json")),
        chain: dir.join(format!("{domain}.crt")),
        key: dir.join(format!("{domain}.key")),
    }
}

/// Keeps the certificate fresh: loads it, obtains or renews it, and checks again when it is due
/// for renewal, or daily.
pub async fn maintain(app: AppState, slot: Arc<CertSlot>) {
    let Some(source) = app.config.tls.clone() else { return };
    const DAY: u64 = 24 * 3600;
    loop {
        let result = match &source {
            TlsSource::Files { cert, key } => load_files(cert, key, &slot).await.map(|()| None),
            TlsSource::AcmeCloudflare { email, api_token, directory } => {
                acme(&app, &slot, email, api_token, directory).await.map(Some)
            }
        };
        let wait = match result {
            Ok(renew_at) => {
                app.alerts.resolve("certificate").await;
                renew_at.map_or(DAY, |at| u64::try_from(at - now_ms() / 1000).unwrap_or(0).clamp(60, DAY))
            }
            Err(error) => {
                app.alerts.raise(Level::Error, "certificate", format!("Media certificate: {error}")).await;
                // Retry sooner while there is no certificate at all.
                if slot.is_set() { 3600 } else { 600 }
            }
        };
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
}

/// When a certificate chain is due for renewal, in seconds since 1970.
fn renewal_time(chain_pem: &[u8]) -> Option<i64> {
    let first = rustls_pemfile::certs(&mut &*chain_pem).next()?.ok()?;
    let (from, until) = validity(&first)?;
    Some(from + ((until - from) as f64 * RENEW_AT) as i64)
}

async fn load_files(cert: &Path, key: &Path, slot: &CertSlot) -> Result<(), String> {
    let chain = tokio::fs::read(cert).await.map_err(|e| format!("{}: {e}", cert.display()))?;
    let key = tokio::fs::read(key).await.map_err(|e| format!("{}: {e}", key.display()))?;
    slot.set(certified_key(&chain, &key)?);
    Ok(())
}

/// Makes sure a valid certificate is installed; returns when it should be renewed.
async fn acme(app: &AppState, slot: &CertSlot, email: &str, api_token: &str, directory: &str) -> Result<i64, String> {
    let domain = app.config.media_domain.clone();
    let files = acme_files(&app.config.data_dir, &domain, directory);
    let renew_at = tokio::fs::read(&files.chain).await.ok().and_then(|pem| renewal_time(&pem));
    if let Some(renew_at) = renew_at.filter(|&at| now_ms() / 1000 < at) {
        if !slot.is_set() {
            load_files(&files.chain, &files.key, slot).await?;
        }
        return Ok(renew_at);
    }
    tracing::info!(%domain, %directory, "requesting a certificate");
    let cloudflare = Cloudflare::new(app.http.clone(), api_token);
    let (chain, key) = issue(&files, &domain, email, directory, &cloudflare).await?;
    if let Some(parent) = files.chain.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    write_private(&files.key, key.as_bytes()).await?;
    write_private(&files.chain, chain.as_bytes()).await?;
    slot.set(certified_key(chain.as_bytes(), key.as_bytes())?);
    let renew_at = renewal_time(chain.as_bytes()).ok_or("unreadable certificate")?;
    tracing::info!(%domain, renew_in_s = renew_at - now_ms() / 1000, "certificate installed");
    Ok(renew_at)
}

/// A DER element: (tag, contents, rest of the input).
fn der(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, mut rest) = rest.split_first()?;
    let length = if first < 0x80 {
        usize::from(first)
    } else {
        let count = usize::from(first & 0x7F);
        let (bytes, after) = rest.split_at_checked(count)?;
        rest = after;
        bytes.iter().try_fold(0usize, |length, &byte| length.checked_mul(256)?.checked_add(usize::from(byte)))?
    };
    let (contents, rest) = rest.split_at_checked(length)?;
    Some((tag, contents, rest))
}

/// Seconds since 1970 for a UTCTime (`YYMMDDHHMMSSZ`) or GeneralizedTime (`YYYYMMDDHHMMSSZ`).
fn der_time(tag: u8, text: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(text).ok()?.strip_suffix('Z')?;
    let (year, rest) = match tag {
        0x17 => {
            let short: i64 = text.get(..2)?.parse().ok()?;
            (if short < 50 { 2000 + short } else { 1900 + short }, text.get(2..)?)
        }
        0x18 => (text.get(..4)?.parse().ok()?, text.get(4..)?),
        _ => return None,
    };
    let field = |at: usize| -> Option<i64> { rest.get(at..at + 2)?.parse().ok() };
    let (month, day, hour, minute, second) = (field(0)?, field(2)?, field(4)?, field(6)?, field(8)?);
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

/// A certificate's validity period, in seconds since 1970: (not before, not after).
fn validity(certificate: &[u8]) -> Option<(i64, i64)> {
    let (_, certificate, _) = der(certificate)?;
    let (_, tbs, _) = der(certificate)?;
    let mut rest = tbs;
    // An explicit version comes first, tagged [0].
    if rest.first() == Some(&0xA0) {
        rest = der(rest)?.2;
    }
    let rest = der(rest)?.2; // serial number
    let rest = der(rest)?.2; // signature algorithm
    let rest = der(rest)?.2; // issuer
    let (_, period, _) = der(rest)?;
    let (from_tag, from, rest) = der(period)?;
    let (until_tag, until, _) = der(rest)?;
    Some((der_time(from_tag, from)?, der_time(until_tag, until)?))
}

/// Writes a file only the owner can read, created that way (never readable by others, even for a
/// moment) and swapped in whole, so that a crash never leaves half a key.
async fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let (path, bytes) = (path.to_owned(), bytes.to_vec());
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::Write as _;
        let temporary = path.with_extension("tmp");
        let _ = std::fs::remove_file(&temporary);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

async fn issue(
    files: &AcmeFiles,
    domain: &str,
    email: &str,
    directory: &str,
    dns: &Cloudflare,
) -> Result<(String, String), String> {
    let error = |e: instant_acme::Error| e.to_string();
    let saved: Option<AccountCredentials> =
        tokio::fs::read(&files.account).await.ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let identifiers = [Identifier::Dns(domain.to_owned())];
    let mut order = match saved {
        Some(credentials) => {
            let account = Account::builder().map_err(error)?.from_credentials(credentials).await.map_err(error)?;
            match account.new_order(&NewOrder::new(&identifiers)).await {
                Ok(order) => order,
                Err(refused) => {
                    // The authority forgot the account, or it was deactivated: start a new one.
                    tracing::warn!(error = %refused, "the saved ACME account was refused: registering a new one");
                    let account = register(files, email, directory).await?;
                    account.new_order(&NewOrder::new(&identifiers)).await.map_err(error)?
                }
            }
        }
        None => {
            register(files, email, directory).await?.new_order(&NewOrder::new(&identifiers)).await.map_err(error)?
        }
    };
    let mut records = Vec::new();
    let mut authorizations = order.authorizations();
    while let Some(result) = authorizations.next().await {
        let mut authorization = result.map_err(error)?;
        match authorization.status {
            AuthorizationStatus::Pending => {}
            AuthorizationStatus::Valid => continue,
            other => return Err(format!("authorization is {other:?}")),
        }
        let mut challenge = authorization.challenge(ChallengeType::Dns01).ok_or("no DNS challenge offered")?;
        let name = format!("_acme-challenge.{domain}");
        let value = challenge.key_authorization().dns_value();
        records.push(dns.create_txt(&name, &value).await?);
        // Cloudflare answers with the new record within seconds.
        tokio::time::sleep(Duration::from_secs(20)).await;
        challenge.set_ready().await.map_err(error)?;
    }
    let status = order.poll_ready(&RetryPolicy::default()).await.map_err(error);
    for record in &records {
        dns.delete(record).await;
    }
    let status = status?;
    if status != OrderStatus::Ready {
        return Err(format!("order is {status:?}"));
    }
    let key = order.finalize().await.map_err(error)?;
    let chain = order.poll_certificate(&RetryPolicy::default()).await.map_err(error)?;
    Ok((chain, key))
}

/// Registers a new ACME account and saves its credentials.
async fn register(files: &AcmeFiles, email: &str, directory: &str) -> Result<Account, String> {
    let error = |e: instant_acme::Error| e.to_string();
    let contact = format!("mailto:{email}");
    let contacts: Vec<&str> = if email.is_empty() { Vec::new() } else { vec![contact.as_str()] };
    let (account, credentials) = Account::builder()
        .map_err(error)?
        .create(
            &NewAccount { contact: &contacts, terms_of_service_agreed: true, only_return_existing: false },
            directory.to_owned(),
            None,
        )
        .await
        .map_err(error)?;
    if let Some(parent) = files.account.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec(&credentials).map_err(|e| e.to_string())?;
    write_private(&files.account, &json).await?;
    Ok(account)
}

/// The bits of Cloudflare's DNS API needed for challenges and dynamic DNS.
struct Cloudflare {
    http: reqwest::Client,
    token: String,
}

struct Record {
    zone: String,
    id: String,
}

const CLOUDFLARE: &str = "https://api.cloudflare.com/client/v4";

/// Cloudflare's API, or a stand-in for tests (`VIXION_CLOUDFLARE_API`).
fn cloudflare_api() -> String {
    std::env::var("VIXION_CLOUDFLARE_API").unwrap_or_else(|_| CLOUDFLARE.to_owned())
}

impl Cloudflare {
    fn new(http: reqwest::Client, token: &str) -> Self {
        Self { http, token: token.to_owned() }
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let mut request = self.http.request(method, format!("{}{path}", cloudflare_api())).bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let value: Value = request.send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            let errors = value.get("errors").map(Value::to_string).unwrap_or_default();
            return Err(format!("Cloudflare refused: {errors}"));
        }
        Ok(value)
    }

    /// The zone holding `name`: the longest matching suffix.
    async fn zone_of(&self, name: &str) -> Result<String, String> {
        let labels: Vec<&str> = name.split('.').collect();
        for start in 0..labels.len().saturating_sub(1) {
            let candidate = labels[start..].join(".");
            let value = self.call(reqwest::Method::GET, &format!("/zones?name={candidate}"), None).await?;
            if let Some(id) = value.pointer("/result/0/id").and_then(Value::as_str) {
                return Ok(id.to_owned());
            }
        }
        Err(format!("no Cloudflare zone for {name}: does the token have Zone:Read and DNS:Edit on it?"))
    }

    async fn create_txt(&self, name: &str, content: &str) -> Result<Record, String> {
        let zone = self.zone_of(name).await?;
        let body = json!({ "type": "TXT", "name": name, "content": content, "ttl": 60 });
        let value = self.call(reqwest::Method::POST, &format!("/zones/{zone}/dns_records"), Some(body)).await?;
        let id = value.pointer("/result/id").and_then(Value::as_str).ok_or("no record ID")?.to_owned();
        Ok(Record { zone, id })
    }

    async fn delete(&self, record: &Record) {
        let path = format!("/zones/{}/dns_records/{}", record.zone, record.id);
        if let Err(error) = self.call(reqwest::Method::DELETE, &path, None).await {
            tracing::warn!(%error, "can't remove the challenge record");
        }
    }

    /// Points `name` at `ip`, DNS only (not proxied: Cloudflare must not carry the video).
    async fn upsert_a(&self, name: &str, ip: &str) -> Result<bool, String> {
        let zone = self.zone_of(name).await?;
        let found =
            self.call(reqwest::Method::GET, &format!("/zones/{zone}/dns_records?type=A&name={name}"), None).await?;
        let body = json!({ "type": "A", "name": name, "content": ip, "ttl": 300, "proxied": false });
        match found.pointer("/result/0") {
            Some(record) if record.get("content").and_then(Value::as_str) == Some(ip) => Ok(false),
            Some(record) => {
                let id = record.get("id").and_then(Value::as_str).ok_or("no record ID")?;
                self.call(reqwest::Method::PUT, &format!("/zones/{zone}/dns_records/{id}"), Some(body)).await?;
                Ok(true)
            }
            None => {
                self.call(reqwest::Method::POST, &format!("/zones/{zone}/dns_records"), Some(body)).await?;
                Ok(true)
            }
        }
    }
}

/// Keeps the media domain on the current public IPv4 address, checked every ten minutes.
pub async fn dynamic_dns(app: AppState) {
    let Some(TlsSource::AcmeCloudflare { api_token, .. }) = app.config.tls.clone() else { return };
    let cloudflare = Cloudflare::new(app.http.clone(), &api_token);
    loop {
        let address = async {
            let text = app.http.clone().get("https://1.1.1.1/cdn-cgi/trace").send().await.ok()?.text().await.ok()?;
            text.lines().find_map(|line| line.strip_prefix("ip=")).map(str::to_owned)
        }
        .await;
        match address {
            Some(ip) if ip.parse::<std::net::Ipv4Addr>().is_ok() => {
                match cloudflare.upsert_a(&app.config.media_domain, &ip).await {
                    Ok(true) => tracing::info!(%ip, domain = %app.config.media_domain, "media address updated"),
                    Ok(false) => app.alerts.resolve("ddns").await,
                    Err(error) => app.alerts.raise(Level::Warning, "ddns", format!("Dynamic DNS: {error}")).await,
                }
            }
            _ => tracing::debug!("public address unknown"),
        }
        tokio::time::sleep(Duration::from_secs(600)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_certificate_times() {
        assert_eq!(der_time(0x17, b"261112162620Z"), Some(1_794_500_780));
        assert_eq!(der_time(0x17, b"990228000000Z"), Some(920_160_000));
        assert_eq!(der_time(0x18, b"20491231235959Z"), Some(2_524_607_999));
        assert_eq!(der_time(0x17, b"2611121626"), None);
    }
}
