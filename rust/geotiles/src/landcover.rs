//! ESA WorldCover class colors and hypsometric elevation tinting.

fn hex(c: u32) -> [f64; 3] {
    [
        ((c >> 16) & 0xff) as f64,
        ((c >> 8) & 0xff) as f64,
        (c & 0xff) as f64,
    ]
}

/// WorldCover class -> base RGB. None for unknown / nodata (caller falls back
/// to the hypsometric tint).
pub fn landcover_color(class: u8) -> Option<[f64; 3]> {
    Some(match class {
        10 => hex(0x2E6B3E), // 树冠 tree cover
        20 => hex(0x4E7A4A), // 灌木 shrubland
        30 => hex(0x9FC97A), // 草地 grassland
        40 => hex(0xE8E4C0), // 农田 cropland
        50 => hex(0xEDE6DA), // 建成区 built-up
        60 => hex(0x8F948B), // 裸地 bare / sparse（冷中性灰，暖色在森林里会读成粉色）
        70 => hex(0xF2F6F8), // 雪冰 snow/ice
        80 => hex(0xA9D3E8), // 永久水体 water
        90 => hex(0x8FB8C9), // 湿地 wetland
        95 => hex(0x2E6B5E), // 红树林 mangroves
        100 => hex(0xB9C98A), // 苔藓 moss/lichen
        _ => return None,
    })
}

/// Vegetation classes get a small brightness perturbation so they don't
/// render as one flat patch of green.
pub fn is_vegetation(class: u8) -> bool {
    matches!(class, 10 | 20 | 30 | 100)
}

pub fn mix(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Hypsometric tint for elevation (m) and slope (degrees).
///
/// <2500 yellow-green, 2500-4000 cool green, 4000-4800 grey-brown rock,
/// 4800-5200 lighter scree, >5200 snow — with the snow line fading out on
/// slopes steeper than ~34 deg so steep faces keep their rock texture instead
/// of turning into one flat white sheet (the whole 贡嘎 massif sits above
/// 4800 m, so an early snow line washes out the entire summit block).
pub fn hypsometric_tint(elev: f64, slope_deg: f64) -> [f64; 3] {
    let low = hex(0xA8B878);
    let mid = hex(0x7A9E7E);
    let rock = hex(0x8C8274);
    let scree = hex(0xB6AC9C);
    let snow = hex(0xEDF1F3);
    if elev < 2500.0 {
        return low;
    }
    if elev < 4000.0 {
        return mix(low, mid, (elev - 2500.0) / 1500.0);
    }
    if elev < 4800.0 {
        return mix(mid, rock, (elev - 4000.0) / 800.0);
    }
    if elev < 5200.0 {
        return mix(rock, scree, (elev - 4800.0) / 400.0);
    }
    // Snow line: blend in over 5200-5600 m, suppressed on steep faces.
    let by_elev = smoothstep(5200.0, 5600.0, elev);
    let by_slope = 1.0 - smoothstep(34.0, 48.0, slope_deg);
    mix(scree, snow, by_elev * by_slope)
}

/// How strongly the hypsometric ramp overrides the land-cover class at a given
/// elevation. Low ground keeps WorldCover (real forest / crop / desert
/// boundaries); the high country follows the elevation ramp instead, otherwise
/// WorldCover's "bare / sparse" class paints the whole summit block as one
/// warm khaki sheet.
pub fn hypsometric_weight(elev: f64) -> f64 {
    0.30 + 0.45 * smoothstep(4000.0, 5000.0, elev)
}

/// Global desaturation towards grey by `amount` (0.1 = mix 10% grey).
pub fn desaturate(c: [f64; 3], amount: f64) -> [f64; 3] {
    let gray = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    mix(c, [gray, gray, gray], amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_colors() {
        assert_eq!(landcover_color(10), Some([46.0, 107.0, 62.0]));
        assert_eq!(landcover_color(80), Some([169.0, 211.0, 232.0]));
        assert_eq!(landcover_color(255), None);
        assert_eq!(landcover_color(0), None);
    }

    #[test]
    fn hypso_bands() {
        assert_eq!(hypsometric_tint(1000.0, 0.0), hex(0xA8B878));
        // Steep face high up stays rock, not snow.
        let steep = hypsometric_tint(5500.0, 50.0);
        let flat = hypsometric_tint(5500.0, 5.0);
        assert!(flat[0] > 220.0, "flat high should be snow white: {flat:?}");
        assert!(steep[0] < 200.0, "steep high should stay rock: {steep:?}");
    }
}
