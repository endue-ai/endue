//! Server-sent event frames from bytes as they come: the WHATWG event stream format, lines ending
//! in LF, CR LF or CR, a byte order mark at the start, `:` comments skipped.

/// Whether the stream goes on after a frame.
pub(crate) enum Next {
    More,
    End,
}

/// SSE frames from bytes as they come (the WHATWG event stream format, lines ending in LF, CR LF
/// or CR).
#[derive(Default)]
pub(crate) struct Frames {
    line: Vec<u8>,
    event: String,
    data: String,
    has_data: bool,
    started: bool,
    after_cr: bool,
}

impl Frames {
    /// Feed `bytes`; each complete frame goes to `frame`, until it says to stop.
    pub(crate) fn feed(&mut self, bytes: &[u8], frame: &mut dyn FnMut(&str, &str) -> Next) -> Next {
        for &b in bytes {
            if self.after_cr {
                self.after_cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            if b == b'\n' || b == b'\r' {
                self.after_cr = b == b'\r';
                let line = std::mem::take(&mut self.line);
                if let Next::End = self.line_done(&line, frame) {
                    return Next::End;
                }
            } else {
                self.line.push(b);
            }
        }
        Next::More
    }

    fn line_done(&mut self, line: &[u8], frame: &mut dyn FnMut(&str, &str) -> Next) -> Next {
        let mut line = String::from_utf8_lossy(line).into_owned();
        if !self.started {
            self.started = true;
            if let Some(rest) = line.strip_prefix('\u{feff}') {
                line = rest.to_owned();
            }
        }
        if line.is_empty() {
            let next = if self.has_data {
                frame(&self.event, &self.data)
            } else {
                Next::More
            };
            self.event.clear();
            self.data.clear();
            self.has_data = false;
            return next;
        }
        let (field, value) = line.split_once(':').unwrap_or((&line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => value.clone_into(&mut self.event),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            _ => {}
        }
        Next::More
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(wire: &[&[u8]]) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut frames = Frames::default();
        for piece in wire {
            frames.feed(piece, &mut |e: &str, d: &str| {
                out.push((e.to_owned(), d.to_owned()));
                Next::More
            });
        }
        out
    }

    #[test]
    fn frames_split_across_reads_and_line_ends_are_read_whole() {
        let got = frames(&[
            b"\xef\xbb\xbfevent: de",
            b"lta\r\ndata: {\"a\":\r\ndata: 1}\r\n\r",
            b"\n: ping\n\nevent: done\rdata:x\r\r",
        ]);
        assert_eq!(
            got,
            vec![
                ("delta".to_owned(), "{\"a\":\n1}".to_owned()),
                ("done".to_owned(), "x".to_owned())
            ]
        );
    }
}
