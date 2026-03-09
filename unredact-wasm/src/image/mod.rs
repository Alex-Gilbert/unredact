pub mod contours;
pub mod flood_fill;
pub mod grayscale;
pub mod morphology;
pub mod threshold;

use crate::types::Rect;

/// Full page redaction detection pipeline:
/// RGBA → grayscale → threshold(40) → close(15,3) → find_bounding_rects
pub fn detect_redactions_pipeline(rgba: &[u8], w: u32, h: u32) -> Vec<Rect> {
    let gray = grayscale::rgba_to_grayscale(rgba, w, h);
    let binary = threshold::threshold_binary_inv(&gray, 40);
    let closed = morphology::close(&binary, w, h, 15, 3);
    contours::find_bounding_rects(&closed, w, h)
}

/// Click-to-select redaction:
/// RGBA → grayscale → threshold(40) → flood_fill_rect
pub fn spot_redaction_pipeline(rgba: &[u8], w: u32, h: u32, x: u32, y: u32) -> Option<Rect> {
    let gray = grayscale::rgba_to_grayscale(rgba, w, h);
    let binary = threshold::threshold_binary_inv(&gray, 40);
    flood_fill::flood_fill_rect(&binary, w, h, x, y)
}

/// Guided redaction search within a region:
/// Crop to [x1-pad, y1-pad, x2+pad, y2+pad], then detect with lower MIN_AREA(100).
/// Returns the largest rect found (by area), with coordinates mapped back to full image.
pub fn find_redaction_in_region(
    rgba: &[u8],
    w: u32,
    h: u32,
    search_x1: u32,
    search_y1: u32,
    search_x2: u32,
    search_y2: u32,
    padding: u32,
) -> Option<Rect> {
    let pad = padding;
    let crop_x1 = search_x1.saturating_sub(pad);
    let crop_y1 = search_y1.saturating_sub(pad);
    let crop_x2 = (search_x2 + pad).min(w);
    let crop_y2 = (search_y2 + pad).min(h);
    let crop_w = crop_x2 - crop_x1;
    let crop_h = crop_y2 - crop_y1;

    // Extract cropped RGBA region
    let mut cropped = Vec::with_capacity((crop_w * crop_h * 4) as usize);
    for y in crop_y1..crop_y2 {
        let row_start = ((y * w + crop_x1) * 4) as usize;
        let row_end = ((y * w + crop_x2) * 4) as usize;
        cropped.extend_from_slice(&rgba[row_start..row_end]);
    }

    let gray = grayscale::rgba_to_grayscale(&cropped, crop_w, crop_h);
    let binary = threshold::threshold_binary_inv(&gray, 40);
    let closed = morphology::close(&binary, crop_w, crop_h, 15, 3);
    let mut rects = contours::find_bounding_rects_with_min_area(&closed, crop_w, crop_h, 100);

    // Find largest by area, map coordinates back to full image
    rects.sort_by(|a, b| (b.w * b.h).cmp(&(a.w * a.h)));
    rects.into_iter().next().map(|r| Rect {
        x: r.x + crop_x1,
        y: r.y + crop_y1,
        w: r.w,
        h: r.h,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rgba_rect(img_w: u32, img_h: u32, rx: u32, ry: u32, rw: u32, rh: u32) -> Vec<u8> {
        let mut rgba = vec![255u8; (img_w * img_h * 4) as usize]; // white background
        for y in ry..(ry + rh) {
            for x in rx..(rx + rw) {
                let i = ((y * img_w + x) * 4) as usize;
                rgba[i] = 0; // R
                rgba[i + 1] = 0; // G
                rgba[i + 2] = 0; // B
                rgba[i + 3] = 255; // A
            }
        }
        rgba
    }

    #[test]
    fn detect_pipeline_finds_black_rect() {
        // 200x100 image with a 60x15 black rectangle
        let rgba = make_rgba_rect(200, 100, 20, 40, 60, 15);
        let rects = detect_redactions_pipeline(&rgba, 200, 100);
        assert_eq!(rects.len(), 1);
        let r = &rects[0];
        // Due to morphological close, exact bounds may differ slightly
        // Check the rect approximately contains our drawn rect
        assert!(r.x <= 20 && r.y <= 40);
        assert!(r.x + r.w >= 80 && r.y + r.h >= 55);
    }

    #[test]
    fn spot_pipeline_finds_clicked_rect() {
        let rgba = make_rgba_rect(200, 100, 20, 40, 60, 15);
        let result = spot_redaction_pipeline(&rgba, 200, 100, 50, 47); // click inside
        assert!(result.is_some());
    }

    #[test]
    fn spot_pipeline_background_click() {
        let rgba = make_rgba_rect(200, 100, 20, 40, 60, 15);
        let result = spot_redaction_pipeline(&rgba, 200, 100, 5, 5); // click on white
        assert!(result.is_none());
    }

    #[test]
    fn find_in_region_finds_rect() {
        let rgba = make_rgba_rect(200, 100, 20, 40, 60, 15);
        let result = find_redaction_in_region(&rgba, 200, 100, 15, 35, 85, 60, 10);
        assert!(result.is_some());
        let r = result.unwrap();
        // Coordinates should be in full-image space
        assert!(r.x >= 15 && r.x <= 25);
        assert!(r.y >= 35 && r.y <= 45);
    }
}
