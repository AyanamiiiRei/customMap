//! contours: marching squares over the DEM, one output file per zoom tier:
//!   z9  -> 500 m interval (usable z9-z11)
//!   z12 -> 200 m          (z12-z13)
//!   z14 -> 100 m          (z14)
//!   z15 ->  50 m          (z15)
//!
//! Output: GeoJSONL (one Feature per line), WGS84 coordinates, properties
//! ele (integer meters), idx (1 = index contour, every 5th), minzoom.
//! Files are named <output-stem>-z<zoom>.geojsonl next to --output.
//!
//! Processing is banded by tile row: one gdal_translate window read per row
//! band keeps subprocess count low even at z15. Each tile owns the cells whose
//! lower-left node lies inside the tile, so lines from adjacent tiles meet at
//! identical coordinates without duplicates.

use anyhow::{Context, Result};
use geotiles::cli;
use geotiles::contour;
use geotiles::dem::Raster;
use geotiles::tile;
use rayon::prelude::*;
use std::io::Write as IoWrite;
use std::path::PathBuf;

const BUF_PX: usize = 16;
const TIERS: [(u32, f64); 4] = [(9, 500.0), (12, 200.0), (14, 100.0), (15, 50.0)];

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dem_path = PathBuf::from(cli::arg_req(&args, "--dem")?);
    let output = PathBuf::from(cli::arg_req(&args, "--output")?);
    let bbox = cli::arg_bbox(&args, "--bbox")?;

    let dem = Raster::open(&dem_path).context("open DEM")?;
    eprintln!("DEM {}x{}", dem.width, dem.height);

    let stem = output.with_extension(""); // contours.geojsonl -> contours

    for (z, interval) in TIERS {
        let path = stem.with_file_name(format!(
            "{}-z{}.geojsonl",
            stem.file_name().unwrap().to_string_lossy(),
            z
        ));
        let (x0, x1, y0, y1) = tile::tiles_covering_bbox(z, bbox.0, bbox.1, bbox.2, bbox.3);
        eprintln!("z{z} interval {interval}m: x[{x0}..={x1}] y[{y0}..={y1}] -> {}", path.display());
        let res = tile::tile_res(z);
        let tol = 0.3 * res; // 0.3 tile pixel
        let mut file = std::io::BufWriter::new(std::fs::File::create(&path)?);
        let mut total = 0usize;

        for y in y0..=y1 {
            // One window covering the whole tile row + buffer.
            let (rminx, _, _, _) = tile::tile_bounds_meters(z, x0, y);
            let (_, rminy, rmaxx, rmaxy) = tile::tile_bounds_meters(z, x1, y);
            let pad = BUF_PX as f64 * res;
            let win = dem.read_merc_window(
                rminx - pad,
                rminy - pad,
                rmaxx + pad,
                rmaxy + pad,
                res,
            )?;
            let gres = win.res_x;

            let row_lines: Vec<String> = (x0..=x1)
                .into_par_iter()
                .map(|x| -> Vec<String> {
                    let (tminx, _, tmaxx, tmaxy) = tile::tile_bounds_meters(z, x, y);
                    // Node index of tile pixel (0,0) center.
                    let i_lo = ((tminx + 0.5 * res - win.origin_x) / gres - 0.5).round().max(0.0) as usize;
                    let j_lo = ((win.origin_y - (tmaxy - 0.5 * res)) / gres - 0.5).round().max(0.0) as usize;
                    let ncols = ((tmaxx - tminx) / gres).round().max(1.0) as usize;
                    let nrows = ncols;

                    // Elevation range inside this tile's cells.
                    let imax = (i_lo + ncols).min(win.w.saturating_sub(1));
                    let jmax = (j_lo + nrows).min(win.h.saturating_sub(1));
                    if imax <= i_lo || jmax <= j_lo {
                        return Vec::new();
                    }
                    let mut lo = f64::INFINITY;
                    let mut hi = f64::NEG_INFINITY;
                    for j in j_lo..=jmax {
                        for i in i_lo..=imax {
                            let v = win.data[j * win.w + i];
                            if !v.is_nan() {
                                lo = lo.min(v as f64);
                                hi = hi.max(v as f64);
                            }
                        }
                    }
                    if !lo.is_finite() {
                        return Vec::new();
                    }

                    let mut out = Vec::new();
                    let k0 = (lo / interval).floor() as i64 + 1;
                    let k1 = (hi / interval).floor() as i64;
                    for k in k0..=k1 {
                        let level = k as f64 * interval;
                        let segs = contour::march(&win.data, win.w, win.h, i_lo, j_lo, ncols, nrows, level);
                        let lines = contour::chain(segs);
                        for line in lines {
                            // Node units -> meters -> simplify -> lonlat.
                            let meters: Vec<(f64, f64)> = line
                                .iter()
                                .map(|&(nx, ny)| {
                                    (
                                        win.origin_x + (nx + 0.5) * win.res_x,
                                        win.origin_y - (ny + 0.5) * win.res_y,
                                    )
                                })
                                .collect();
                            let keep = contour::simplify(&meters, tol);
                            if keep.len() < 2 {
                                continue;
                            }
                            let coords: Vec<(f64, f64)> = keep
                                .iter()
                                .map(|&(mx, my)| tile::meters_to_lonlat(mx, my))
                                .collect();
                            // Drop lines fully outside the bbox.
                            let (mut mlon0, mut mlon1) = (f64::INFINITY, f64::NEG_INFINITY);
                            let (mut mlat0, mut mlat1) = (f64::INFINITY, f64::NEG_INFINITY);
                            for &(lon, lat) in &coords {
                                mlon0 = mlon0.min(lon);
                                mlon1 = mlon1.max(lon);
                                mlat0 = mlat0.min(lat);
                                mlat1 = mlat1.max(lat);
                            }
                            if mlon1 < bbox.0 || mlon0 > bbox.2 || mlat1 < bbox.1 || mlat0 > bbox.3 {
                                continue;
                            }
                            let ele = k as i64 * interval as i64;
                            let idx = if (ele / interval as i64) % 5 == 0 { 1 } else { 0 };
                            let mut s = String::with_capacity(coords.len() * 24 + 128);
                            s.push_str(&format!(
                                "{{\"type\":\"Feature\",\"properties\":{{\"ele\":{},\"idx\":{},\"minzoom\":{}}},\"geometry\":{{\"type\":\"LineString\",\"coordinates\":[",
                                ele, idx, z
                            ));
                            for (n, (lon, lat)) in coords.iter().enumerate() {
                                if n > 0 {
                                    s.push(',');
                                }
                                s.push_str(&format!("[{:.7},{:.7}]", lon, lat));
                            }
                            s.push_str("]}}");
                            out.push(s);
                        }
                    }
                    out
                })
                .reduce(Vec::new, |mut a, b| {
                    a.extend(b);
                    a
                });
            for line in &row_lines {
                writeln!(file, "{}", line)?;
            }
            total += row_lines.len();
        }
        file.flush()?;
        eprintln!("  z{z}: {total} contour lines");
    }
    Ok(())
}
