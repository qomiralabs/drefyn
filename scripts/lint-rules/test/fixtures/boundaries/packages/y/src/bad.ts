// Every way one package can reach into another's files. Each line is one report.
import { secret } from '../../x/src/internal.ts';
import type { Secret } from '../../x/src/internal.ts';
export { secret as reexported } from '../../x/src/internal.ts';
export * from '../../x/src/internal.ts';
export const lazy = () => import('../../x/src/internal.ts');
export type Lazy = import('../../x/src/internal.ts').Secret;
export const required = require('../../x/src/internal.ts');
export const templated = () => import(`../../x/src/internal.ts`);
export { value } from '../../x';
import { secret as deep } from '@drefyn/x/src/internal.ts';
export const all = [secret, deep] as const;
export type S = Secret;
import legacy = require('../../x/src/internal.ts');
export type L = typeof legacy;
