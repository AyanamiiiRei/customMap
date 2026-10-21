//! Terrarium elevation encoding and PNG output.

use anyhow::Result;
use image::ImageEncoder;

/// Terrarium: v = elev + 32768; R = v >> 8, G = v & 255, B = 0.
///
/// Elevation is quantised to whole metres. The classic terrarium layout puts
/// the fractional metre in B, which makes that channel pure noise: PNG cannot
/// compress it and tiles come out ~3x larger (~145 KB instead of ~50 KB for a
/// 256x256 tile). One-metre precision is still ~38x finer than a z12 tile
/// pixel, so the extra byte buys nothing a terrain renderer can use.
/// `terrarium_decode` accepts both layouts (B = 0 here).
pub fn terrarium_encode(elev: f64) -> [u8; 3] {
    let v = elev.clamp(-500.0, 9000.0).round() as i64 + 32768;
    [(v >> 8) as u8, (v & 0xff) as u8, 0]
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
        // Quantised to whole metres, so the error bound is half a metre.
        for &e in &[-500.0, -10.5, 0.0, 1.0, 100.25, 8848.86, 7556.0, 9000.0] {
            let d = terrarium_decode(terrarium_encode(e));
            assert!((d - e).abs() <= 0.5 + 1e-9, "e={e} d={d}");
        }
    }

    #[test]
    fn terrarium_blue_channel_is_constant() {
        for e in [-500.0, -3.7, 0.4, 1234.56, 8999.0] {
            assert_eq!(terrarium_encode(e)[2], 0, "B must stay 0 for compressibility");
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
