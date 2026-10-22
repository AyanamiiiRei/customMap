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
    // 全球粗底用另一套更暗的高程色带，见 landcover::hypsometric_tint_world
    let world_palette = args.iter().any(|a| a == "--world-palette");
    // 研究区边缘的羽化宽度（米）：靠近边界时把颜色向「全球粗底色带」靠拢，
    // 这样细图和全球底拼在一起时不会出现一条矩形色差。0 = 硬边。
    let feather = cli::arg_value(&args, "--feather-meters")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    if format != "webp" && format != "png" {
        anyhow::bail!("--format must be webp or png, got {format}");
    }

    let dem = Raster::open(&dem_path).context("open DEM")?;
    // Pixels outside the DEM extent are rendered transparent, otherwise the
    // partial tiles along the bbox edge paint an opaque band of fallback colour
    // over the world basemap.
    let (ext_minx, ext_miny, ext_maxx, ext_maxy) = dem.extent();
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
        // z5-6 几乎完全用高程色带（和全球粗底一致），z7.5 之后交还给真实地类
        let zoom_blend = 0.30 + ((7.5 - z as f64) / 2.5).clamp(0.0, 0.62);
        for y in y0..=y1 {
            let rows: Vec<TileRow> = (x0..=x1)
                .into_par_iter()
                .map(|x| -> Result<TileRow> {
                    let format = format.as_str();
                    let (tminx, tminy, tmaxx, tmaxy) = tile::tile_bounds_meters(z, x, y);
                    let pad = BUF as f64 * res;
                    let dwin = dem.read_merc_window(tminx - pad, tminy - pad, tmaxx + pad, tmaxy + pad, res)?;
                    // Categorical raster: modal resampling. Bilinear would average
                    // class ids into values that match no class; nearest just picks
                    // one 10 m pixel per output cell, which at low zoom aliases into
                    // a mottled forest/grassland mosaic. GDAL's "mode" kernel picks
                    // the dominant class in each cell, which is what a land-cover
                    // map is supposed to show.
                    let lwin = lc.read_merc_window_r(
                        tminx - pad, tminy - pad, tmaxx + pad, tmaxy + pad, res, "mode",
                    )?;

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

                    // 3x3 majority vote on the categorical class map. Nearest
                    // sampling keeps isolated high-slope (bare-rock) pixels,
                    // which otherwise speckle the forest with warm-grey dots.
                    {
                        let src_c = class.clone();
                        let src_k = known.clone();
                        for j in 0..WIN {
                            for i in 0..WIN {
                                let mut counts: [(u8, u8); 9] = [(0, 0); 9];
                                let mut n = 0usize;
                                for dj in -1i32..=1 {
                                    for di in -1i32..=1 {
                                        let jj = (j as i32 + dj).clamp(0, WIN as i32 - 1) as usize;
                                        let ii = (i as i32 + di).clamp(0, WIN as i32 - 1) as usize;
                                        let k = jj * WIN + ii;
                                        if !src_k[k] {
                                            continue;
                                        }
                                        let c = src_c[k];
                                        let mut hit = false;
                                        for e in counts.iter_mut().take(n) {
                                            if e.0 == c {
                                                e.1 += 1;
                                                hit = true;
                                                break;
                                            }
                                        }
                                        if !hit && n < 9 {
                                            counts[n] = (c, 1);
                                            n += 1;
                                        }
                                    }
                                }
                                if n > 0 {
                                    let mut best = counts[0];
                                    for e in counts.iter().take(n) {
                                        if e.1 > best.1 {
                                            best = *e;
                                        }
                                    }
                                    let centre = j * WIN + i;
                                    if src_k[centre] {
                                        class[centre] = best.0;
                                    }
                                }
                            }
                        }
                    }

                    let (gx, gy) = shade::horn_gradients(&elev, WIN, WIN, res);
                    let mean11 = shade::box_mean_11(&elev, WIN, WIN);

                    let mut rgb = vec![0u8; 256 * 256 * 4];
                    for v in 0..256usize {
                        for u in 0..256usize {
                            let i = u + BUF;
                            let j = v + BUF;
                            let idx = j * WIN + i;
                            let e = elev[idx];
                            let slope = shade::slope_deg(gx[idx], gy[idx]);
                            let hypso = if world_palette {
                                landcover::hypsometric_tint_world(e, slope)
                            } else {
                                landcover::hypsometric_tint(e, slope)
                            };
                            // 低 zoom 时一个像素代表几公里，WorldCover 的「主导地类」
                            // 已经没有意义（整片森林会被涂成一块深绿），所以要向
                            // 高程色带靠拢——靠拢的目标和全球粗底用的是同一条色带，
                            // 两块拼图在 z5-7 才会无缝。
                            let blend_target = landcover::hypsometric_tint_world(e, slope);

                            let mx = tminx + (u as f64 + 0.5) * res;
                            let my = tmaxy - (v as f64 + 0.5) * res;
                            // 海面：ETOPO/全球 DEM 带水深，直接按深度上色，
                            // 不做晕渲也不做噪声（平坦海面加噪声只会脏）。
                            if e < -0.5 {
                                let c = landcover::ocean_color(-e);
                                let o = (v * 256 + u) * 4;
                                let inside = mx >= ext_minx && mx <= ext_maxx
                                    && my >= ext_miny && my <= ext_maxy;
                                rgb[o] = c[0].round().clamp(0.0, 255.0) as u8;
                                rgb[o + 1] = c[1].round().clamp(0.0, 255.0) as u8;
                                rgb[o + 2] = c[2].round().clamp(0.0, 255.0) as u8;
                                rgb[o + 3] = if inside { 255 } else { 0 };
                                continue;
                            }
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

                            let w = landcover::hypsometric_weight(e).max(zoom_blend);
                            base = landcover::mix(base, blend_target, w);
                            let s = shade::hillshade_multi(gx[idx], gy[idx]);
                            base = [
                                base[0] * (0.50 + 0.50 * s),
                                base[1] * (0.50 + 0.50 * s),
                                base[2] * (0.50 + 0.50 * s),
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
                                base[0] * (1.0 + 0.09 * n),
                                base[1] * (1.0 + 0.09 * n),
                                base[2] * (1.0 + 0.09 * n),
                            ];
                            let mut c = landcover::desaturate(base, 0.06);
                            if feather > 0.0 {
                                let dx = (mx - ext_minx).min(ext_maxx - mx);
                                let dy = (my - ext_miny).min(ext_maxy - my);
                                let d = dx.min(dy);
                                if d < feather {
                                    let t = 1.0 - (d / feather).clamp(0.0, 1.0);
                                    let wc = landcover::hypsometric_tint_world(e, slope);
                                    c = landcover::mix(c, wc, t * 0.92);
                                }
                            }
                            let mx = tminx + (u as f64 + 0.5) * res;
                            let my = tmaxy - (v as f64 + 0.5) * res;
                            let inside = mx >= ext_minx && mx <= ext_maxx
                                && my >= ext_miny && my <= ext_maxy;
                            let o = (v * 256 + u) * 4;
                            rgb[o] = c[0].round().clamp(0.0, 255.0) as u8;
                            rgb[o + 1] = c[1].round().clamp(0.0, 255.0) as u8;
                            rgb[o + 2] = c[2].round().clamp(0.0, 255.0) as u8;
                            rgb[o + 3] = if inside { 255 } else { 0 };
                        }
                    }
                    let img = match format {
                        "png" => {
                            // drop alpha for the debug PNG path
                            let mut out = Vec::with_capacity(256 * 256 * 3);
                            for px in rgb.chunks_exact(4) {
                                out.extend_from_slice(&px[..3]);
                            }
                            encode_png_rgb(&out, 256, 256)?
                        }
                        _ => webp::Encoder::from_rgba(&rgb, 256, 256)
                            .encode(88.0)
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
