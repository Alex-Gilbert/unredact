// @ts-check
/**
 * Golden-section search for unimodal function maximum.
 * @param {(x: number) => number} fn - function to maximize
 * @param {number} lo - lower bound
 * @param {number} hi - upper bound
 * @param {number} tol - convergence tolerance (stop when hi - lo < tol)
 * @returns {{ x: number, score: number }}
 */
export function goldenSection(fn, lo, hi, tol) {
    const phi = (1 + Math.sqrt(5)) / 2;
    const resphi = 2 - phi;

    let a = lo, b = hi;
    let x1 = a + resphi * (b - a);
    let x2 = b - resphi * (b - a);
    let f1 = fn(x1);
    let f2 = fn(x2);

    while (b - a > tol) {
        if (f1 < f2) {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = b - resphi * (b - a);
            f2 = fn(x2);
        } else {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = a + resphi * (b - a);
            f1 = fn(x1);
        }
    }

    if (f1 > f2) return { x: x1, score: f1 };
    return { x: x2, score: f2 };
}
