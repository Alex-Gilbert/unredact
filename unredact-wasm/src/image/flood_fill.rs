use std::collections::VecDeque;

use crate::types::Rect;

const SPOT_MIN_AREA: u32 = 100;

/// Flood fill from (click_x, click_y) on a binary image.
/// Returns bounding rect of the connected component, or None if:
/// - Click point is on background (pixel value 0)
/// - Connected component area < SPOT_MIN_AREA
pub fn flood_fill_rect(binary: &[u8], w: u32, h: u32, click_x: u32, click_y: u32) -> Option<Rect> {
    let total = (w * h) as usize;
    assert_eq!(
        binary.len(),
        total,
        "binary buffer length must equal w * h"
    );

    // Check if click point is within bounds and on foreground
    let start_idx = (click_y * w + click_x) as usize;
    if binary[start_idx] == 0 {
        return None;
    }

    // BFS
    let mut visited = vec![false; total];
    let mut queue = VecDeque::new();

    visited[start_idx] = true;
    queue.push_back((click_x, click_y));

    let mut min_x = click_x;
    let mut min_y = click_y;
    let mut max_x = click_x;
    let mut max_y = click_y;
    let mut pixel_count: u32 = 0;

    while let Some((cx, cy)) = queue.pop_front() {
        pixel_count += 1;
        min_x = min_x.min(cx);
        min_y = min_y.min(cy);
        max_x = max_x.max(cx);
        max_y = max_y.max(cy);

        // 4-connectivity neighbors: up, down, left, right
        let neighbors: [(i64, i64); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];
        for (dx, dy) in neighbors {
            let nx = cx as i64 + dx;
            let ny = cy as i64 + dy;

            if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                continue;
            }

            let nx = nx as u32;
            let ny = ny as u32;
            let nidx = (ny * w + nx) as usize;

            if !visited[nidx] && binary[nidx] != 0 {
                visited[nidx] = true;
                queue.push_back((nx, ny));
            }
        }
    }

    if pixel_count < SPOT_MIN_AREA {
        return None;
    }

    Some(Rect {
        x: min_x,
        y: min_y,
        w: max_x - min_x + 1,
        h: max_y - min_y + 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Rect;

    #[test]
    fn finds_connected_component() {
        // 50x50 image with 15x10 solid rectangle at (5,5)
        let mut img = vec![0u8; 2500];
        for y in 5..15 {
            for x in 5..20 {
                img[y * 50 + x] = 255;
            }
        }
        let result = flood_fill_rect(&img, 50, 50, 10, 10); // click inside
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r, Rect { x: 5, y: 5, w: 15, h: 10 });
    }

    #[test]
    fn background_click_returns_none() {
        let img = vec![0u8; 2500]; // all black (background)
        let result = flood_fill_rect(&img, 50, 50, 25, 25);
        assert!(result.is_none());
    }

    #[test]
    fn too_small_returns_none() {
        // 50x50 image with 5x5 rect = 25 pixels < SPOT_MIN_AREA(100)
        let mut img = vec![0u8; 2500];
        for y in 10..15 {
            for x in 10..15 {
                img[y * 50 + x] = 255;
            }
        }
        let result = flood_fill_rect(&img, 50, 50, 12, 12);
        assert!(result.is_none());
    }

    #[test]
    fn l_shaped_component() {
        // L-shape: horizontal bar + vertical bar
        let mut img = vec![0u8; 2500];
        // horizontal: x=5..25, y=10..15 (20*5=100)
        for y in 10..15 {
            for x in 5..25 {
                img[y * 50 + x] = 255;
            }
        }
        // vertical: x=5..10, y=15..25 (5*10=50)
        for y in 15..25 {
            for x in 5..10 {
                img[y * 50 + x] = 255;
            }
        }
        let result = flood_fill_rect(&img, 50, 50, 15, 12); // click in horizontal part
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r, Rect { x: 5, y: 10, w: 20, h: 15 });
    }

    #[test]
    fn two_separate_components_only_finds_clicked() {
        let mut img = vec![0u8; 2500];
        // Component A: x=5..25, y=5..15 (200 pixels)
        for y in 5..15 {
            for x in 5..25 {
                img[y * 50 + x] = 255;
            }
        }
        // Component B: x=30..50, y=30..40 (200 pixels)
        for y in 30..40 {
            for x in 30..50 {
                img[y * 50 + x] = 255;
            }
        }
        // Click on component A
        let result = flood_fill_rect(&img, 50, 50, 10, 10);
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r, Rect { x: 5, y: 5, w: 20, h: 10 });
    }
}
