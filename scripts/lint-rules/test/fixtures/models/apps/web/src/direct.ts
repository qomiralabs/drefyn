import Anthropic from '@anthropic-ai/sdk';
import { guardedFetch, policyFor } from '@drefyn/egress';

export const client = new Anthropic();
export const answer = () =>
  guardedFetch('https://api.anthropic.com/v1/messages', { method: 'POST' }, policyFor('import'));
export const headers = { 'anthropic-version': '2023-06-01' };
