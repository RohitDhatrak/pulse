// Small statistics helpers for journal impact (docs/algorithms/journal-impact.md): Student's t distribution, Welch's
// unequal-variance degrees of freedom and the Benjamini–Hochberg false-discovery procedure. Pure and dependency-free.

/** ln Γ(z), Lanczos approximation (g = 7, 9 terms); accurate to ~1e-13 for z > 0. */
export function lnGamma(z: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < c.length; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Continued fraction of the incomplete beta (modified Lentz, as in Numerical Recipes' betacf). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

/** The regularised incomplete beta function I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // The continued fraction converges fast only below (a + 1) / (a + b + 2); use the symmetry above it.
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return (front * betaContinuedFraction(x, a, b)) / a;
}

/** P(|T| ≥ |t|) for Student's t with `df` degrees of freedom (df may be fractional, as Welch's is). */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** The t with P(|T| ≥ t) = `p`, i.e. the two-sided critical value (p = 0.1 → the 95th percentile). */
export function studentTQuantile(p: number, df: number): number {
  let lo = 0;
  let hi = 1;
  while (studentTTwoSidedP(hi, df) > p) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (studentTTwoSidedP(mid, df) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Welch–Satterthwaite degrees of freedom from each group's variance ÷ size (v1 = s1² / n1, v2 = s2² / n2). */
export function welchDf(v1: number, n1: number, v2: number, n2: number): number {
  const den = (v1 * v1) / (n1 - 1) + (v2 * v2) / (n2 - 1);
  return den > 0 ? ((v1 + v2) * (v1 + v2)) / den : n1 + n2 - 2;
}

/**
 * Benjamini–Hochberg at false-discovery rate `q`: which of `ps` are discoveries. The largest k with
 * p(k) ≤ k / m × q, and every p ranked at or below it. Non-finite p-values never are.
 */
export function benjaminiHochberg(ps: number[], q: number): boolean[] {
  const order = ps
    .map((p, i) => ({ p, i }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p || a.i - b.i);
  const m = order.length;
  let k = 0;
  order.forEach((x, r) => {
    if (x.p <= ((r + 1) / m) * q) k = r + 1;
  });
  const out = ps.map(() => false);
  for (let r = 0; r < k; r++) out[order[r].i] = true;
  return out;
}
