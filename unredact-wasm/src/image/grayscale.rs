/// Convert RGBA pixel buffer to grayscale using luminance weights.
/// Input: &[u8] of length width*height*4 (RGBA)
/// Output: Vec<u8> of length width*height
pub fn rgba_to_grayscale(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let pixel_count = (width * height) as usize;
    assert_eq!(rgba.len(), pixel_count * 4, "RGBA buffer length must equal width * height * 4");

    let mut gray = Vec::with_capacity(pixel_count);
    for chunk in rgba.chunks_exact(4) {
        let r = chunk[0] as f64;
        let g = chunk[1] as f64;
        let b = chunk[2] as f64;
        gray.push((0.299 * r + 0.587 * g + 0.114 * b) as u8);
    }
    gray
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn red_pixel() {
        // (255, 0, 0, 255) -> 0.299 * 255 = 76.245 -> 76
        let rgba = vec![255, 0, 0, 255];
        let result = rgba_to_grayscale(&rgba, 1, 1);
        assert_eq!(result, vec![76]);
    }

    #[test]
    fn white_pixel() {
        // (255, 255, 255, 255) -> 0.299*255 + 0.587*255 + 0.114*255 = 255
        let rgba = vec![255, 255, 255, 255];
        let result = rgba_to_grayscale(&rgba, 1, 1);
        assert_eq!(result, vec![255]);
    }

    #[test]
    fn black_pixel() {
        // (0, 0, 0, 255) -> 0
        let rgba = vec![0, 0, 0, 255];
        let result = rgba_to_grayscale(&rgba, 1, 1);
        assert_eq!(result, vec![0]);
    }

    #[test]
    fn output_length_is_width_times_height() {
        let width: u32 = 3;
        let height: u32 = 2;
        let pixel_count = (width * height) as usize;
        let rgba: Vec<u8> = vec![128, 128, 128, 255].into_iter().cycle().take(pixel_count * 4).collect();
        let result = rgba_to_grayscale(&rgba, width, height);
        assert_eq!(result.len(), pixel_count);
    }
}
