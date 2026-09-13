//! The per-install `AUTH_SECRET` the wrapped web app needs.
//!
//! auth.js refuses to run without a secret (`[auth][error] MissingSecret`,
//! 04_verification/output/desktop-launch-evidence.md), and the sidecar environment
//! never provided one. This module generates a cryptographically random secret ONCE,
//! persists it at `~/.trent/desktop/auth-secret` and hands it to the sidecar.
//!
//! Rules, each with a test:
//!   * created with mode 0600 inside a 0700 directory;
//!   * never regenerated while a value exists — that would invalidate every session;
//!   * a pre-existing file with looser permissions is tightened to 0600 on load;
//!   * written atomically: temp file in the same directory, then `rename`, mirroring
//!     packages/trent-core/src/config/atomic-fs.ts, so a crash mid-write can never
//!     leave a half-secret behind that a later launch would trust.
//!
//! The value is never logged. Callers get it only as the return value.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 32 bytes of entropy, hex-encoded: 64 characters, safely printable for an env var.
const SECRET_BYTES: usize = 32;
pub const FILE_NAME: &str = "auth-secret";

/// `~/.trent/desktop`. `HOME` is the only source; there is no fallback to the cwd,
/// because a secret written next to the binary would be world-visible.
pub fn default_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".trent").join("desktop"))
}

/// Load the secret from `dir/auth-secret`, creating it on first launch.
pub fn load_or_create(dir: &Path) -> Result<String, String> {
    ensure_private_dir(dir)?;
    let path = dir.join(FILE_NAME);

    if path.is_file() {
        let existing = fs::read_to_string(&path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let existing = existing.trim();
        if !existing.is_empty() {
            set_mode(&path, 0o600)?;
            return Ok(existing.to_string());
        }
        // An empty file is not a secret; fall through and create one.
    }

    let secret = generate()?;
    write_atomically(&path, &secret)?;
    Ok(secret)
}

fn generate() -> Result<String, String> {
    let mut bytes = [0u8; SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| format!("system RNG unavailable: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // `recursive(true)` skips the mode on a directory that already exists.
    set_mode(dir, 0o700)
}

fn write_atomically(path: &Path, secret: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let tmp = dir.join(format!(".{}.{}.tmp", FILE_NAME, std::process::id()));

    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| -> Result<(), String> {
        let mut file = opts
            .open(&tmp)
            .map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
        file.write_all(secret.as_bytes())
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        drop(file);
        fs::rename(&tmp, path)
            .map_err(|e| format!("cannot move {} into place: {e}", tmp.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    set_mode(path, 0o600)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let current = fs::metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?
        .permissions()
        .mode()
        & 0o777;
    if current == mode {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("cannot chmod {} to {mode:o}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_dir(tag: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("trent-auth-secret-{tag}-{}-{nonce}", std::process::id()));
        // The module must create the leaf itself; only the parent exists.
        dir.join("desktop")
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn first_launch_creates_a_private_secret() {
        let dir = scratch_dir("first");
        let secret = load_or_create(&dir).unwrap();

        assert_eq!(secret.len(), SECRET_BYTES * 2, "32 bytes hex-encoded");
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(mode_of(&dir), 0o700, "directory must be private");
        assert_eq!(mode_of(&dir.join(FILE_NAME)), 0o600, "file must be private");
        assert_eq!(
            fs::read_to_string(dir.join(FILE_NAME)).unwrap().trim(),
            secret,
            "what was returned is what was persisted"
        );
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp file left behind: {leftovers:?}");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn second_launch_reuses_the_identical_value() {
        let dir = scratch_dir("second");
        let first = load_or_create(&dir).unwrap();
        let second = load_or_create(&dir).unwrap();
        assert_eq!(first, second, "regenerating would invalidate every session");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn world_readable_file_is_tightened_to_0600() {
        let dir = scratch_dir("chmod");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        fs::write(&path, "pre-existing-secret\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(mode_of(&path), 0o644, "precondition");

        let secret = load_or_create(&dir).unwrap();

        assert_eq!(secret, "pre-existing-secret", "kept, not regenerated");
        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(mode_of(&dir), 0o700);
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn two_installs_never_share_a_secret() {
        let a = load_or_create(&scratch_dir("a")).unwrap();
        let b = load_or_create(&scratch_dir("b")).unwrap();
        assert_ne!(a, b);
    }
}
