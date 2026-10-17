// Imports the rule must leave alone.
import { value } from '@drefyn/x';
import { helper } from '@drefyn/x/testing';
import manifest from '@drefyn/x/package.json' with { type: 'json' };
import { local } from './index.ts';
import self from '@drefyn/y';
import { shared } from '../../../shared.ts';
import { readFile } from 'node:fs/promises';
import path from 'path';
import remote from 'https://example.com/mod.js';
import data from 'data:text/javascript,export default 1';
import hash from '#internal';
import absolute from '/opt/drefyn/mod.ts';
import { describe } from 'vitest';
export const lazyBuiltin = () => import('node:path');
export const computed = (spec: string) => import(spec);
export type Builtin = import('node:fs').Stats;
export const all = [value, helper, manifest, local, self, shared, readFile, path] as const;
export const more = [remote, data, hash, absolute, describe] as const;
