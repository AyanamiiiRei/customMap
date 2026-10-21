//! dem2tiles: DEM GeoTIFF (EPSG:3857) -> terrarium-encoded PNG tiles in mbtiles.

use anyhow::{Context, Result};
use geotiles::cli;
use geotiles::dem::Raster;
use geotiles::encode::{encode_png_rgb, terrarium_encode};
use geotiles::mbtiles::{Mbtiles, TileRow};
use geotiles::tile;
use rayon::prelude::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let input = PathBuf::from(cli::arg_req(&args, "--input")?);
    let output = PathBuf::from(cli::arg_req(&args, "--output")?);
    let minzoom = cli::arg_u32(&args, "--minzoom", 0)?;
    let maxzoom = cli::arg_u32(&args, "--maxzoom", 12)?;

    let dem = Raster::open(&input).context("open DEM")?;
    let (rminx, rminy, rmaxx, rmaxy) = dem.extent();
    let (minlon, maxlat) = tile::meters_to_lonlat(rminx, rmaxy);
    let (maxlon, minlat) = tile::meters_to_lonlat(rmaxx, rminy);
    let bounds = (
        minlon.max(-180.0),
        minlat.max(-tile::MAX_LAT),
        maxlon.min(180.0),
        maxlat.min(tile::MAX_LAT),
    );
    eprintln!(
        "DEM {}x{}, bounds lon [{:.3}, {:.3}] lat [{:.3}, {:.3}]",
        dem.width, dem.height, bounds.0, bounds.2, bounds.1, bounds.3
    );

    let mut mb = Mbtiles::create(&output, "dem-terrarium", "png", minzoom, maxzoom, bounds)?;
    let done = AtomicUsize::new(0);

    for z in minzoom..=maxzoom {
        let (x0, x1, y0, y1) = tile::tiles_covering_bbox(z, bounds.0, bounds.1, bounds.2, bounds.3);
        eprintln!("z{z}: tiles x[{x0}..={x1}] y[{y0}..={y1}]");
        let res = tile::tile_res(z);
        for y in y0..=y1 {
            let rows: Vec<TileRow> = (x0..=x1)
                .into_par_iter()
                .map(|x| -> Result<TileRow> {
                    let (tminx, tminy, tmaxx, tmaxy) = tile::tile_bounds_meters(z, x, y);
                    // 258x258 grid: tile pixel centers shifted by -1 on each side.
                    let win = dem.read_merc_window(
                        tminx - res,
                        tminy - res,
                        tmaxx + res,
                        tmaxy + res,
                        res,
                    )?;
                    // Node (i, j) of the grid sits at tile pixel center (i-1, j-1).
                    let mut grid = vec![0.0f32; 258 * 258];
                    for j in 0..258usize {
                        for i in 0..258usize {
                            let mx = tminx + (i as f64 - 1.0 + 0.5) * res;
                            let my = tmaxy - (j as f64 - 1.0 + 0.5) * res;
                            grid[j * 258 + i] = win.sample_bilinear(mx, my);
                        }
                    }
                    // Output pixel = bilinear of the 4 surrounding nodes at
                    // (0.5, 0.5), i.e. the mean of 4 corners.
                    let mut rgb = vec![0u8; 256 * 256 * 3];
                    for v in 0..256usize {
                        for u in 0..256usize {
                            let e = (grid[v * 258 + u]
                                + grid[v * 258 + u + 1]
                                + grid[(v + 1) * 258 + u]
                                + grid[(v + 1) * 258 + u + 1])
                                as f64
                                * 0.25;
                            let [r, g, b] = terrarium_encode(e);
                            let o = (v * 256 + u) * 3;
                            rgb[o] = r;
                            rgb[o + 1] = g;
                            rgb[o + 2] = b;
                        }
                    }
                    let png = encode_png_rgb(&rgb, 256, 256)?;
                    let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if n % 500 == 0 {
                        eprintln!("  {n} tiles written");
                    }
                    Ok(TileRow {
                        z,
                        x,
                        tms_y: tile::tms_y(z, y),
                        data: png,
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
