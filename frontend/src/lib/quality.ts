// call quality from rtt and loss, a simplified ITU-T G.107 E-model.
// The two coefficients are for illustration (task 17), not from the standard.

/** R: 93.2 is a perfect line, minus delay and loss penalties. d = one-way delay ≈ rtt / 2. */
export function rFactor(rttMs: number, lossPct: number): number {
  return 93.2 - 0.024 * (rttMs / 2) - 2.5 * lossPct;
}

/** R -> MOS, 1 (awful) .. ~4.4 (perfect). */
export function mos(r: number): number {
  if (r <= 0) return 1;
  if (r >= 100) return 4.5;
  return 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r);
}

/** 0..4 signal bars, null while there are no numbers yet. */
export function qualityBars(score: number | null): number | null {
  if (score == null) return null;
  if (score >= 4.0) return 4;
  if (score >= 3.6) return 3;
  if (score >= 3.1) return 2;
  if (score >= 2.58) return 1;
  return 0;
}

export function callQuality(rttMs: number | null, lossPct: number | null) {
  if (rttMs == null) return { r: null, mos: null, bars: null };
  const r = rFactor(rttMs, lossPct ?? 0);
  const score = mos(r);
  return { r, mos: score, bars: qualityBars(score) };
}
