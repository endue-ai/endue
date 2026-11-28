//! Where a picture was taken, taken out before it leaves the desk: a JPEG's EXIF GPS block (the
//! pointer to it removed from IFD0, its values zeroed) and its XMP, a PNG's `eXIf` chunk and XMP, a
//! WebP's `EXIF` and `XMP ` chunks. The image data is untouched; anything it cannot read goes as it is.

/// The bytes of a picture of `mime` without its location.
pub(crate) fn without_location(bytes: Vec<u8>, mime: &str) -> Vec<u8> {
    match mime {
        "image/jpeg" => jpeg(bytes),
        "image/png" => png(bytes),
        "image/webp" => webp(bytes),
        _ => bytes,
    }
}

const GPS_POINTER: u16 = 0x8825;
const XMP: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn jpeg(mut bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return bytes;
    }
    let mut drop = Vec::new();
    let mut at = 2;
    while at + 4 <= bytes.len() && bytes[at] == 0xFF {
        let marker = bytes[at + 1];
        // The image data begins (or ends): the metadata is before it.
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let len = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        let end = at + 2 + len;
        if len < 2 || end > bytes.len() {
            break;
        }
        if marker == 0xE1 {
            let body = at + 4;
            if bytes[body..end].starts_with(b"Exif\0\0") {
                tiff(&mut bytes[body + 6..end]);
            } else if bytes[body..end].starts_with(XMP) {
                drop.push(at..end);
            }
        }
        at = end;
    }
    for range in drop.into_iter().rev() {
        bytes.drain(range);
    }
    bytes
}

/// A TIFF block's numbers in its own byte order.
struct Tiff {
    little: bool,
}

impl Tiff {
    fn u16(&self, t: &[u8], at: usize) -> Option<u16> {
        let b: [u8; 2] = t.get(at..at + 2)?.try_into().ok()?;
        Some(if self.little {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    }

    fn u32(&self, t: &[u8], at: usize) -> Option<usize> {
        let b: [u8; 4] = t.get(at..at + 4)?.try_into().ok()?;
        let n = if self.little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        };
        usize::try_from(n).ok()
    }

    fn put_u16(&self, t: &mut [u8], at: usize, n: u16) {
        let b = if self.little {
            n.to_le_bytes()
        } else {
            n.to_be_bytes()
        };
        t[at..at + 2].copy_from_slice(&b);
    }
}

/// Take the GPS IFD out of IFD0 and zero what it held.
fn tiff(t: &mut [u8]) {
    let order = match t.get(..2) {
        Some(b"II") => Tiff { little: true },
        Some(b"MM") => Tiff { little: false },
        _ => return,
    };
    let Some(ifd0) = order.u32(t, 4) else { return };
    let Some(n) = order.u16(t, ifd0).map(usize::from) else {
        return;
    };
    let entries = ifd0 + 2;
    let end = entries + 12 * n;
    if n == 0 || end + 4 > t.len() {
        return;
    }
    let Some(i) = (0..n).find(|i| order.u16(t, entries + 12 * i) == Some(GPS_POINTER)) else {
        return;
    };
    let at = entries + 12 * i;
    if let Some(gps) = order.u32(t, at + 8) {
        wipe(t, &order, gps);
    }
    // The later entries and the next IFD's offset move up by one entry.
    t.copy_within(at + 12..end + 4, at);
    t[end - 8..end + 4].fill(0);
    order.put_u16(t, ifd0, (n - 1) as u16);
}

/// Zero an IFD and the values it points to.
fn wipe(t: &mut [u8], order: &Tiff, ifd: usize) {
    let Some(m) = order.u16(t, ifd).map(usize::from) else {
        return;
    };
    let end = ifd + 2 + 12 * m + 4;
    if end > t.len() {
        return;
    }
    for j in 0..m {
        let e = ifd + 2 + 12 * j;
        let size = match order.u16(t, e + 2) {
            Some(1 | 2 | 6 | 7) => 1,
            Some(3 | 8) => 2,
            Some(4 | 9 | 11) => 4,
            Some(5 | 10 | 12) => 8,
            _ => 0,
        };
        let total = order
            .u32(t, e + 4)
            .map_or(0, |count| count.saturating_mul(size));
        if total > 4
            && let Some(offset) = order.u32(t, e + 8)
            && let Some(values) = t.get_mut(offset..offset.saturating_add(total))
        {
            values.fill(0);
        }
    }
    t[ifd..end].fill(0);
}

fn png(bytes: Vec<u8>) -> Vec<u8> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIGNATURE) {
        return bytes;
    }
    let mut out = SIGNATURE.to_vec();
    let mut at = SIGNATURE.len();
    while at + 12 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
        let end = at + 12 + len as usize;
        if end > bytes.len() {
            return bytes;
        }
        let kind = &bytes[at + 4..at + 8];
        let data = &bytes[at + 8..end - 4];
        let xmp = kind == b"iTXt" && data.starts_with(b"XML:com.adobe.xmp\0");
        if kind != b"eXIf" && !xmp {
            out.extend_from_slice(&bytes[at..end]);
        }
        at = end;
    }
    out.extend_from_slice(&bytes[at..]);
    out
}

fn webp(bytes: Vec<u8>) -> Vec<u8> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return bytes;
    }
    let mut out = bytes[..12].to_vec();
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let len = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]);
        let end = at + 8 + len as usize + (len as usize & 1);
        if end > bytes.len() {
            return bytes;
        }
        let kind = &bytes[at..at + 4];
        if kind == b"VP8X" && len > 0 {
            let start = out.len();
            out.extend_from_slice(&bytes[at..end]);
            // The flags no longer say EXIF (0x08) or XMP (0x04) follow.
            out[start + 8] &= !0x0C;
        } else if kind != b"EXIF" && kind != b"XMP " {
            out.extend_from_slice(&bytes[at..end]);
        }
        at = end;
    }
    let size = u32::try_from(out.len() - 8).unwrap_or(u32::MAX);
    out[4..8].copy_from_slice(&size.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG whose EXIF (big-endian) has the camera's make and a GPS latitude, and an XMP block.
    fn jpeg_with_location() -> Vec<u8> {
        let mut tiff = b"MM\0\x2a\0\0\0\x08".to_vec();
        // IFD0 at 8: two entries, Make "Cam" inline and the GPS pointer to 38.
        tiff.extend([0, 2]);
        tiff.extend([0x01, 0x0F, 0, 2, 0, 0, 0, 4, b'C', b'a', b'm', 0]);
        tiff.extend([0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 38]);
        tiff.extend([0, 0, 0, 0]);
        // GPS IFD at 38: GPSLatitude, three rationals at 56.
        tiff.extend([0, 1]);
        tiff.extend([0, 2, 0, 5, 0, 0, 0, 3, 0, 0, 0, 56]);
        tiff.extend([0, 0, 0, 0]);
        tiff.extend([
            0, 0, 0, 37, 0, 0, 0, 1, 0, 0, 0, 33, 0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 0, 1,
        ]);
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend(&tiff);
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend(u16::try_from(exif.len() + 2).unwrap().to_be_bytes());
        out.extend(&exif);
        let xmp = [XMP, b"<x:xmpmeta>exif:GPSLatitude</x:xmpmeta>"].concat();
        out.extend([0xFF, 0xE1]);
        out.extend(u16::try_from(xmp.len() + 2).unwrap().to_be_bytes());
        out.extend(&xmp);
        out.extend([0xFF, 0xDA, 0, 2, 1, 2, 3, 0xFF, 0xD9]);
        out
    }

    #[test]
    fn a_jpeg_keeps_its_make_and_image_and_loses_where_it_was_taken() {
        let before = jpeg_with_location();
        let after = without_location(before.clone(), "image/jpeg");
        assert_eq!(&after[6..12], b"Exif\0\0");
        let tiff = &after[12..];
        assert_eq!(&tiff[8..10], &[0, 1], "IFD0 has one entry left");
        assert_eq!(&tiff[10..22], &before[22..34], "the make is kept");
        assert!(tiff[22..38].iter().all(|b| *b == 0), "the pointer is gone");
        assert!(!after.windows(2).any(|w| w == [0x88, 0x25]));
        assert!(
            tiff[38..80].iter().all(|b| *b == 0),
            "the GPS IFD and latitude are zeroed"
        );
        assert!(
            !after.windows(4).any(|w| w == b"exif"),
            "the XMP block is gone"
        );
        assert!(after.ends_with(&[0xFF, 0xDA, 0, 2, 1, 2, 3, 0xFF, 0xD9]));
    }

    #[test]
    fn a_png_loses_its_exif_chunk_and_a_webp_its_exif_and_xmp() {
        let chunk = |kind: &[u8], data: &[u8]| {
            let mut c = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
            c.extend(kind);
            c.extend(data);
            c.extend([0, 0, 0, 0]);
            c
        };
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(chunk(b"IHDR", &[1; 13]));
        png.extend(chunk(b"eXIf", b"MM\0\x2a"));
        png.extend(chunk(b"IEND", &[]));
        let png = without_location(png, "image/png");
        assert!(!png.windows(4).any(|w| w == b"eXIf"));
        assert!(png.windows(4).any(|w| w == b"IHDR") && png.ends_with(b"IEND\0\0\0\0"));

        let riff = |kind: &[u8], data: &[u8]| {
            let mut c = kind.to_vec();
            c.extend(u32::try_from(data.len()).unwrap().to_le_bytes());
            c.extend(data);
            c
        };
        let mut body = b"WEBP".to_vec();
        body.extend(riff(b"VP8X", &[0x0C, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        body.extend(riff(b"VP8 ", &[9; 4]));
        body.extend(riff(b"EXIF", b"MM\0\x2a"));
        body.extend(riff(b"XMP ", b"<x/>"));
        let mut webp = b"RIFF".to_vec();
        webp.extend(u32::try_from(body.len()).unwrap().to_le_bytes());
        webp.extend(body);
        let webp = without_location(webp, "image/webp");
        assert_eq!(webp.len(), 12 + 18 + 12);
        assert_eq!(u32::from_le_bytes(webp[4..8].try_into().unwrap()), 34);
        assert_eq!(webp[20], 0, "the flags no longer announce EXIF or XMP");
        assert!(!webp.windows(4).any(|w| w == b"EXIF" || w == b"XMP "));
    }

    #[test]
    fn what_it_cannot_read_goes_as_it_is() {
        assert_eq!(without_location(vec![1, 2, 3], "image/jpeg"), [1, 2, 3]);
        assert_eq!(
            without_location(vec![0xFF, 0xD8, 0xFF], "image/jpeg"),
            [0xFF, 0xD8, 0xFF]
        );
        assert_eq!(without_location(vec![1, 2], "video/mp4"), [1, 2]);
    }
}
