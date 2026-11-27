// Small dense matrices for the synthesis models (meta-regression, multilevel models, robust
// variance): products, Cholesky, inverses and symmetric square roots by Jacobi rotation.
// Sizes are a few hundred at most (estimates in one analysis), so plain loops are enough.

#[derive(Clone, Debug, PartialEq)]
pub struct Mat {
    pub r: usize,
    pub c: usize,
    pub v: Vec<f64>,
}

impl Mat {
    pub fn zeros(r: usize, c: usize) -> Mat {
        Mat { r, c, v: vec![0.0; r * c] }
    }
    pub fn eye(n: usize) -> Mat {
        let mut m = Mat::zeros(n, n);
        for i in 0..n {
            m[(i, i)] = 1.0;
        }
        m
    }
    pub fn diag(d: &[f64]) -> Mat {
        let mut m = Mat::zeros(d.len(), d.len());
        for (i, x) in d.iter().enumerate() {
            m[(i, i)] = *x;
        }
        m
    }
    pub fn col(v: &[f64]) -> Mat {
        Mat { r: v.len(), c: 1, v: v.to_vec() }
    }
    /// Rows given as slices.
    pub fn from_rows(rows: &[Vec<f64>]) -> Mat {
        let r = rows.len();
        let c = rows.first().map_or(0, |x| x.len());
        Mat { r, c, v: rows.iter().flat_map(|x| x.iter().copied()).collect() }
    }
    pub fn t(&self) -> Mat {
        let mut m = Mat::zeros(self.c, self.r);
        for i in 0..self.r {
            for j in 0..self.c {
                m[(j, i)] = self[(i, j)];
            }
        }
        m
    }
    pub fn mul(&self, o: &Mat) -> Mat {
        assert_eq!(self.c, o.r, "matrix sizes");
        let mut m = Mat::zeros(self.r, o.c);
        for i in 0..self.r {
            for k in 0..self.c {
                let a = self[(i, k)];
                if a == 0.0 {
                    continue;
                }
                for j in 0..o.c {
                    m.v[i * o.c + j] += a * o.v[k * o.c + j];
                }
            }
        }
        m
    }
    pub fn add(&self, o: &Mat) -> Mat {
        Mat { r: self.r, c: self.c, v: self.v.iter().zip(&o.v).map(|(a, b)| a + b).collect() }
    }
    pub fn sub(&self, o: &Mat) -> Mat {
        Mat { r: self.r, c: self.c, v: self.v.iter().zip(&o.v).map(|(a, b)| a - b).collect() }
    }
    pub fn scale(&self, s: f64) -> Mat {
        Mat { r: self.r, c: self.c, v: self.v.iter().map(|a| a * s).collect() }
    }
    pub fn trace(&self) -> f64 {
        (0..self.r.min(self.c)).map(|i| self[(i, i)]).sum()
    }
    /// Rows `rows` and columns `cols`.
    pub fn select(&self, rows: &[usize], cols: &[usize]) -> Mat {
        let mut m = Mat::zeros(rows.len(), cols.len());
        for (a, &i) in rows.iter().enumerate() {
            for (b, &j) in cols.iter().enumerate() {
                m[(a, b)] = self[(i, j)];
            }
        }
        m
    }
    pub fn rows(&self, rows: &[usize]) -> Mat {
        self.select(rows, &(0..self.c).collect::<Vec<_>>())
    }
    /// Lower-triangular L with self = L L', or None when not positive definite.
    pub fn cholesky(&self) -> Option<Mat> {
        let n = self.r;
        let mut l = Mat::zeros(n, n);
        for j in 0..n {
            let mut d = self[(j, j)];
            for k in 0..j {
                d -= l[(j, k)] * l[(j, k)];
            }
            if !(d > 0.0) {
                return None;
            }
            let d = d.sqrt();
            l[(j, j)] = d;
            for i in j + 1..n {
                let mut s = self[(i, j)];
                for k in 0..j {
                    s -= l[(i, k)] * l[(j, k)];
                }
                l[(i, j)] = s / d;
            }
        }
        Some(l)
    }
    /// Inverse of a symmetric positive definite matrix.
    pub fn inv_spd(&self) -> Option<Mat> {
        let l = self.cholesky()?;
        let n = self.r;
        // Invert L, then inv = L^-T L^-1.
        let mut li = Mat::zeros(n, n);
        for i in 0..n {
            li[(i, i)] = 1.0 / l[(i, i)];
            for j in 0..i {
                let mut s = 0.0;
                for k in j..i {
                    s -= l[(i, k)] * li[(k, j)];
                }
                li[(i, j)] = s / l[(i, i)];
            }
        }
        Some(li.t().mul(&li))
    }
    /// Log determinant of a symmetric positive definite matrix.
    pub fn logdet_spd(&self) -> Option<f64> {
        let l = self.cholesky()?;
        Some((0..self.r).map(|i| 2.0 * l[(i, i)].ln()).sum())
    }
    /// Eigenvalues and eigenvectors (columns) of a symmetric matrix, by cyclic Jacobi rotation.
    pub fn eigen_sym(&self) -> (Vec<f64>, Mat) {
        let n = self.r;
        let mut a = self.clone();
        let mut v = Mat::eye(n);
        for _ in 0..100 {
            let off: f64 = (0..n).flat_map(|i| (0..n).filter(move |j| *j != i).map(move |j| (i, j))).map(|(i, j)| a[(i, j)] * a[(i, j)]).sum();
            if off < 1e-30 {
                break;
            }
            for p in 0..n {
                for q in p + 1..n {
                    let apq = a[(p, q)];
                    if apq.abs() < 1e-300 {
                        continue;
                    }
                    let theta = (a[(q, q)] - a[(p, p)]) / (2.0 * apq);
                    let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                    let t = if theta == 0.0 { 1.0 } else { t };
                    let c = 1.0 / (t * t + 1.0).sqrt();
                    let s = t * c;
                    for k in 0..n {
                        let akp = a[(k, p)];
                        let akq = a[(k, q)];
                        a[(k, p)] = c * akp - s * akq;
                        a[(k, q)] = s * akp + c * akq;
                    }
                    for k in 0..n {
                        let apk = a[(p, k)];
                        let aqk = a[(q, k)];
                        a[(p, k)] = c * apk - s * aqk;
                        a[(q, k)] = s * apk + c * aqk;
                    }
                    for k in 0..n {
                        let vkp = v[(k, p)];
                        let vkq = v[(k, q)];
                        v[(k, p)] = c * vkp - s * vkq;
                        v[(k, q)] = s * vkp + c * vkq;
                    }
                }
            }
        }
        ((0..n).map(|i| a[(i, i)]).collect(), v)
    }
    /// The symmetric power S^p (p = -1/2 for the CR2 adjustment); eigenvalues at or below
    /// `tol` are dropped (a Moore–Penrose generalised power).
    pub fn sym_pow(&self, p: f64) -> Mat {
        let (vals, vecs) = self.eigen_sym();
        let n = self.r;
        let tol = 1e-12 * vals.iter().fold(0.0f64, |m, x| m.max(x.abs())).max(1e-300);
        let mut m = Mat::zeros(n, n);
        for (k, l) in vals.iter().enumerate() {
            if *l <= tol {
                continue;
            }
            let f = l.powf(p);
            for i in 0..n {
                for j in 0..n {
                    m[(i, j)] += vecs[(i, k)] * f * vecs[(j, k)];
                }
            }
        }
        m
    }
}

impl std::ops::Index<(usize, usize)> for Mat {
    type Output = f64;
    fn index(&self, (i, j): (usize, usize)) -> &f64 {
        &self.v[i * self.c + j]
    }
}

impl std::ops::IndexMut<(usize, usize)> for Mat {
    fn index_mut(&mut self, (i, j): (usize, usize)) -> &mut f64 {
        &mut self.v[i * self.c + j]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inverse_and_square_root() {
        let a = Mat::from_rows(&[vec![4.0, 1.0, 0.5], vec![1.0, 3.0, 0.2], vec![0.5, 0.2, 2.0]]);
        let i = a.inv_spd().unwrap().mul(&a);
        for r in 0..3 {
            for c in 0..3 {
                assert!((i[(r, c)] - if r == c { 1.0 } else { 0.0 }).abs() < 1e-12);
            }
        }
        let h = a.sym_pow(-0.5);
        let back = h.mul(&a).mul(&h);
        for r in 0..3 {
            for c in 0..3 {
                assert!((back[(r, c)] - if r == c { 1.0 } else { 0.0 }).abs() < 1e-10);
            }
        }
        assert!((a.logdet_spd().unwrap() - (4.0f64 * (3.0 * 2.0 - 0.04) - 1.0 * (2.0 - 0.1) + 0.5 * (0.2 - 1.5)).ln()).abs() < 1e-12);
    }
}
