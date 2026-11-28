//! A run stream as the fake serves it: chunked, one frame per chunk, `gap` between frames, then
//! held open for `hold` or until the run is cancelled.

use std::io::Write;
use std::net::TcpStream;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;

use super::State;

/// What one stream serves.
pub(super) struct Script {
    pub conversation: String,
    pub text: String,
    pub gap: Option<Duration>,
    pub hold: Option<Duration>,
}

fn chunk(writer: &mut TcpStream, bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let head = format!("{:x}\r\n", bytes.len());
    writer.write_all(head.as_bytes()).is_ok()
        && writer.write_all(bytes).is_ok()
        && writer.write_all(b"\r\n").is_ok()
        && writer.flush().is_ok()
}

/// The first `run_id` the script names.
fn run_of(text: &str) -> String {
    text.split("\"run_id\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("run_fixture")
        .to_owned()
}

pub(super) fn write(mut writer: TcpStream, state: &Mutex<State>, script: Script) {
    let lock = || state.lock().unwrap_or_else(|p| p.into_inner());
    {
        let mut state = lock();
        state.cancelled.remove(&script.conversation);
        state.streaming.insert(script.conversation.clone());
    }
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\
                Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
    let mut open = writer.write_all(head.as_bytes()).is_ok() && writer.flush().is_ok();
    for (n, frame) in script.text.split_inclusive("\n\n").enumerate() {
        if !open {
            break;
        }
        if let (Some(gap), true) = (script.gap, n > 0) {
            thread::sleep(gap);
        }
        open = chunk(&mut writer, frame.as_bytes());
    }
    if let (Some(hold), true) = (script.hold, open) {
        let until = Instant::now() + hold;
        while Instant::now() < until {
            if lock().cancelled.contains(&script.conversation) {
                let data = json!({
                    "run_id": run_of(&script.text), "code": "RUN_CANCELLED", "message": "Run cancelled"
                });
                open = chunk(
                    &mut writer,
                    format!("event: error\ndata: {data}\n\n").as_bytes(),
                );
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    if open {
        let _ = writer.write_all(b"0\r\n\r\n");
        let _ = writer.flush();
    }
    let mut state = lock();
    state.streaming.remove(&script.conversation);
    state.cancelled.remove(&script.conversation);
}
