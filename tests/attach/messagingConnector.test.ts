import { describe, it, expect, beforeEach } from 'vitest';
import {
  enable,
  disable,
  isEnabled,
  getConnector,
  getConfig
} from '../../src/attach/messagingConnector.js';

describe('Messaging Connector Stub', () => {
  beforeEach(() => {
    // Ensure clean state before each test
    disable();
  });

  it('is disabled by default', () => {
    expect(isEnabled()).toBe(false);
    expect(getConnector()).toBeNull();
    expect(getConfig()).toBeNull();
  });

  it('fails to enable without a parityGap ID', () => {
    expect(() => {
      enable({});
    }).toThrowError(/parityGap/);

    expect(() => {
      enable({ parityGap: '' });
    }).toThrowError(/parityGap/);

    expect(isEnabled()).toBe(false);
  });

  it('enables successfully with a valid parityGap ID', () => {
    enable({ parityGap: 'GAP-123' });

    expect(isEnabled()).toBe(true);
    expect(getConfig()?.parityGap).toBe('GAP-123');

    const connector = getConnector();
    expect(connector).not.toBeNull();
  });

  it('send method is a noop and does not throw', async () => {
    enable({ parityGap: 'GAP-456' });
    const connector = getConnector()!;

    // Awaiting no-op promises to ensure they don't reject
    await expect(connector.connect()).resolves.toBeUndefined();
    await expect(connector.send({ text: 'hello' })).resolves.toBeUndefined();
    await expect(connector.disconnect()).resolves.toBeUndefined();
  });
});
