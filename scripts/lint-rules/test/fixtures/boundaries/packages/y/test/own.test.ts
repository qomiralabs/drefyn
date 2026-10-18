import { local } from '../src/index.ts';
import type { Secret } from '../src/bad.ts';
export const fromTest = [local] as const;
export type FromTest = Secret;
