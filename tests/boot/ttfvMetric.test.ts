import { describe, it, expect, beforeEach } from 'vitest';
import { TTFVMetric } from '../../src/boot/ttfvMetric.js';

describe('TTFVMetric', () => {
  let metric: TTFVMetric;

  beforeEach(() => {
    metric = new TTFVMetric();
  });

  it('duration is initially null', () => {
    expect(metric.durationMs).toBeNull();
  });

  it('duration is null after only start', () => {
    metric.markBootStart(100);
    expect(metric.durationMs).toBeNull();
  });

  it('duration is calculated correctly', () => {
    metric.markBootStart(100);
    metric.markFirstUseful(150);
    expect(metric.durationMs).toBe(50);
  });

  it('first useful mark is ignored if boot start is missing', () => {
    metric.markFirstUseful(150);
    expect(metric.durationMs).toBeNull();
  });

  it('multiple start marks are ignored', () => {
    metric.markBootStart(100);
    metric.markBootStart(200);
    metric.markFirstUseful(250);
    expect(metric.durationMs).toBe(150); // Calculated from 100, not 200
  });

  it('multiple first useful marks are ignored', () => {
    metric.markBootStart(100);
    metric.markFirstUseful(150);
    metric.markFirstUseful(250);
    expect(metric.durationMs).toBe(50); // Calculated from 150, not 250
  });
});
