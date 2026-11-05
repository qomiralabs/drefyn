import { describe, expect, it } from 'vitest';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  UNLIMITED,
  checkLimit,
  featureInfo,
  graceAllowance,
  hasFeature,
  limitFor,
  limitInfo,
} from '../src/index.ts';
import * as pricing from './fixtures/pricing.ts';

describe('self_hosted', () => {
  it('is unlimited for every limit in the table', () => {
    expect(LIMIT_KEYS.length).toBeGreaterThan(0);
    for (const key of LIMIT_KEYS) {
      expect(limitFor('self_hosted', key), key).toBe(UNLIMITED);
    }
  });

  it('allows the largest safe usage on every max limit', () => {
    for (const key of LIMIT_KEYS) {
      if (limitInfo(key).direction !== 'max') continue;
      expect(checkLimit('self_hosted', key, Number.MAX_SAFE_INTEGER).status, key).toBe('allowed');
    }
  });

  it('has no floor on the check interval', () => {
    expect(checkLimit('self_hosted', 'status.check_interval_seconds', 1).status).toBe('allowed');
  });

  it('sends without a cap on its own email, SMS and voice providers', () => {
    for (const key of pricing.SEND_KEYS) {
      expect(checkLimit('self_hosted', key, Number.MAX_SAFE_INTEGER).status, key).toBe('allowed');
      expect(graceAllowance('self_hosted', key)).toBe(UNLIMITED);
    }
  });

  it('has every open core feature', () => {
    const openCore = FEATURE_KEYS.filter((feature) => featureInfo(feature).openCore);
    expect(openCore.length).toBeGreaterThan(0);
    for (const feature of openCore) {
      expect(hasFeature('self_hosted', feature), feature).toBe(true);
    }
  });

  it('counts every feature the pricing gives self host as open core', () => {
    const settled = pricing.FEATURE_KEYS.filter((k) => pricing.FEATURES[k].selfHosted);
    for (const feature of settled) {
      expect(featureInfo(feature).openCore, feature).toBe(true);
    }
  });

  it.each([
    'docs.openapi_reference',
    'docs.mcp',
    'docs.localization',
    'docs.remove_badge',
    'docs.private_password',
    'docs.private_reader_login',
    'docs.reader_feedback',
    'docs.update_drafts',
    'docs.reader_assistant',
    'docs.preview_deployments',
    'docs.instant_rollback',
    'status.remove_badge',
  ] as const)('has %s, which needs no hosted service', (feature) => {
    expect(hasFeature('self_hosted', feature)).toBe(true);
    expect(featureInfo(feature).openCore).toBe(true);
  });

  it.each([
    'docs.mcp_requests_per_month',
    'docs.feedback_items_per_month',
    'docs.assistant_questions_per_month',
  ] as const)('is unlimited on %s while hosted waits for calibration', (key) => {
    expect(limitFor('self_hosted', key)).toBe(UNLIMITED);
    expect(checkLimit('self_hosted', key, Number.MAX_SAFE_INTEGER).status).toBe('allowed');
  });

  it('only lacks features that the hosted service runs', () => {
    for (const feature of FEATURE_KEYS) {
      if (hasFeature('self_hosted', feature)) continue;
      expect(featureInfo(feature).openCore, feature).toBe(false);
    }
  });
});
