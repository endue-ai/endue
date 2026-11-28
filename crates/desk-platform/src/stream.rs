//! One request whose answer is read as it arrives: a run's event stream. desk-sys's `fetch` reads
//! a body to its end and its `sse` opens GETs only, so a run (a POST) is opened here, the way
//! desk-sys connects: the URL must match `allowed_hosts`, the system's proxy is used (desk-sys's
//! resolver), certificates are checked against the OS trust store, and no redirect is followed. Every
//! wait (resolve, connect, the answer's head, each read of its body) is at most `idle`.

use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use desk_sys::net::proxy::{Resolver, Route};
use desk_sys::net::{Method, Request, host_allowed};
use ureq::http;
use ureq::tls::{RootCerts, TlsConfig};

use crate::error::{ErrorKind, PlatformError, Result};

/// An answer whose body is still to be read.
pub(crate) struct Opened {
    pub status: u16,
    /// The essence of its content type, lowercase.
    pub kind: String,
    pub body: Box<dyn Read>,
}

/// Send `request` and wait at most `idle` for the head of its answer.
pub(crate) fn open(request: &Request, idle: Duration) -> Result<Opened> {
    if !host_allowed(&request.allowed_hosts, &request.url) {
        return Err(PlatformError::new(
            ErrorKind::Failed,
            format!("{} is not endue AI's platform", request.url),
        ));
    }
    let mut builder = http::Request::builder()
        .method(match request.method {
            Method::Post => http::Method::POST,
            _ => http::Method::GET,
        })
        .uri(request.url.as_str());
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let invalid = |e: http::Error| PlatformError::new(ErrorKind::Failed, e.to_string());
    let proxy = proxy(&request.url)?;
    let agent = agent();
    let result = match &request.body {
        Some(body) => {
            let request = builder.body(body.clone()).map_err(invalid)?;
            send(agent, request, proxy, idle)
        }
        None => {
            let request = builder.body(()).map_err(invalid)?;
            send(agent, request, proxy, idle)
        }
    };
    let response = result.map_err(|e| failure(&e, idle))?;
    let kind = response
        .headers()
        .get("content-type")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default();
    let kind = kind
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    Ok(Opened {
        status: response.status().as_u16(),
        kind,
        body: Box::new(response.into_body().into_reader()),
    })
}

fn send<B: ureq::AsSendBody>(
    agent: &ureq::Agent,
    request: http::Request<B>,
    proxy: Option<ureq::Proxy>,
    idle: Duration,
) -> std::result::Result<http::Response<ureq::Body>, ureq::Error> {
    let wait = Some(idle);
    let request = agent
        .configure_request(request)
        .proxy(proxy)
        .timeout_resolve(wait)
        .timeout_connect(wait)
        .timeout_send_request(wait)
        .timeout_send_body(wait)
        .timeout_recv_response(wait)
        .timeout_per_read(wait)
        .build();
    agent.run(request)
}

/// A read of the body that failed: `offline` when it waited past `idle`.
pub(crate) fn read_failure(error: &std::io::Error, idle: Duration) -> PlatformError {
    if timed_out(error) {
        silent(idle)
    } else {
        PlatformError::new(
            ErrorKind::Offline,
            format!("endue AI could not be reached: {error}"),
        )
    }
}

/// Whether a read of the body failed because it waited past its limit.
pub(crate) fn timed_out(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::TimedOut
        || error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<ureq::Error>())
            .is_some_and(|e| matches!(e, ureq::Error::Timeout(_)))
}

/// endue AI sent nothing for `idle`.
pub(crate) fn silent(idle: Duration) -> PlatformError {
    PlatformError::new(
        ErrorKind::Offline,
        format!(
            "endue AI sent nothing for {} s",
            idle.as_secs_f64().ceil() as u64
        ),
    )
}

fn failure(error: &ureq::Error, idle: Duration) -> PlatformError {
    match error {
        ureq::Error::Timeout(_) => silent(idle),
        ureq::Error::Io(io) => read_failure(io, idle),
        ureq::Error::ConnectionFailed | ureq::Error::HostNotFound => PlatformError::new(
            ErrorKind::Offline,
            format!("endue AI could not be reached: {error}"),
        ),
        other => PlatformError::new(ErrorKind::Failed, other.to_string()),
    }
}

/// One agent for every stream; redirects are not followed and statuses are never errors.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .proxy(None)
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .into()
    })
}

/// The proxy the system's settings choose for `url`, as desk-sys's fetch chooses it.
fn proxy(url: &str) -> Result<Option<ureq::Proxy>> {
    static RESOLVER: OnceLock<Resolver> = OnceLock::new();
    match RESOLVER.get_or_init(Resolver::system).route(url) {
        Route::Direct => Ok(None),
        Route::Proxy(proxy) => ureq::Proxy::new(&proxy)
            .map(Some)
            .map_err(|e| PlatformError::new(ErrorKind::Failed, format!("the system's proxy: {e}"))),
    }
}
