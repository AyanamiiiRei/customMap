//! Tiny CLI flag parsing shared by the binaries.

use anyhow::{bail, Result};

pub fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

pub fn arg_req(args: &[String], key: &str) -> Result<String> {
    match arg_value(args, key) {
        Some(v) => Ok(v),
        None => bail!("missing required argument {key}"),
    }
}

pub fn arg_u32(args: &[String], key: &str, default: u32) -> Result<u32> {
    match arg_value(args, key) {
        Some(v) => Ok(v.parse()?),
        None => Ok(default),
    }
}

/// Parse "minlon,minlat,maxlon,maxlat".
pub fn arg_bbox(args: &[String], key: &str) -> Result<(f64, f64, f64, f64)> {
    let v = arg_req(args, key)?;
    let parts: Result<Vec<f64>, _> = v.split(',').map(|s| s.trim().parse::<f64>()).collect();
    let parts = parts?;
    if parts.len() != 4 {
        bail!("{key} must be minlon,minlat,maxlon,maxlat");
    }
    Ok((parts[0], parts[1], parts[2], parts[3]))
}
