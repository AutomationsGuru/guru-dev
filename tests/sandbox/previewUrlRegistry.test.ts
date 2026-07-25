import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  register,
  get,
  release,
  clear,
} from '../../src/sandbox/previewUrlRegistry.js';

describe('previewUrlRegistry', () => {
  beforeEach(() => {
    clear();
  });

  afterEach(() => {
    clear();
  });

  it('registers and retrieves a preview URL', () => {
    register('box-alpha', 8080, 'http://preview.local:8080');
    expect(get('box-alpha', 8080)).toBe('http://preview.local:8080');
  });

  it('detects duplicate port conflict for the same boxId', () => {
    register('box-beta', 9000, 'http://preview.local:9000');
    expect(() =>
      register('box-beta', 9000, 'http://preview.local:9001'),
    ).toThrowError(/conflict.*box-beta.*9000/);
  });

  it('allows the same port on different boxIds (no cross-box conflict)', () => {
    register('box-gamma', 7000, 'http://preview.local:7000');
    register('box-delta', 7000, 'http://preview.local:7000');
    expect(get('box-gamma', 7000)).toBe('http://preview.local:7000');
    expect(get('box-delta', 7000)).toBe('http://preview.local:7000');
  });

  it('release removes the mapping and permits re-registration', () => {
    register('box-epsilon', 6000, 'http://preview.local:6000');
    release('box-epsilon', 6000);
    // re-register same port after release should succeed
    register('box-epsilon', 6000, 'http://preview.local:6000');
    expect(get('box-epsilon', 6000)).toBe('http://preview.local:6000');
  });

  it('get returns undefined for unknown boxId+port', () => {
    expect(get('box-unknown', 1234)).toBeUndefined();
  });
});
