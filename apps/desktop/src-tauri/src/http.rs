//! A deliberately tiny HTTP/1.1 GET client for the loopback interface.
//!
//! The desktop shell only ever talks to its own sidecar on 127.0.0.1. That needs
//! no TLS, no redirects, no connection pool and no proxy support, so pulling in
//! reqwest (and a TLS stack) to fetch `/api/health` would add minutes to every
//! cold Rust build to buy nothing. This is the whole client.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::time::Duration;

fn loopback(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

/// True when something is listening on the loopback port and completes a TCP handshake.
pub fn port_accepts(port: u16, timeout: Duration) -> bool {
    match TcpStream::connect_timeout(&loopback(port), timeout) {
        Ok(stream) => {
            let _ = stream.shutdown(Shutdown::Both);
            true
        }
        Err(_) => false,
    }
}

/// `GET path` against 127.0.0.1:port. Returns `(status, body)`.
pub fn get(port: u16, path: &str, timeout: Duration) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect_timeout(&loopback(port), timeout)
        .map_err(|e| format!("connect: {e}"))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\nUser-Agent: trent-desktop\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&raw).into_owned();

    let (head, body) = match text.find("\r\n\r\n") {
        Some(i) => (&text[..i], text[i + 4..].to_string()),
        None => return Err("malformed response: no header terminator".into()),
    };
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| "malformed response: no status code".to_string())?;

    // `Connection: close` means the server closes the socket, so an unchunked
    // body is complete as read. Next serves API routes chunked, so de-chunk when told to.
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = if chunked { dechunk(&body) } else { body };
    Ok((status, body))
}

fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some(i) = rest.find("\r\n") else { break };
        let size = usize::from_str_radix(rest[..i].trim().split(';').next().unwrap_or("0"), 16);
        let Ok(size) = size else { break };
        if size == 0 {
            break;
        }
        let start = i + 2;
        let end = start + size;
        if end > rest.len() {
            out.push_str(&rest[start..]);
            break;
        }
        out.push_str(&rest[start..end]);
        rest = &rest[(end + 2).min(rest.len())..];
    }
    out
}
