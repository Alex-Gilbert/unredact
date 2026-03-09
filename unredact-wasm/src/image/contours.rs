use crate::types::Rect;

const MIN_ASPECT: f64 = 1.5;
const FILL_RATIO: f64 = 0.7;

/// Union-Find (Disjoint Set) data structure for connected component labeling.
struct UnionFind {
    parent: Vec<u32>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        let parent = (0..n as u32).collect();
        Self { parent }
    }

    fn find(&mut self, x: u32) -> u32 {
        let mut root = x;
        while self.parent[root as usize] != root {
            root = self.parent[root as usize];
        }
        // Path compression
        let mut curr = x;
        while curr != root {
            let next = self.parent[curr as usize];
            self.parent[curr as usize] = root;
            curr = next;
        }
        root
    }

    fn union(&mut self, a: u32, b: u32) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            // Always make the smaller label the root for determinism
            if ra < rb {
                self.parent[rb as usize] = ra;
            } else {
                self.parent[ra as usize] = rb;
            }
        }
    }
}

/// Tracking data for a connected component while scanning the image.
struct ComponentStats {
    min_x: u32,
    min_y: u32,
    max_x: u32,
    max_y: u32,
    pixel_count: u32,
}

impl ComponentStats {
    fn new(x: u32, y: u32) -> Self {
        Self {
            min_x: x,
            min_y: y,
            max_x: x,
            max_y: y,
            pixel_count: 1,
        }
    }

    fn add(&mut self, x: u32, y: u32) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
        self.pixel_count += 1;
    }

    fn bounding_rect(&self) -> Rect {
        Rect {
            x: self.min_x,
            y: self.min_y,
            w: self.max_x - self.min_x + 1,
            h: self.max_y - self.min_y + 1,
        }
    }

    fn bounding_area(&self) -> u32 {
        (self.max_x - self.min_x + 1) * (self.max_y - self.min_y + 1)
    }
}

/// Find bounding rectangles of connected foreground components in a binary image.
/// Applies default filters (MIN_AREA=500, MIN_ASPECT=1.5, FILL_RATIO=0.7).
/// Results sorted by (y, x).
pub fn find_bounding_rects(binary: &[u8], w: u32, h: u32) -> Vec<Rect> {
    find_bounding_rects_with_min_area(binary, w, h, 500)
}

/// Same as above but with configurable minimum area (for guided detection mode).
pub fn find_bounding_rects_with_min_area(
    binary: &[u8],
    w: u32,
    h: u32,
    min_area: u32,
) -> Vec<Rect> {
    assert_eq!(
        binary.len(),
        (w * h) as usize,
        "binary buffer length must equal w * h"
    );

    if w == 0 || h == 0 {
        return Vec::new();
    }

    let total = (w * h) as usize;

    // Label buffer: 0 means background (unlabeled)
    let mut labels = vec![0u32; total];
    let mut uf = UnionFind::new(total + 1); // labels start at 1
    let mut next_label: u32 = 1;

    // First pass: assign provisional labels, record unions
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            if binary[idx] == 0 {
                continue;
            }

            let left_label = if x > 0 { labels[idx - 1] } else { 0 };
            let above_label = if y > 0 {
                labels[(idx as u32 - w) as usize]
            } else {
                0
            };

            match (left_label > 0, above_label > 0) {
                (false, false) => {
                    // New component
                    labels[idx] = next_label;
                    next_label += 1;
                }
                (true, false) => {
                    labels[idx] = left_label;
                }
                (false, true) => {
                    labels[idx] = above_label;
                }
                (true, true) => {
                    // Both neighbors labeled; use the smaller and union them
                    let min_label = left_label.min(above_label);
                    labels[idx] = min_label;
                    uf.union(left_label, above_label);
                }
            }
        }
    }

    // Second pass: resolve all labels to their root and collect stats
    let mut stats: std::collections::HashMap<u32, ComponentStats> =
        std::collections::HashMap::new();

    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let label = labels[idx];
            if label == 0 {
                continue;
            }
            let root = uf.find(label);
            labels[idx] = root;

            stats
                .entry(root)
                .and_modify(|s| s.add(x, y))
                .or_insert_with(|| ComponentStats::new(x, y));
        }
    }

    // Filter and collect results
    let mut rects: Vec<Rect> = stats
        .values()
        .filter_map(|s| {
            let rect = s.bounding_rect();
            let bbox_area = s.bounding_area();

            // Area filter
            if bbox_area < min_area {
                return None;
            }

            // Aspect ratio filter (redaction boxes are wider than tall)
            let aspect = rect.w as f64 / rect.h as f64;
            if aspect < MIN_ASPECT {
                return None;
            }

            // Fill ratio filter
            let fill = s.pixel_count as f64 / bbox_area as f64;
            if fill < FILL_RATIO {
                return None;
            }

            Some(rect)
        })
        .collect();

    // Sort by (y, x) for deterministic output
    rects.sort_by(|a, b| a.y.cmp(&b.y).then(a.x.cmp(&b.x)));
    rects
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Rect;

    fn make_rect_image(img_w: u32, img_h: u32, rects: &[(u32, u32, u32, u32)]) -> Vec<u8> {
        let mut img = vec![0u8; (img_w * img_h) as usize];
        for &(rx, ry, rw, rh) in rects {
            for y in ry..(ry + rh) {
                for x in rx..(rx + rw) {
                    img[(y * img_w + x) as usize] = 255;
                }
            }
        }
        img
    }

    #[test]
    fn single_rectangle() {
        // 100x100 image with a 40x10 rect at (10,20) — area=400 < 500 default, use custom min_area
        let img = make_rect_image(100, 100, &[(10, 20, 40, 10)]);
        let rects = find_bounding_rects_with_min_area(&img, 100, 100, 100);
        assert_eq!(rects.len(), 1);
        assert_eq!(rects[0], Rect { x: 10, y: 20, w: 40, h: 10 });
    }

    #[test]
    fn filters_small_area() {
        // 100x100 image with tiny 3x3 rect — area=9, below any reasonable min
        let img = make_rect_image(100, 100, &[(50, 50, 3, 3)]);
        let rects = find_bounding_rects_with_min_area(&img, 100, 100, 100);
        assert_eq!(rects.len(), 0);
    }

    #[test]
    fn filters_bad_aspect_ratio() {
        // 100x100 image with a 10x40 rect (tall, not wide) — aspect=0.25 < 1.5
        let img = make_rect_image(100, 100, &[(10, 10, 10, 40)]);
        let rects = find_bounding_rects_with_min_area(&img, 100, 100, 100);
        assert_eq!(rects.len(), 0);
    }

    #[test]
    fn two_separate_rects() {
        // Two wide rectangles separated by space
        let img = make_rect_image(200, 100, &[(10, 10, 60, 10), (100, 50, 80, 10)]);
        let rects = find_bounding_rects_with_min_area(&img, 200, 100, 100);
        assert_eq!(rects.len(), 2);
        // Should be sorted by (y, x)
        assert_eq!(rects[0], Rect { x: 10, y: 10, w: 60, h: 10 });
        assert_eq!(rects[1], Rect { x: 100, y: 50, w: 80, h: 10 });
    }

    #[test]
    fn empty_image_returns_nothing() {
        let img = vec![0u8; 10000];
        let rects = find_bounding_rects(&img, 100, 100);
        assert_eq!(rects.len(), 0);
    }
}
