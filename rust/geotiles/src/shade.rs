//! Terrain shading: Horn gradients, multi-azimuth hillshade, box-filter
//! concavity, and deterministic seamless value noise.

/// 3x3 Horn gradients on a row-major elevation grid (NaN must be pre-filled).
/// Returns (dz/dx, dz/dy) per cell; edges replicate the nearest interior cell.
pub fn horn_gradients(elev: &[f64], w: usize, h: usize, cell: f64) -> (Vec<f64>, Vec<f64>) {
    let mut gx = vec![0.0; w * h];
    let mut gy = vec![0.0; w * h];
    for j in 1..h - 1 {
        for i in 1..w - 1 {
            let a = elev[(j - 1) * w + (i - 1)];
            let b = elev[(j - 1) * w + i];
            let c = elev[(j - 1) * w + (i + 1)];
            let d = elev[j * w + (i - 1)];
            let f = elev[j * w + (i + 1)];
            let g = elev[(j + 1) * w + (i - 1)];
            let hh = elev[(j + 1) * w + i];
            let ii = elev[(j + 1) * w + (i + 1)];
            gx[j * w + i] = ((c + 2.0 * f + ii) - (a + 2.0 * d + g)) / (8.0 * cell);
            gy[j * w + i] = ((g + 2.0 * hh + ii) - (a + 2.0 * b + c)) / (8.0 * cell);
        }
    }
    // Fill edges from nearest interior.
    for i in 0..w {
        gx[i] = gx[w + i.min(w - 1)];
        gy[i] = gy[w + i.min(w - 1)];
        gx[(h - 1) * w + i] = gx[(h - 2) * w + i];
        gy[(h - 1) * w + i] = gy[(h - 2) * w + i];
    }
    for j in 0..h {
        gx[j * w] = gx[j * w + 1];
        gy[j * w] = gy[j * w + 1];
        gx[j * w + w - 1] = gx[j * w + w - 2];
        gy[j * w + w - 1] = gy[j * w + w - 2];
    }
    (gx, gy)
}

/// Mean of 4 hillshades (azimuths 315/45/135/225, sun altitude 45 deg),
/// normalized to [0,1]. The aspect terms of two opposite azimuth pairs cancel,
/// so this is a soft, direction-neutral slope shading.
pub fn hillshade_multi(dzdx: f64, dzdy: f64) -> f64 {
    let slope = (dzdx * dzdx + dzdy * dzdy).sqrt().atan();
    let aspect = dzdy.atan2(-dzdx);
    let zenith = std::f64::consts::FRAC_PI_4; // 45 deg altitude
    let mut sum = 0.0;
    for az_deg in [315.0f64, 45.0, 135.0, 225.0] {
        let az = az_deg.to_radians();
        let hs = zenith.cos() * slope.cos() + zenith.sin() * slope.sin() * (az - aspect).cos();
        sum += hs.max(0.0);
    }
    (sum / 4.0).clamp(0.0, 1.0)
}

/// Slope in degrees from gradients.
pub fn slope_deg(dzdx: f64, dzdy: f64) -> f64 {
    (dzdx * dzdx + dzdy * dzdy).sqrt().atan().to_degrees()
}

/// 11x11 box mean (separable), edges replicate. Input must be NaN-free.
pub fn box_mean_11(elev: &[f64], w: usize, h: usize) -> Vec<f64> {
    const R: isize = 5;
    let n = (2 * R + 1) as f64;
    // Horizontal pass, then vertical pass; window sizes here are small
    // (~272 px) so direct clamped sums are fast enough.
    let mut tmp = vec![0.0; w * h];
    for j in 0..h {
        for i in 0..w {
            let mut acc = 0.0;
            for k in -R..=R {
                let ii = (i as isize + k).clamp(0, w as isize - 1) as usize;
                acc += elev[j * w + ii];
            }
            tmp[j * w + i] = acc / n;
        }
    }
    let mut out = vec![0.0; w * h];
    for j in 0..h {
        for i in 0..w {
            let mut acc = 0.0;
            for k in -R..=R {
                let jj = (j as isize + k).clamp(0, h as isize - 1) as usize;
                acc += tmp[jj * w + i];
            }
            out[j * w + i] = acc / n;
        }
    }
    out
}

/// Deterministic 2D hash -> [0, 1).
fn hash2(ix: i64, iy: i64) -> f64 {
    let mut h = (ix as u64).wrapping_mul(6364136223846793005)
        ^ (iy as u64).wrapping_mul(1442695040888963407)
        ^ 0x9E3779B97F4A7C15;
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51afd7ed558ccd);
    h ^= h >> 33;
    h = h.wrapping_mul(0xc4ceb9fe1a85ec53);
    h ^= h >> 33;
    (h >> 11) as f64 / (1u64 << 53) as f64
}

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// Value noise at (x, y), in [0, 1). Seamless everywhere because it depends
/// only on integer lattice hashes.
pub fn value_noise(x: f64, y: f64) -> f64 {
    let ix = x.floor() as i64;
    let iy = y.floor() as i64;
    let fx = smooth(x - ix as f64);
    let fy = smooth(y - iy as f64);
    let a = hash2(ix, iy);
    let b = hash2(ix + 1, iy);
    let c = hash2(ix, iy + 1);
    let d = hash2(ix + 1, iy + 1);
    a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

/// Two-octave texture noise in [-1, 1], period roughly 8-16 pixels.
/// `gx`, `gy` should be GLOBAL tile-grid pixel coords (tile_x*256 + u) so the
/// noise is seamless across tile boundaries.
pub fn noise_fractal(gx: f64, gy: f64) -> f64 {
    let n = 0.65 * value_noise(gx / 12.0, gy / 12.0)
        + 0.35 * value_noise(gx / 5.0 + 100.0, gy / 5.0 + 100.0);
    2.0 * n - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_deterministic_and_bounded() {
        for k in 0..1000 {
            let n1 = noise_fractal(k as f64 * 0.7, k as f64 * 1.3);
            let n2 = noise_fractal(k as f64 * 0.7, k as f64 * 1.3);
            assert_eq!(n1, n2);
            assert!((-1.0..=1.0).contains(&n1));
        }
    }

    #[test]
    fn noise_seamless_across_tile_boundary() {
        // Global coords either side of a tile boundary (gx = 255.9 / 256.1)
        // must be nearly identical.
        let a = noise_fractal(255.95, 100.0);
        let b = noise_fractal(256.05, 100.0);
        assert!((a - b).abs() < 0.05, "seam gap {}", (a - b).abs());
    }

    #[test]
    fn hillshade_flat_is_bright() {
        let hs = hillshade_multi(0.0, 0.0);
        assert!((hs - std::f64::consts::FRAC_PI_4.cos()).abs() < 1e-9);
    }

    #[test]
    fn box_mean_constant() {
        let e = vec![7.0; 25 * 25];
        let m = box_mean_11(&e, 25, 25);
        assert!(m.iter().all(|&v| (v - 7.0).abs() < 1e-9));
    }
}
