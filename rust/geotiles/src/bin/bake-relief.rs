//! bake-relief: DEM + WorldCover -> shaded relief PNG tiles in mbtiles.
//!
//! Per-pixel pipeline (all filters run on an 8 px buffered window and are
//! cropped back to 256x256, so tiles join seamlessly):
//!   base = landcover_color(class)          (unknown -> hypsometric tint)
//!   vegetation base gets +-8% brightness perturbation (noise + slope)
//!   base = mix(base, hypsometric_tint(elev, slope), 0.35)
//!   base *= 0.55 + 0.45 * slope_shade      (4-azimuth hillshade mean, [0,1])
//!   base *= 1 - 0.25 * concavity           ((mean11 - elev)/60 clamped [-1,1])
//!   base *= 1 + 0.12 * noise(u, v)         (deterministic, seamless)
//!   desaturate 10% towards grey

use anyhow::{Context, Result};
use geotiles::cli;
use geotiles::dem::Raster;
use geotiles::encode::encode_png_rgb;
use geotiles::landcover;
use geotiles::mbtiles::{Mbtiles, TileRow};
use geotiles::shade;
use geotiles::tile;
use rayon::prelude::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const BUF: usize = 8; // 11x11 mean needs 5 + 3x3 gradient needs 1
const WIN: usize = 256 + 2 * BUF;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dem_path = PathBuf::from(cli::arg_req(&args, "--dem")?);
    let lc_path = PathBuf::from(cli::arg_req(&args, "--landcover")?);
    let output = PathBuf::from(cli::arg_req(&args, "--output")?);
    let minzoom = cli::arg_u32(&args, "--minzoom", 0)?;
    let maxzoom = cli::arg_u32(&args, "--maxzoom", 13)?;
    let format = cli::arg_value(&args, "--format").unwrap_or_else(|| "webp".to_string());
    if format != "webp" && format != "png" {
        anyhow::bail!("--format must be webp or png, got {format}");
    }

    let dem = Raster::open(&dem_path).context("open DEM")?;
    let lc = Raster::open(&lc_path).context("open landcover")?;
    let (rminx, rminy, rmaxx, rmaxy) = dem.extent();
    let (minlon, maxlat) = tile::meters_to_lonlat(rminx, rmaxy);
    let (maxlon, minlat) = tile::meters_to_lonlat(rmaxx, rminy);
    let bounds = (
        minlon.max(-180.0),
        minlat.max(-tile::MAX_LAT),
        maxlon.min(180.0),
        maxlat.min(tile::MAX_LAT),
    );
    eprintln!("bounds lon [{:.3}, {:.3}] lat [{:.3}, {:.3}]", bounds.0, bounds.2, bounds.1, bounds.3);

    let mut mb = Mbtiles::create(&output, "relief", &format, minzoom, maxzoom, bounds)?;
    let done = AtomicUsize::new(0);

    for z in minzoom..=maxzoom {
        let (x0, x1, y0, y1) = tile::tiles_covering_bbox(z, bounds.0, bounds.1, bounds.2, bounds.3);
        eprintln!("z{z}: tiles x[{x0}..={x1}] y[{y0}..={y1}]");
        let res = tile::tile_res(z);
        for y in y0..=y1 {
            let rows: Vec<TileRow> = (x0..=x1)
                .into_par_iter()
                .map(|x| -> Result<TileRow> {
                    let format = format.as_str();
                    let (tminx, tminy, tmaxx, tmaxy) = tile::tile_bounds_meters(z, x, y);
                    let pad = BUF as f64 * res;
                    let dwin = dem.read_merc_window(tminx - pad, tminy - pad, tmaxx + pad, tmaxy + pad, res)?;
                    let lwin = lc.read_merc_window(tminx - pad, tminy - pad, tmaxx + pad, tmaxy + pad, res)?;

                    // Sample both rasters onto the buffered tile grid.
                    let mut elev = vec![0f64; WIN * WIN];
                    let mut class = vec![0u8; WIN * WIN];
                    let mut known = vec![false; WIN * WIN];
                    for j in 0..WIN {
                        for i in 0..WIN {
                            let mx = tminx + (i as f64 - BUF as f64 + 0.5) * res;
                            let my = tmaxy - (j as f64 - BUF as f64 + 0.5) * res;
                            elev[j * WIN + i] = dwin.sample_bilinear(mx, my) as f64;
                            match lwin.sample_nearest(mx, my) {
                                Some(c) if landcover::landcover_color(c as u8).is_some() => {
                                    class[j * WIN + i] = c as u8;
                                    known[j * WIN + i] = true;
                                }
                                _ => {}
                            }
                        }
                    }

                    let (gx, gy) = shade::horn_gradients(&elev, WIN, WIN, res);
                    let mean11 = shade::box_mean_11(&elev, WIN, WIN);

                    let mut rgb = vec![0u8; 256 * 256 * 3];
                    for v in 0..256usize {
                        for u in 0..256usize {
                            let i = u + BUF;
                            let j = v + BUF;
                            let idx = j * WIN + i;
                            let e = elev[idx];
                            let slope = shade::slope_deg(gx[idx], gy[idx]);
                            let hypso = landcover::hypsometric_tint(e, slope);

                            let mut base = if known[idx] {
                                landcover::landcover_color(class[idx]).unwrap()
                            } else {
                                hypso
                            };
                            // +-8% brightness perturbation inside vegetation.
                            if known[idx] && landcover::is_vegetation(class[idx]) {
                                let ngx = (x as usize * 256 + u) as f64;
                                let ngy = (y as usize * 256 + v) as f64;
                                let n = shade::value_noise(ngx / 7.0 + 31.0, ngy / 7.0 + 17.0);
                                let f = (1.0 + 0.08 * (2.0 * n - 1.0) - 0.02 * (slope / 45.0))
                                    .clamp(0.92, 1.08);
                                base = [base[0] * f, base[1] * f, base[2] * f];
                            }

                            base = landcover::mix(base, hypso, 0.35);
                            let s = shade::hillshade_multi(gx[idx], gy[idx]);
                            base = [
                                base[0] * (0.55 + 0.45 * s),
                                base[1] * (0.55 + 0.45 * s),
                                base[2] * (0.55 + 0.45 * s),
                            ];
                            let conc = ((mean11[idx] - e) / 60.0).clamp(-1.0, 1.0);
                            base = [
                                base[0] * (1.0 - 0.25 * conc),
                                base[1] * (1.0 - 0.25 * conc),
                                base[2] * (1.0 - 0.25 * conc),
                            ];
                            let ngx = (x as usize * 256 + u) as f64;
                            let ngy = (y as usize * 256 + v) as f64;
                            let n = shade::noise_fractal(ngx, ngy);
                            base = [
                                base[0] * (1.0 + 0.12 * n),
                                base[1] * (1.0 + 0.12 * n),
                                base[2] * (1.0 + 0.12 * n),
                            ];
                            let c = landcover::desaturate(base, 0.1);
                            let o = (v * 256 + u) * 3;
                            rgb[o] = c[0].round().clamp(0.0, 255.0) as u8;
                            rgb[o + 1] = c[1].round().clamp(0.0, 255.0) as u8;
                            rgb[o + 2] = c[2].round().clamp(0.0, 255.0) as u8;
                        }
                    }
                    let img = match format {
                        "png" => encode_png_rgb(&rgb, 256, 256)?,
                        _ => webp::Encoder::from_rgb(&rgb, 256, 256)
                            .encode(85.0)
                            .to_vec(),
                    };
                    let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if n % 500 == 0 {
                        eprintln!("  {n} tiles written");
                    }
                    Ok(TileRow {
                        z,
                        x,
                        tms_y: tile::tms_y(z, y),
                        data: img,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            mb.write_batch(&rows)?;
        }
    }
    mb.finish()?;
    eprintln!("done: {} tiles -> {}", mb.count()?, output.display());
    Ok(())
}
