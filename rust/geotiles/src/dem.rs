//! Raster access via the GDAL command line tools (`gdalinfo` / `gdal_translate`).
//!
//! We deliberately do not link against libgdal: the GDAL in this project comes
//! from a conda env whose shared-library setup is fragile for `gdal-sys`.
//! Instead each window read shells out to `gdal_translate -of ENVI -ot Float32`
//! and reads the raw band back. Windows are cached per tile task, so the
//! subprocess count stays modest (one per tile, or one per tile-row band for
//! contours).

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static TMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn gdal_bin(name: &str) -> PathBuf {
    if let Ok(home) = std::env::var("GDAL_HOME") {
        let p = Path::new(&home).join("bin").join(name);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(name)
}

/// A georeferenced single-band raster opened through `gdalinfo -json`.
pub struct Raster {
    pub path: PathBuf,
    pub width: usize,
    pub height: usize,
    /// GDAL geotransform: [origin_x, px_w, 0, origin_y, 0, px_h] (px_h < 0).
    pub gt: [f64; 6],
    pub nodata: Option<f64>,
}

impl Raster {
    pub fn open(path: &Path) -> Result<Raster> {
        let out = Command::new(gdal_bin("gdalinfo"))
            .arg("-json")
            .arg(path)
            .output()
            .context("failed to run gdalinfo")?;
        if !out.status.success() {
            bail!("gdalinfo failed: {}", String::from_utf8_lossy(&out.stderr));
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
        let size = v["size"].as_array().context("gdalinfo: no size")?;
        let gt = v["geoTransform"].as_array().context("gdalinfo: no geoTransform")?;
        let gt6: Vec<f64> = gt.iter().filter_map(|x| x.as_f64()).collect();
        if gt6.len() < 6 {
            bail!("gdalinfo: bad geoTransform");
        }
        let nodata = v["bands"]
            .as_array()
            .and_then(|b| b.first())
            .and_then(|b| b["noDataValue"].as_f64());
        Ok(Raster {
            path: path.to_path_buf(),
            width: size[0].as_u64().context("bad width")? as usize,
            height: size[1].as_u64().context("bad height")? as usize,
            gt: [gt6[0], gt6[1], gt6[2], gt6[3], gt6[4], gt6[5]],
            nodata,
        })
    }

    /// Raster extent in its CRS units: (minx, miny, maxx, maxy).
    pub fn extent(&self) -> (f64, f64, f64, f64) {
        let minx = self.gt[0];
        let maxy = self.gt[3];
        (
            minx,
            maxy + self.height as f64 * self.gt[5],
            minx + self.width as f64 * self.gt[1],
            maxy,
        )
    }

    /// Read a raw pixel window, optionally resampled to (out_w, out_h) with
    /// bilinear resampling. Returns row-major f32, nodata mapped to NaN.
    pub fn read_window(
        &self,
        x0: i64,
        y0: i64,
        w: usize,
        h: usize,
        out: Option<(usize, usize)>,
    ) -> Result<(Vec<f32>, usize, usize)> {
        let id = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "geotiles_{}_{}_{}",
            std::process::id(),
            id,
            x0
        ));
        let binpath = base.with_extension("bin");
        let mut cmd = Command::new(gdal_bin("gdal_translate"));
        cmd.arg("-q")
            .arg("-of")
            .arg("ENVI")
            .arg("-ot")
            .arg("Float32")
            .arg("-srcwin")
            .arg(x0.to_string())
            .arg(y0.to_string())
            .arg(w.to_string())
            .arg(h.to_string());
        if let Some((ow, oh)) = out {
            cmd.arg("-r").arg("bilinear")
                .arg("-outsize")
                .arg(ow.to_string())
                .arg(oh.to_string());
        }
        cmd.arg("-b").arg("1").arg(&self.path).arg(&binpath);
        let status = cmd.output().context("failed to run gdal_translate")?;
        if !status.status.success() {
            bail!(
                "gdal_translate -srcwin {} {} {} {} failed: {}",
                x0,
                y0,
                w,
                h,
                String::from_utf8_lossy(&status.stderr)
            );
        }
        let bytes = std::fs::read(&binpath).context("read ENVI bin")?;
        let _ = std::fs::remove_file(&binpath);
        let _ = std::fs::remove_file(base.with_extension("hdr"));
        let (ow, oh) = out.unwrap_or((w, h));
        let expected = ow * oh * 4;
        if bytes.len() != expected {
            bail!(
                "ENVI bin size mismatch: got {}, expected {} ({}x{} f32)",
                bytes.len(),
                expected,
                ow,
                oh
            );
        }
        let nd = self.nodata.map(|v| v as f32);
        let mut data = Vec::with_capacity(ow * oh);
        for c in bytes.chunks_exact(4) {
            let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            data.push(if Some(v) == nd { f32::NAN } else { v });
        }
        Ok((data, ow, oh))
    }

    /// Read a window covering a Web-Mercator rectangle, at a resolution no
    /// finer than the native one and no coarser than `target_res`
    /// (meters/pixel). Nodata comes back as NaN.
    pub fn read_merc_window(
        &self,
        minx: f64,
        miny: f64,
        maxx: f64,
        maxy: f64,
        target_res: f64,
    ) -> Result<Window> {
        let native = self.gt[1].abs();
        let res = target_res.max(native);
        let out_w = ((maxx - minx) / res).ceil().max(1.0) as usize;
        let out_h = ((maxy - miny) / res).ceil().max(1.0) as usize;

        // Source pixel bounds (pixel-center coordinates), clamped to raster.
        let fx0 = (minx - self.gt[0]) / self.gt[1] - 0.5;
        let fx1 = (maxx - self.gt[0]) / self.gt[1] - 0.5;
        let fy0 = (self.gt[3] - maxy) / self.gt[5].abs() - 0.5;
        let fy1 = (self.gt[3] - miny) / self.gt[5].abs() - 0.5;

        if fx1 < 0.0 || fy1 < 0.0 || fx0 >= self.width as f64 || fy0 >= self.height as f64 {
            // No overlap with the raster at all: an all-nodata window.
            return Ok(Window::nodata(out_w, out_h, minx, maxy, res, res));
        }
        let sx0 = fx0.floor().max(0.0) as i64;
        let sy0 = fy0.floor().max(0.0) as i64;
        let sx1 = fx1.ceil().min(self.width as f64 - 1.0) as i64;
        let sy1 = fy1.ceil().min(self.height as f64 - 1.0) as i64;
        let sw = (sx1 - sx0 + 1).max(1) as usize;
        let sh = (sy1 - sy0 + 1).max(1) as usize;

        // Actual left edge / top edge of the source window in meters.
        let win_minx = self.gt[0] + sx0 as f64 * self.gt[1];
        let win_maxy = self.gt[3] + sy0 as f64 * self.gt[5];
        let win_w_m = sw as f64 * self.gt[1];
        let win_h_m = sh as f64 * self.gt[5].abs();

        let need_resample = res > native * 1.5;
        let (data, ow, oh) = if need_resample {
            let ow = (win_w_m / res).ceil().max(1.0) as usize;
            let oh = (win_h_m / res).ceil().max(1.0) as usize;
            self.read_window(sx0, sy0, sw, sh, Some((ow, oh)))?
        } else {
            self.read_window(sx0, sy0, sw, sh, None)?
        };
        Ok(Window {
            w: ow,
            h: oh,
            data,
            origin_x: win_minx,
            origin_y: win_maxy,
            res_x: win_w_m / ow as f64,
            res_y: win_h_m / oh as f64,
        })
    }
}

/// An in-memory f32 window in EPSG:3857 space. NaN = nodata.
pub struct Window {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
    /// Mercator x of the left edge of pixel column 0.
    pub origin_x: f64,
    /// Mercator y of the top edge of pixel row 0.
    pub origin_y: f64,
    pub res_x: f64,
    pub res_y: f64,
}

impl Window {
    pub fn nodata(w: usize, h: usize, origin_x: f64, origin_y: f64, res_x: f64, res_y: f64) -> Self {
        Window {
            w,
            h,
            data: vec![f32::NAN; w * h],
            origin_x,
            origin_y,
            res_x,
            res_y,
        }
    }

    /// Bilinear sample at mercator coords; nodata / out of extent -> 0.0.
    pub fn sample_bilinear(&self, mx: f64, my: f64) -> f32 {
        let fx = (mx - self.origin_x) / self.res_x - 0.5;
        let fy = (self.origin_y - my) / self.res_y - 0.5;
        if fx < -0.5 || fy < -0.5 || fx > self.w as f64 - 0.5 || fy > self.h as f64 - 0.5 {
            return 0.0;
        }
        let fx = fx.clamp(0.0, (self.w - 1) as f64);
        let fy = fy.clamp(0.0, (self.h - 1) as f64);
        let x0 = fx.floor() as usize;
        let y0 = fy.floor() as usize;
        let x1 = (x0 + 1).min(self.w - 1);
        let y1 = (y0 + 1).min(self.h - 1);
        let tx = fx - x0 as f64;
        let ty = fy - y0 as f64;
        let corners = [
            (x0, y0, (1.0 - tx) * (1.0 - ty)),
            (x1, y0, tx * (1.0 - ty)),
            (x0, y1, (1.0 - tx) * ty),
            (x1, y1, tx * ty),
        ];
        let mut sum = 0.0f64;
        let mut wsum = 0.0f64;
        for (i, j, w) in corners {
            let v = self.data[j * self.w + i];
            if !v.is_nan() && w > 0.0 {
                sum += w * v as f64;
                wsum += w;
            }
        }
        if wsum > 0.0 {
            (sum / wsum) as f32
        } else {
            0.0
        }
    }

    /// Nearest-neighbour sample; None for nodata / out of extent.
    pub fn sample_nearest(&self, mx: f64, my: f64) -> Option<f32> {
        let fx = (mx - self.origin_x) / self.res_x - 0.5;
        let fy = (self.origin_y - my) / self.res_y - 0.5;
        if fx < -0.5 || fy < -0.5 || fx > self.w as f64 - 0.5 || fy > self.h as f64 - 0.5 {
            return None;
        }
        let i = fx.round().clamp(0.0, (self.w - 1) as f64) as usize;
        let j = fy.round().clamp(0.0, (self.h - 1) as f64) as usize;
        let v = self.data[j * self.w + i];
        if v.is_nan() {
            None
        } else {
            Some(v)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bilinear_weights() {
        // 2x2 window, origin at (0, 2), res 1: pixel centers at x=0.5,1.5 y=1.5,0.5
        let w = Window {
            w: 2,
            h: 2,
            data: vec![0.0, 10.0, 20.0, 30.0], // rows top->bottom
            origin_x: 0.0,
            origin_y: 2.0,
            res_x: 1.0,
            res_y: 1.0,
        };
        assert!((w.sample_bilinear(0.5, 1.5) - 0.0).abs() < 1e-5);
        assert!((w.sample_bilinear(1.5, 1.5) - 10.0).abs() < 1e-5);
        assert!((w.sample_bilinear(0.5, 0.5) - 20.0).abs() < 1e-5);
        assert!((w.sample_bilinear(1.0, 1.0) - 15.0).abs() < 1e-5);
        assert_eq!(w.sample_bilinear(-5.0, 1.0), 0.0);
    }

    #[test]
    fn bilinear_nan_fallback() {
        let w = Window {
            w: 2,
            h: 2,
            data: vec![f32::NAN, 10.0, 20.0, 30.0],
            origin_x: 0.0,
            origin_y: 2.0,
            res_x: 1.0,
            res_y: 1.0,
        };
        // At the center, NaN corner is dropped and weights renormalized.
        let v = w.sample_bilinear(1.0, 1.0);
        assert!((v - 20.0).abs() < 1e-5, "got {v}");
    }
}
