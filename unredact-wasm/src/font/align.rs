use super::pixel_match;

/// Extract a sub-rectangle from a grayscale image stored in row-major order.
fn extract_window(src: &[u8], src_w: u32, x: u32, y: u32, win_w: u32, win_h: u32) -> Vec<u8> {
    let mut window = Vec::with_capacity((win_w * win_h) as usize);
    for row in y..(y + win_h) {
        let start = (row * src_w + x) as usize;
        window.extend_from_slice(&src[start..start + win_w as usize]);
    }
    window
}

/// Find best pixel offset to align rendered text with a page crop.
///
/// page_gray: grayscale crop from the page (pw x ph)
/// rendered_gray: grayscale canvas with text rendered at center ((pw + 2*search_x) x (ph + 2*search_y))
/// search_x, search_y: half-size of search range in pixels
///
/// Returns (offset_x, offset_y) to apply to the rendering position.
pub fn align_text_to_page(
    page_gray: &[u8],
    pw: u32,
    ph: u32,
    rendered_gray: &[u8],
    rw: u32,
    rh: u32,
    search_x: i32,
    search_y: i32,
) -> (i32, i32) {
    assert_eq!(
        page_gray.len(),
        (pw * ph) as usize,
        "page_gray length must equal pw * ph"
    );
    assert_eq!(
        rendered_gray.len(),
        (rw * rh) as usize,
        "rendered_gray length must equal rw * rh"
    );

    let mut best_score = -1.0_f64;
    let mut best_dx = 0i32;
    let mut best_dy = 0i32;

    for dy in -search_y..=search_y {
        for dx in -search_x..=search_x {
            let wx = (search_x + dx) as u32;
            let wy = (search_y + dy) as u32;
            let window = extract_window(rendered_gray, rw, wx, wy, pw, ph);
            let score = pixel_match::dice_score(page_gray, &window, pw, ph);
            if score > best_score {
                best_score = score;
                best_dx = dx;
                best_dy = dy;
            }
        }
    }

    // If no ink was found in any candidate window, there is no alignment
    // signal — default to zero offset.
    if best_score <= 0.0 {
        return (0, 0);
    }

    (-best_dx, -best_dy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_zero_offset_when_centered() {
        let pw = 10u32;
        let ph = 10u32;
        let sx = 5i32;
        let sy = 5i32;
        let rw = pw + 2 * sx as u32; // 20
        let rh = ph + 2 * sy as u32; // 20

        // Page has ink block at (3,3)-(6,6)
        let mut page = vec![255u8; (pw * ph) as usize];
        for y in 3..6 {
            for x in 3..6 {
                page[(y * pw + x) as usize] = 0;
            }
        }

        // Rendered has same ink block at (3+sx, 3+sy) = (8,8)-(11,11) — perfectly centered
        let mut rendered = vec![255u8; (rw * rh) as usize];
        for y in 8..11 {
            for x in 8..11 {
                rendered[(y * rw + x) as usize] = 0;
            }
        }

        let (dx, dy) = align_text_to_page(&page, pw, ph, &rendered, rw, rh, sx, sy);
        assert_eq!((dx, dy), (0, 0));
    }

    #[test]
    fn finds_nonzero_offset() {
        let pw = 10u32;
        let ph = 10u32;
        let sx = 5i32;
        let sy = 5i32;
        let rw = pw + 2 * sx as u32;
        let rh = ph + 2 * sy as u32;

        // Page has ink at (3,3)-(6,6)
        let mut page = vec![255u8; (pw * ph) as usize];
        for y in 3..6 {
            for x in 3..6 {
                page[(y * pw + x) as usize] = 0;
            }
        }

        // Rendered has ink shifted by (+2, +1) from center: at (10,9)-(13,12)
        let mut rendered = vec![255u8; (rw * rh) as usize];
        for y in 9..12 {
            for x in 10..13 {
                rendered[(y * rw + x) as usize] = 0;
            }
        }

        let (dx, dy) = align_text_to_page(&page, pw, ph, &rendered, rw, rh, sx, sy);
        // Best match at search dx=2, dy=1, so returned offset = (-2, -1)
        assert_eq!((dx, dy), (-2, -1));
    }

    #[test]
    fn no_ink_returns_zero() {
        let pw = 10u32;
        let ph = 10u32;
        let sx = 3i32;
        let sy = 3i32;
        let rw = pw + 2 * sx as u32;
        let rh = ph + 2 * sy as u32;

        let page = vec![255u8; (pw * ph) as usize];
        let rendered = vec![255u8; (rw * rh) as usize];

        let (dx, dy) = align_text_to_page(&page, pw, ph, &rendered, rw, rh, sx, sy);
        assert_eq!((dx, dy), (0, 0));
    }
}
