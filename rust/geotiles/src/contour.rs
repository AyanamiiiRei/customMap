//! Marching squares contour extraction, segment chaining, Douglas-Peucker
//! simplification. All coordinates are in fractional grid-node units; the
//! caller maps them to world coordinates.

use std::collections::HashMap;

pub type Point = (f64, f64);
pub type Segment = (Point, Point);

/// Extract contour segments for one level from a grid (row-major, NaN cells
/// skipped) restricted to cells [i0, i0+ncols) x [j0, j0+nrows).
pub fn march(
    data: &[f32],
    w: usize,
    h: usize,
    i0: usize,
    j0: usize,
    ncols: usize,
    nrows: usize,
    level: f64,
) -> Vec<Segment> {
    let mut segs = Vec::new();
    let imax = (i0 + ncols).min(w.saturating_sub(1));
    let jmax = (j0 + nrows).min(h.saturating_sub(1));
    for j in j0..jmax {
        for i in i0..imax {
            let a = data[j * w + i] as f64;
            let b = data[j * w + i + 1] as f64;
            let c = data[(j + 1) * w + i + 1] as f64;
            let d = data[(j + 1) * w + i] as f64;
            if a.is_nan() || b.is_nan() || c.is_nan() || d.is_nan() {
                continue;
            }
            let mut case = 0u8;
            if a >= level {
                case |= 1;
            }
            if b >= level {
                case |= 2;
            }
            if c >= level {
                case |= 4;
            }
            if d >= level {
                case |= 8;
            }
            if case == 0 || case == 15 {
                continue;
            }
            let lerp = |v0: f64, v1: f64| -> f64 {
                let den = v1 - v0;
                if den.abs() < 1e-12 {
                    0.5
                } else {
                    ((level - v0) / den).clamp(0.0, 1.0)
                }
            };
            let top = (i as f64 + lerp(a, b), j as f64);
            let right = (i as f64 + 1.0, j as f64 + lerp(b, c));
            let bottom = (i as f64 + lerp(d, c), j as f64 + 1.0);
            let left = (i as f64, j as f64 + lerp(a, d));
            match case {
                1 | 14 => segs.push((left, top)),
                2 | 13 => segs.push((top, right)),
                3 | 12 => segs.push((left, right)),
                4 | 11 => segs.push((right, bottom)),
                5 => {
                    segs.push((top, left));
                    segs.push((right, bottom));
                }
                6 | 9 => segs.push((top, bottom)),
                7 | 8 => segs.push((left, bottom)),
                10 => {
                    segs.push((top, right));
                    segs.push((left, bottom));
                }
                _ => {}
            }
        }
    }
    segs
}

fn key(p: Point) -> (i64, i64) {
    ((p.0 * 1e6).round() as i64, (p.1 * 1e6).round() as i64)
}

/// Chain unordered segments into polylines (closed rings included).
pub fn chain(segs: Vec<Segment>) -> Vec<Vec<Point>> {
    let mut by_point: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, s) in segs.iter().enumerate() {
        by_point.entry(key(s.0)).or_default().push(i);
        by_point.entry(key(s.1)).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    let mut lines = Vec::new();
    for start in 0..segs.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut line: Vec<Point> = vec![segs[start].0, segs[start].1];
        // Extend backwards and forwards.
        for forward in [false, true] {
            loop {
                let end = if forward { *line.last().unwrap() } else { line[0] };
                let next = by_point.get(&key(end)).and_then(|cands| {
                    cands.iter().copied().find(|&c| !used[c])
                });
                match next {
                    Some(si) => {
                        used[si] = true;
                        let s = segs[si];
                        let other = if key(s.0) == key(end) { s.1 } else { s.0 };
                        if forward {
                            line.push(other);
                        } else {
                            line.insert(0, other);
                        }
                    }
                    None => break,
                }
            }
        }
        if line.len() >= 2 {
            lines.push(line);
        }
    }
    lines
}

/// Douglas-Peucker simplification (iterative).
pub fn simplify(pts: &[Point], tol: f64) -> Vec<Point> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let n = pts.len();
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let (ax, ay) = pts[a];
        let (bx, by) = pts[b];
        let dx = bx - ax;
        let dy = by - ay;
        let len2 = dx * dx + dy * dy;
        let mut max_d = 0.0f64;
        let mut max_i = a;
        for i in a + 1..b {
            let d = if len2 < 1e-12 {
                let px = pts[i].0 - ax;
                let py = pts[i].1 - ay;
                (px * px + py * py).sqrt()
            } else {
                let t = ((pts[i].0 - ax) * dx + (pts[i].1 - ay) * dy) / len2;
                let px = pts[i].0 - (ax + t.clamp(0.0, 1.0) * dx);
                let py = pts[i].1 - (ay + t.clamp(0.0, 1.0) * dy);
                (px * px + py * py).sqrt()
            };
            if d > max_d {
                max_d = d;
                max_i = i;
            }
        }
        if max_d > tol {
            keep[max_i] = true;
            stack.push((a, max_i));
            stack.push((max_i, b));
        }
    }
    pts.iter().zip(keep).filter_map(|(p, k)| k.then_some(*p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_plane_one_level() {
        // Ramp 0..9 horizontally, level 4.5 -> vertical lines at x=4.5.
        let w = 10;
        let h = 4;
        let data: Vec<f32> = (0..h).flat_map(|_| (0..w).map(|i| i as f32)).collect();
        let segs = march(&data, w, h, 0, 0, w - 1, h - 1, 4.5);
        assert_eq!(segs.len(), 3);
        for (p, q) in &segs {
            assert!((p.0 - 4.5).abs() < 1e-6 && (q.0 - 4.5).abs() < 1e-6);
        }
        let lines = chain(segs);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 4);
    }

    #[test]
    fn closed_ring() {
        // Peak in the middle of a 5x5 grid -> one closed ring at level 5.
        let w = 5;
        let mut data = vec![0.0f32; 25];
        data[2 * w + 2] = 10.0;
        let segs = march(&data, w, w, 0, 0, w - 1, w - 1, 5.0);
        let lines = chain(segs);
        assert_eq!(lines.len(), 1);
        let l = &lines[0];
        let first = key(l[0]);
        let last = key(*l.last().unwrap());
        assert_eq!(first, last, "ring should close");
    }

    #[test]
    fn simplify_straight_line() {
        let pts: Vec<Point> = (0..100).map(|i| (i as f64, 0.001 * (i % 2) as f64)).collect();
        let out = simplify(&pts, 0.01);
        assert_eq!(out.len(), 2);
    }
}
