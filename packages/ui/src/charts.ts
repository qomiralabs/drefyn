// Chart motion from the tokens. ECharts themes are plain data, so the exact easing curve and
// the reduced motion switch live here, applied with chart.setOption(chartMotion(reduced)).

import { tokens } from './tokens/tokens.ts';

export type Easing = (progress: number) => number;

// A CSS cubic-bezier as a function of progress, solved for x with Newton steps and a
// bisection fallback, the way browsers do.
export function cubicBezier(points: readonly [number, number, number, number]): Easing {
  const [x1, y1, x2, y2] = points;
  const at = (a: number, b: number, t: number) =>
    3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  const slope = (a: number, b: number, t: number) =>
    3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t ** 2;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = at(x1, x2, t) - x;
      if (Math.abs(error) < 1e-7) return at(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= error / d;
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const value = at(x1, x2, t);
      if (Math.abs(value - x) < 1e-7) break;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return at(y1, y2, t);
  };
}

export type ChartMotion =
  | { animation: false }
  | {
      animation: true;
      animationDuration: number;
      animationDurationUpdate: number;
      animationEasing: Easing;
      animationEasingUpdate: Easing;
    };

// Pass the reader's reduced motion preference, for example
// matchMedia('(prefers-reduced-motion: reduce)').matches.
export function chartMotion(reducedMotion: boolean): ChartMotion {
  if (reducedMotion) return { animation: false };
  const ease = cubicBezier(tokens.motion.ease.enter);
  return {
    animation: true,
    animationDuration: tokens.motion.duration.moveSlow.ms,
    animationDurationUpdate: tokens.motion.duration.base.ms,
    animationEasing: ease,
    animationEasingUpdate: ease,
  };
}
