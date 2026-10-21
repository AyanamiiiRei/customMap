//! Web Mercator (EPSG:3857) tile-grid math. XYZ scheme (y = 0 at the north).

pub const WEBMERC_HALF: f64 = 20037508.342789244;
pub const EARTH_R: f64 = 6378137.0;
pub const MAX_LAT: f64 = 85.05112878;
pub const TILE_PX: usize = 256;

/// WGS84 lon/lat -> EPSG:3857 meters.
pub fn lonlat_to_meters(lon: f64, lat: f64) -> (f64, f64) {
    let x = EARTH_R * lon.to_radians();
    let lat = lat.clamp(-MAX_LAT, MAX_LAT);
    let y = EARTH_R * (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0)
        .tan()
        .ln();
    (x, y)
}

/// EPSG:3857 meters -> WGS84 lon/lat.
pub fn meters_to_lonlat(x: f64, y: f64) -> (f64, f64) {
    let lon = (x / EARTH_R).to_degrees();
    let lat = (2.0 * (y / EARTH_R).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
    (lon, lat)
}

/// Edge length of one tile in meters at zoom z.
pub fn tile_size_meters(z: u32) -> f64 {
    2.0 * WEBMERC_HALF / (1u64 << z) as f64
}

/// Meters per tile pixel at zoom z.
pub fn tile_res(z: u32) -> f64 {
    tile_size_meters(z) / TILE_PX as f64
}

/// (minx, miny, maxx, maxy) of tile z/x/y in EPSG:3857 meters. y = 0 is north.
pub fn tile_bounds_meters(z: u32, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let size = tile_size_meters(z);
    let minx = -WEBMERC_HALF + x as f64 * size;
    let maxy = WEBMERC_HALF - y as f64 * size;
    (minx, maxy - size, minx + size, maxy)
}

/// Tile index range (xmin, xmax, ymin, ymax) at zoom z intersecting a lon/lat bbox.
pub fn tiles_covering_bbox(
    z: u32,
    minlon: f64,
    minlat: f64,
    maxlon: f64,
    maxlat: f64,
) -> (u32, u32, u32, u32) {
    let n = (1u64 << z) - 1;
    let size = tile_size_meters(z);
    let (x0, y1) = lonlat_to_meters(minlon, minlat); // bottom-left
    let (x1, y0) = lonlat_to_meters(maxlon, maxlat); // top-right
    let xmin = (((x0 + WEBMERC_HALF) / size).floor() as i64).clamp(0, n as i64) as u32;
    let xmax = (((x1 + WEBMERC_HALF) / size).floor() as i64).clamp(0, n as i64) as u32;
    let ymin = (((WEBMERC_HALF - y0) / size).floor() as i64).clamp(0, n as i64) as u32;
    let ymax = (((WEBMERC_HALF - y1) / size).floor() as i64).clamp(0, n as i64) as u32;
    (xmin, xmax, ymin, ymax)
}

/// XYZ y -> TMS tile_row used by mbtiles.
pub fn tms_y(z: u32, y: u32) -> u32 {
    ((1u64 << z) - 1) as u32 - y
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lonlat_meters_roundtrip() {
        for (lon, lat) in [(96.0, 26.0), (101.88, 29.6), (105.0, 35.0), (0.0, 0.0), (-73.0, 45.0)] {
            let (x, y) = lonlat_to_meters(lon, lat);
            let (lon2, lat2) = meters_to_lonlat(x, y);
            assert!((lon - lon2).abs() < 1e-9, "lon {lon} vs {lon2}");
            assert!((lat - lat2).abs() < 1e-9, "lat {lat} vs {lat2}");
        }
    }

    #[test]
    fn known_mercator_values() {
        let (x, y) = lonlat_to_meters(0.0, 0.0);
        assert!(x.abs() < 1e-6 && y.abs() < 1e-6);
        let (x, _) = lonlat_to_meters(180.0, 0.0);
        assert!((x - WEBMERC_HALF).abs() < 1e-4);
    }

    #[test]
    fn z0_covers_world() {
        let (minx, miny, maxx, maxy) = tile_bounds_meters(0, 0, 0);
        assert!((minx + WEBMERC_HALF).abs() < 1e-6);
        assert!((maxx - WEBMERC_HALF).abs() < 1e-6);
        assert!((miny + WEBMERC_HALF).abs() < 1e-6);
        assert!((maxy - WEBMERC_HALF).abs() < 1e-6);
    }

    #[test]
    fn bbox_tiles_z12() {
        // lon 96 at z12: (96+180)/360*4096 = 3140.4 -> tile 3140
        let (xmin, _, _, _) = tiles_covering_bbox(12, 96.0, 26.0, 96.5, 26.5);
        assert_eq!(xmin, 3140);
    }

    #[test]
    fn tms_conversion() {
        assert_eq!(tms_y(0, 0), 0);
        assert_eq!(tms_y(1, 0), 1);
        assert_eq!(tms_y(12, 0), 4095);
        assert_eq!(tms_y(12, 4095), 0);
    }

    #[test]
    fn tile_bounds_consistent_with_lonlat() {
        // Tile containing 贡嘎山 at z12
        let (xmin, xmax, ymin, ymax) = tiles_covering_bbox(12, 101.88, 29.59, 101.89, 29.61);
        assert_eq!(xmin, xmax);
        assert_eq!(ymin, ymax);
        let (minx, _, _, maxy) = tile_bounds_meters(12, xmin, ymin);
        let (lon, lat) = meters_to_lonlat(minx, maxy);
        assert!(lon <= 101.88 && lat >= 29.61);
    }
}
