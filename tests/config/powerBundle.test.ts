import { installBundle } from '../../src/config/powerBundle.js';
import * as path from 'path';

describe('installBundle', () => {
  const fixturesPath = path.join(__dirname, '../fixtures/power-bundle');

  test('should install a valid bundle', async () => {
    const bundlePath = path.join(fixturesPath, 'valid-bundle');
    const result = await installBundle(bundlePath);
    expect(result).toBe(true);
  });

  test('should not install an invalid bundle with a hash mismatch', async () => {
    const bundlePath = path.join(fixturesPath, 'invalid-hash-bundle');
    const result = await installBundle(bundlePath);
    expect(result).toBe(false);
  });

  test('should not install a bundle with a missing file', async () => {
    const bundlePath = path.join(fixturesPath, 'missing-file-bundle');
    const result = await installBundle(bundlePath);
    expect(result).toBe(false);
  });

  test('should not install a bundle with a missing manifest', async () => {
    const bundlePath = path.join(fixturesPath, 'missing-manifest-bundle');
    const result = await installBundle(bundlePath);
    expect(result).toBe(false);
  });
});
