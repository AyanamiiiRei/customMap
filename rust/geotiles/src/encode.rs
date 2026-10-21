//! Terrarium elevation encoding and PNG output.

use anyhow::Result;
use image::ImageEncoder;

/// Terrarium: v = elev + 32768; R = floor(v/256), G = floor(v) mod 256,
/// B = floor(frac(v) * 256). elev is clamped to [-500, 9000] first.
pub fn terrarium_encode(elev: f64) -> [u8; 3] {
    let e = elev.clamp(-500.0, 9000.0);
    let v = e + 32768.0;
    let r = (v / 256.0).floor();
    let g = v.floor() as i64 % 256;
    let b = ((v - v.floor()) * 256.0).floor();
    [r as u8, g as u8, b as u8]
}

pub fn terrarium_decode(rgb: [u8; 3]) -> f64 {
    rgb[0] as f64 * 256.0 + rgb[1] as f64 + rgb[2] as f64 / 256.0 - 32768.0
}

/// Encode an RGB8 image (row-major, 3 bytes/px) as PNG.
pub fn encode_png_rgb(rgb: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let enc = image::codecs::png::PngEncoder::new(&mut buf);
    enc.write_image(rgb, w, h, image::ExtendedColorType::Rgb8)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terrarium_roundtrip() {
        for &e in &[-500.0, -10.5, 0.0, 1.0, 100.25, 8848.86, 7556.0, 9000.0] {
            let d = terrarium_decode(terrarium_encode(e));
            assert!((d - e).abs() < 1.0 / 256.0 + 1e-9, "e={e} d={d}");
        }
    }

    #[test]
    fn terrarium_clamps() {
        assert_eq!(terrarium_encode(-1000.0), terrarium_encode(-500.0));
        assert_eq!(terrarium_encode(12000.0), terrarium_encode(9000.0));
    }

    #[test]
    fn terrarium_known_value() {
        // 0 m -> v = 32768 -> R=128, G=0, B=0
        assert_eq!(terrarium_encode(0.0), [128, 0, 0]);
    }
}
