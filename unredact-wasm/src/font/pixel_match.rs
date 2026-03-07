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
}
