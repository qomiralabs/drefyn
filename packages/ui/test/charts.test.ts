import { describe, expect, it } from 'vitest';
import { chartMotion, cubicBezier } from '../src/charts.ts';
import { tokens } from '../src/tokens/tokens.ts';

describe('chartMotion', () => {
  it('turns chart animation off under reduced motion', () => {
    expect(chartMotion(true)).toEqual({ animation: false });
  });

  it('animates with the motion tokens otherwise', () => {
    const motion = chartMotion(false);
    expect(motion).toMatchObject({
      animation: true,
      animationDuration: tokens.motion.duration.moveSlow.ms,
      animationDurationUpdate: tokens.motion.duration.base.ms,
    });
    if (!motion.animation) throw new Error('expected animation on');
    // The enter curve eases out: most of the travel happens early.
    expect(motion.animationEasing(0)).toBe(0);
    expect(motion.animationEasing(1)).toBe(1);
    expect(motion.animationEasing(0.5)).toBeGreaterThan(0.8);
  });
});

describe('cubicBezier', () => {
  it('is the identity for the linear curve', () => {
    const linear = cubicBezier([0, 0, 1, 1]);
    for (const x of [0, 0.1, 0.25, 0.5, 0.9, 1]) expect(linear(x)).toBeCloseTo(x, 4);
  });

  it('matches CSS ease at known points', () => {
    // CSS ease is cubic-bezier(0.25, 0.1, 0.25, 1); at x = 0.5 it is about 0.8024.
    expect(cubicBezier([0.25, 0.1, 0.25, 1])(0.5)).toBeCloseTo(0.8024, 3);
  });

  it('never goes backwards on the token curves', () => {
    for (const points of Object.values(tokens.motion.ease)) {
      const ease = cubicBezier(points);
      let last = 0;
      for (let i = 1; i <= 100; i++) {
        const y = ease(i / 100);
        expect(y).toBeGreaterThanOrEqual(last);
        last = y;
      }
    }
  });
});
