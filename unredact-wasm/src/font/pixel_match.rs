const BINARIZE_THRESHOLD: u8 = 128;

/// Dice coefficient between two grayscale images (same dimensions).
/// Ink pixels = value < BINARIZE_THRESHOLD.
/// Returns 0.0 if neither image has ink.
pub fn dice_score(page_gray: &[u8], rendered_gray: &[u8], w: u32, h: u32) -> f64 {
    let n = (w * h) as usize;
    assert_eq!(page_gray.len(), n, "page_gray length must equal w * h");
    assert_eq!(rendered_gray.len(), n, "rendered_gray length must equal w * h");

    let mut page_ink: u64 = 0;
    let mut rendered_ink: u64 = 0;
    let mut intersection: u64 = 0;

    for i in 0..n {
        let p = page_gray[i] < BINARIZE_THRESHOLD;
        let r = rendered_gray[i] < BINARIZE_THRESHOLD;
        if p { page_ink += 1; }
        if r { rendered_ink += 1; }
        if p && r { intersection += 1; }
    }

    let denom = page_ink + rendered_ink;
    if denom == 0 {
        return 0.0;
    }
    2.0 * intersection as f64 / denom as f64
}

/// Best Dice score across all shifts in [-shift_range, +shift_range] for both dx and dy.
/// The rendered image is shifted relative to the page image.
/// Only the overlapping region is compared at each shift.
pub fn best_dice_score(
    page_gray: &[u8],
    rendered_gray: &[u8],
    w: u32,
    h: u32,
    shift_range: i32,
) -> f64 {
    let n = (w * h) as usize;
    assert_eq!(page_gray.len(), n, "page_gray length must equal w * h");
    assert_eq!(rendered_gray.len(), n, "rendered_gray length must equal w * h");

    let w = w as i32;
    let h = h as i32;
    let mut best = 0.0_f64;

    for dy in -shift_range..=shift_range {
        for dx in -shift_range..=shift_range {
            // Determine overlap region for page coordinates
            let px_start = dx.max(0);
            let px_end = (w + dx).min(w);
            let py_start = dy.max(0);
            let py_end = (h + dy).min(h);

            // Corresponding rendered coordinates: rx = px - dx, ry = py - dy
            if px_start >= px_end || py_start >= py_end {
                continue;
            }

            let mut page_ink: u64 = 0;
            let mut rendered_ink: u64 = 0;
            let mut intersection: u64 = 0;

            for py in py_start..py_end {
                let ry = py - dy;
                for px in px_start..px_end {
                    let rx = px - dx;
                    let p = page_gray[(py * w + px) as usize] < BINARIZE_THRESHOLD;
                    let r = rendered_gray[(ry * w + rx) as usize] < BINARIZE_THRESHOLD;
                    if p { page_ink += 1; }
                    if r { rendered_ink += 1; }
                    if p && r { intersection += 1; }
                }
            }

            let denom = page_ink + rendered_ink;
            if denom > 0 {
                let score = 2.0 * intersection as f64 / denom as f64;
                if score > best {
                    best = score;
                }
            }
        }
    }

    best
}

/// Normalized cross-correlation (NCC) on grayscale "ink intensity" values.
///
/// Converts pixel values to ink intensity: ink = (255 - gray) / 255.0
/// so white (255) → 0.0 and black (0) → 1.0. Then computes NCC
/// which measures how well the shapes of the two signals match,
/// independent of overall brightness.
///
/// Returns value in [0.0, 1.0] where 1.0 = perfect match.
/// Returns 0.0 if either image has no variation (all white).
fn ncc_score_at_shift(
    page_gray: &[u8],
    rendered_gray: &[u8],
    w: i32,
    h: i32,
    dx: i32,
    dy: i32,
) -> f64 {
    let px_start = dx.max(0);
    let px_end = (w + dx).min(w);
    let py_start = dy.max(0);
    let py_end = (h + dy).min(h);

    if px_start >= px_end || py_start >= py_end {
        return 0.0;
    }

    let mut sum_p: f64 = 0.0;
    let mut sum_r: f64 = 0.0;
    let mut sum_pp: f64 = 0.0;
    let mut sum_rr: f64 = 0.0;
    let mut sum_pr: f64 = 0.0;
    let mut count: u64 = 0;

    for py in py_start..py_end {
        let ry = py - dy;
        for px in px_start..px_end {
            let rx = px - dx;
            // Convert to ink intensity: 0.0 (white) to 1.0 (black)
            let p = (255 - page_gray[(py * w + px) as usize] as u16) as f64 / 255.0;
            let r = (255 - rendered_gray[(ry * w + rx) as usize] as u16) as f64 / 255.0;
            sum_p += p;
            sum_r += r;
            sum_pp += p * p;
            sum_rr += r * r;
            sum_pr += p * r;
            count += 1;
        }
    }

    if count == 0 {
        return 0.0;
    }

    let n = count as f64;
    let mean_p = sum_p / n;
    let mean_r = sum_r / n;

    // Variance and covariance
    let var_p = sum_pp / n - mean_p * mean_p;
    let var_r = sum_rr / n - mean_r * mean_r;
    let covar = sum_pr / n - mean_p * mean_r;

    let denom = (var_p * var_r).sqrt();
    if denom < 1e-10 {
        return 0.0;
    }

    // NCC ranges [-1, 1]; clamp to [0, 1] since negative correlation = bad match
    (covar / denom).max(0.0)
}

/// Best NCC score across all shifts in [-shift_range, +shift_range].
pub fn best_ncc_score(
    page_gray: &[u8],
    rendered_gray: &[u8],
    w: u32,
    h: u32,
    shift_range: i32,
) -> f64 {
    let n = (w * h) as usize;
    assert_eq!(page_gray.len(), n, "page_gray length must equal w * h");
    assert_eq!(rendered_gray.len(), n, "rendered_gray length must equal w * h");

    let w = w as i32;
    let h = h as i32;
    let mut best = 0.0_f64;

    for dy in -shift_range..=shift_range {
        for dx in -shift_range..=shift_range {
            let score = ncc_score_at_shift(page_gray, rendered_gray, w, h, dx, dy);
            if score > best {
                best = score;
            }
        }
    }

    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_images_score_1() {
        // Both images have same ink pattern
        let mut img = vec![255u8; 100]; // 10x10 all white
        img[0] = 0; img[1] = 0; img[10] = 0; // 3 ink pixels
        let score = dice_score(&img, &img, 10, 10);
        assert!((score - 1.0).abs() < 0.001);
    }

    #[test]
    fn no_overlap_scores_0() {
        let mut a = vec![255u8; 100];
        let mut b = vec![255u8; 100];
        a[0] = 0; // ink at (0,0)
        b[99] = 0; // ink at (9,9)
        let score = dice_score(&a, &b, 10, 10);
        assert!((score - 0.0).abs() < 0.001);
    }

    #[test]
    fn all_white_scores_0() {
        let img = vec![255u8; 100];
        let score = dice_score(&img, &img, 10, 10);
        assert!((score - 0.0).abs() < 0.001);
    }

    #[test]
    fn half_overlap_score() {
        let mut a = vec![255u8; 100];
        let mut b = vec![255u8; 100];
        // a has ink at 0,1,2,3 (4 pixels)
        a[0] = 0; a[1] = 0; a[2] = 0; a[3] = 0;
        // b has ink at 2,3,4,5 (4 pixels)
        b[2] = 0; b[3] = 0; b[4] = 0; b[5] = 0;
        // intersection = 2, dice = 2*2/(4+4) = 0.5
        let score = dice_score(&a, &b, 10, 10);
        assert!((score - 0.5).abs() < 0.001);
    }

    #[test]
    fn shift_finds_offset_match() {
        let mut page = vec![255u8; 100]; // 10x10
        let mut rendered = vec![255u8; 100];
        // page ink at x=3..6, y=4..6 (3x2 = 6 pixels)
        for y in 4..6 { for x in 3..6 { page[y * 10 + x] = 0; } }
        // rendered ink at x=5..8, y=4..6 — shifted +2 in x
        for y in 4..6 { for x in 5..8 { rendered[y * 10 + x] = 0; } }
        // Without shift: overlap is only x=5 (1 col), dice = 2*2/(6+6) = 0.333
        let no_shift = dice_score(&page, &rendered, 10, 10);
        assert!(no_shift < 0.5);
        // With shift search: should find dx=2 giving perfect overlap
        let shifted = best_dice_score(&page, &rendered, 10, 10, 3);
        assert!((shifted - 1.0).abs() < 0.001);
    }

    #[test]
    fn ncc_identical_scores_1() {
        let mut img = vec![255u8; 100];
        img[0] = 0; img[1] = 50; img[10] = 100;
        let score = best_ncc_score(&img, &img, 10, 10, 0);
        assert!((score - 1.0).abs() < 0.001);
    }

    #[test]
    fn ncc_all_white_scores_0() {
        let img = vec![255u8; 100];
        let score = best_ncc_score(&img, &img, 10, 10, 0);
        assert!(score < 0.001);
    }

    #[test]
    fn ncc_antialiased_serif_vs_sans() {
        // Simulate: page has a serif stroke pattern (thin extensions)
        // Serif rendering should correlate better with serif page than sans does
        let mut page = vec![255u8; 200]; // 20x10
        let mut serif = vec![255u8; 200];
        let mut sans = vec![255u8; 200];

        // Page: vertical stroke + horizontal serifs at top and bottom
        for y in 0..10 { page[y * 20 + 10] = 0; } // vertical stroke
        for x in 8..13 { page[0 * 20 + x] = 0; page[9 * 20 + x] = 0; } // serifs
        // Antialiasing around serifs
        page[0 * 20 + 7] = 180; page[0 * 20 + 13] = 180;
        page[9 * 20 + 7] = 180; page[9 * 20 + 13] = 180;

        // Serif rendered: same pattern
        for y in 0..10 { serif[y * 20 + 10] = 0; }
        for x in 8..13 { serif[0 * 20 + x] = 0; serif[9 * 20 + x] = 0; }
        serif[0 * 20 + 7] = 180; serif[0 * 20 + 13] = 180;
        serif[9 * 20 + 7] = 180; serif[9 * 20 + 13] = 180;

        // Sans rendered: just the vertical stroke, no serifs
        for y in 0..10 { sans[y * 20 + 10] = 0; }

        let serif_score = best_ncc_score(&page, &serif, 20, 10, 1);
        let sans_score = best_ncc_score(&page, &sans, 20, 10, 1);

        // Serif should score higher than sans
        assert!(serif_score > sans_score,
            "serif ({}) should beat sans ({})", serif_score, sans_score);
    }
}
