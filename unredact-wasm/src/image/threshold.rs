/// Binary inverse threshold: pixels < threshold become 255 (foreground), others become 0.
/// This matches OpenCV's THRESH_BINARY_INV behavior used in the Python code.
pub fn threshold_binary_inv(gray: &[u8], threshold: u8) -> Vec<u8> {
    gray.iter()
        .map(|&pixel| if pixel < threshold { 255 } else { 0 })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_threshold_becomes_255() {
        let gray = vec![10, 20, 30];
        let result = threshold_binary_inv(&gray, 50);
        assert_eq!(result, vec![255, 255, 255]);
    }

    #[test]
    fn at_threshold_becomes_0() {
        let gray = vec![50];
        let result = threshold_binary_inv(&gray, 50);
        assert_eq!(result, vec![0]);
    }

    #[test]
    fn above_threshold_becomes_0() {
        let gray = vec![100, 200, 255];
        let result = threshold_binary_inv(&gray, 50);
        assert_eq!(result, vec![0, 0, 0]);
    }
}
