import { describe, it, expect } from 'vitest';
import { buildPlan } from '../../src/attach/cloudDeployAttachPlan.js';

describe('cloudDeployAttachPlan', () => {
  it('builds a valid plan when provider is present', () => {
    const opts = {
      provider: 'aws',
      region: 'us-east-1',
      secretsRef: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    };

    const plan = buildPlan(opts);

    expect(plan).toEqual({
      provider: 'aws',
      region: 'us-east-1',
      secretsRef: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    });
  });

  it('builds a valid plan with defaults for missing optional fields', () => {
    const opts = {
      provider: 'gcp',
    };

    const plan = buildPlan(opts);

    expect(plan).toEqual({
      provider: 'gcp',
      secretsRef: [],
    });
  });

  it('fails when provider is missing', () => {
    const opts = {
      region: 'us-east-1',
    };

    expect(() => buildPlan(opts)).toThrowError('Missing required field: provider');
  });

  it('fails when provider is empty string', () => {
    const opts = {
      provider: '',
    };

    expect(() => buildPlan(opts)).toThrowError('Missing required field: provider');
  });
});
