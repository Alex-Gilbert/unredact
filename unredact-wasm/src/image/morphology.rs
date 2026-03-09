/// Dilate: for each pixel, output = max of all pixels in the rectangular kernel neighborhood.
/// kw and kh are kernel width and height. Kernel is centered on the pixel.
pub fn dilate(img: &[u8], w: u32, h: u32, kw: u32, kh: u32) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    let hkw = (kw / 2) as usize;
    let hkh = (kh / 2) as usize;
    let mut out = vec![0u8; w * h];

    for y in 0..h {
        let y_lo = y.saturating_sub(hkh);
        let y_hi = (y + hkh).min(h - 1);
        for x in 0..w {
            let x_lo = x.saturating_sub(hkw);
            let x_hi = (x + hkw).min(w - 1);
            let mut val = 0u8;
            for ny in y_lo..=y_hi {
                for nx in x_lo..=x_hi {
                    val = val.max(img[ny * w + nx]);
                }
            }
            out[y * w + x] = val;
        }
    }
    out
}

/// Erode: for each pixel, output = min of all pixels in the rectangular kernel neighborhood.
/// Out-of-bounds pixels are treated as 0, so edges get eroded.
pub fn erode(img: &[u8], w: u32, h: u32, kw: u32, kh: u32) -> Vec<u8> {
    let (w, h) = (w as i32, h as i32);
    let hkw = (kw / 2) as i32;
    let hkh = (kh / 2) as i32;
    let wu = w as usize;
    let mut out = vec![0u8; (w * h) as usize];

    for y in 0..h {
        for x in 0..w {
            let mut val = 255u8;
            for dy in -hkh..=hkh {
                let ny = y + dy;
                for dx in -hkw..=hkw {
                    let nx = x + dx;
                    if nx < 0 || nx >= w || ny < 0 || ny >= h {
                        val = 0;
                    } else {
                        val = val.min(img[ny as usize * wu + nx as usize]);
                    }
                }
            }
            out[y as usize * wu + x as usize] = val;
        }
    }
    out
}

/// Morphological close: dilate then erode. Fills small gaps in foreground regions.
pub fn close(img: &[u8], w: u32, h: u32, kw: u32, kh: u32) -> Vec<u8> {
    let dilated = dilate(img, w, h, kw, kh);
    erode(&dilated, w, h, kw, kh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dilate_expands_horizontally() {
        // 5x5 image with single white pixel in center
        let mut img = vec![0u8; 25];
        img[12] = 255; // (2,2)
        let result = dilate(&img, 5, 5, 3, 1);
        assert_eq!(result[11], 255); // (1,2) - expanded left
        assert_eq!(result[12], 255); // (2,2) - original
        assert_eq!(result[13], 255); // (3,2) - expanded right
        assert_eq!(result[7], 0);    // (2,1) - not expanded vertically
    }

    #[test]
    fn erode_shrinks() {
        // 5x5 image, full row of white
        let mut img = vec![0u8; 25];
        for x in 0..5 { img[2 * 5 + x] = 255; }
        let result = erode(&img, 5, 5, 3, 1);
        assert_eq!(result[10], 0);   // (0,2) - edge eroded
        assert_eq!(result[11], 255); // (1,2) - interior kept
        assert_eq!(result[12], 255); // (2,2) - interior kept
        assert_eq!(result[13], 255); // (3,2) - interior kept
        assert_eq!(result[14], 0);   // (4,2) - edge eroded
    }

    #[test]
    fn close_fills_small_gap() {
        // Two white pixels with a 1px gap in between, kernel wider than gap should fill it
        let mut img = vec![0u8; 25];
        img[2 * 5 + 1] = 255;
        img[2 * 5 + 3] = 255;
        let result = close(&img, 5, 5, 3, 1);
        assert_eq!(result[2 * 5 + 2], 255); // gap filled
    }

    #[test]
    fn dilate_with_tall_kernel() {
        // Single white pixel, kernel 1x3 should expand vertically
        let mut img = vec![0u8; 25];
        img[12] = 255; // (2,2)
        let result = dilate(&img, 5, 5, 1, 3);
        assert_eq!(result[7], 255);  // (2,1) - expanded up
        assert_eq!(result[12], 255); // (2,2) - original
        assert_eq!(result[17], 255); // (2,3) - expanded down
        assert_eq!(result[11], 0);   // (1,2) - not expanded horizontally
    }
}
