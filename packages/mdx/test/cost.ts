// How a call's cost grows with its input. A clock reads whatever else the machine is doing, and
// a limit wide enough to survive that lets a quadratic through. This thread's CPU time, compared
// between two sizes, does not depend on either: linear gives the size ratio and quadratic its
// square, on a fast machine or a busy one.
export const SIZE_RATIO = 4;
// Halfway, on a log scale, between linear at 4 and quadratic at 16.
export const MAX_GROWTH = 8;

const SAMPLES = 3;
const ATTEMPTS = 4;
// Below this a reading is timer ticks. A call this cheap is no concern at any growth.
const FLOOR_MS = 5;

function cpuMs(run: () => void): number {
  const before = process.threadCpuUsage();
  run();
  const { user, system } = process.threadCpuUsage(before);
  return (user + system) / 1_000;
}

export function cheapestCpuMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < SAMPLES; sample += 1) best = Math.min(best, cpuMs(run));
  return best;
}

// The best of a few attempts: noise can only make one attempt look worse, and a real quadratic
// looks bad on all of them. Each attempt stops at the first good answer.
export function growthOf(small: () => void, large: () => void): number {
  // Warm, or the small size pays for the JIT and hides growth.
  small();
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < ATTEMPTS && best >= MAX_GROWTH; attempt += 1) {
    best = Math.min(best, cheapestCpuMs(large) / Math.max(cheapestCpuMs(small), FLOOR_MS));
  }
  return best;
}
