// @drefyn/z never declares @drefyn/x.
import { value } from '@drefyn/x';
import type { Secret } from '@drefyn/x';
export { helper } from '@drefyn/x/testing';
export const lazy = () => import('@drefyn/missing');
export const all = [value] as const;
export type S = Secret;
