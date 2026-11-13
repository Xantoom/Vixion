//! Secrets: the instance key, signed media links, and encryption of stored tokens.
//!
//! A 32-byte key is generated on first start in the data folder. Every other key is derived
//! from it, so rotating it (deleting the file) signs everyone out and voids every media link.

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::error::AppError;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct Keys {
    media: [u8; 32],
    storage: [u8; 32],
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // The operating system's generator does not fail on supported platforms.
    getrandom::fill(&mut bytes).expect("the system random generator is available");
    bytes
}

/// A random token for cookies and the like, URL-safe.
pub fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

/// Compares two secrets in time that doesn't depend on where they differ.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

fn derive(master: &[u8], purpose: &str) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(master).expect("HMAC accepts any key length");
    mac.update(purpose.as_bytes());
    mac.finalize().into_bytes().into()
}

impl Keys {
    /// Loads the instance key, creating it (readable by the owner only) on first start.
    pub fn load_or_create(path: &Path) -> Result<Self, AppError> {
        let master = match std::fs::read(path) {
            Ok(bytes) if bytes.len() == 32 => bytes,
            Ok(_) => return Err(AppError::internal(format!("{} is not a 32-byte key", path.display()))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let bytes = random_bytes::<32>().to_vec();
                write_private(path, &bytes)?;
                tracing::info!(path = %path.display(), "created the instance key");
                bytes
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self { media: derive(&master, "vixion media links"), storage: derive(&master, "vixion stored secrets") })
    }

    /// Signs a media link: what it gives access to, and until when (Unix seconds).
    pub fn sign_media(&self, resource: &str, expires: i64) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.media).expect("HMAC accepts any key length");
        mac.update(format!("{resource}\n{expires}").as_bytes());
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }

    /// Checks a media link's signature, in constant time, and that it has not expired.
    pub fn verify_media(&self, resource: &str, expires: i64, signature: &str) -> bool {
        if expires < crate::db::now_ms() / 1000 {
            return false;
        }
        let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else { return false };
        let mut mac = HmacSha256::new_from_slice(&self.media).expect("HMAC accepts any key length");
        mac.update(format!("{resource}\n{expires}").as_bytes());
        mac.verify_slice(&signature).is_ok()
    }

    /// Decrypts a secret stored by an earlier version (nonce and ciphertext, base64).
    pub fn open(&self, sealed: &str) -> Option<String> {
        let bytes = URL_SAFE_NO_PAD.decode(sealed).ok()?;
        let (nonce, ciphertext) = bytes.split_at_checked(12)?;
        let cipher = ChaCha20Poly1305::new(&Key::from(self.storage));
        let plain = cipher.decrypt(&Nonce::try_from(nonce).ok()?, ciphertext).ok()?;
        String::from_utf8(plain).ok()
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
