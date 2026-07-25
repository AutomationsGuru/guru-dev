import { describe, it, expect } from 'vitest';
import { buildDryRunReport } from '../../src/session/dryRunReadiness.js';

describe('buildDryRunReport', () => {
  it('returns blocked if auth providers are missing', () => {
    const report = buildDryRunReport({});
    expect(report.verdict).toBe('blocked');
    expect(report.sections.auth.verdict).toBe('blocked');
    expect(report.nextActions).toContain('Configure at least one API provider (e.g., Anthropic, OpenAI).');
  });

  it('returns blocked if auth providers are configured but all false', () => {
    const report = buildDryRunReport({
      auth: { providers: { anthropic: false, openai: false } },
    });
    expect(report.verdict).toBe('blocked');
    expect(report.sections.auth.verdict).toBe('blocked');
    expect(report.nextActions).toContain('Activate at least one API provider.');
  });

  it('returns ready if auth is satisfied', () => {
    const report = buildDryRunReport({
      auth: { providers: { anthropic: true } },
    });
    expect(report.verdict).toBe('ready');
    expect(report.sections.auth.verdict).toBe('ready');
    expect(report.nextActions).toEqual([]);
  });

  it('returns warning if mcp config is present but empty', () => {
    const report = buildDryRunReport({
      auth: { providers: { anthropic: true } },
      mcp: { servers: {} },
    });
    expect(report.verdict).toBe('warning');
    expect(report.sections.mcp.verdict).toBe('warning');
  });

  it('returns ready for healthy fixture', () => {
    const report = buildDryRunReport({
      auth: { providers: { anthropic: true, openai: false }, defaultProvider: 'anthropic' },
      mcp: { servers: { "my-server": { command: "node" } } },
      settings: { memoryPath: '/tmp/mem' }
    });
    expect(report.verdict).toBe('ready');
    expect(report.sections.mcp.verdict).toBe('ready');
    expect(report.sections.auth.verdict).toBe('ready');
    expect(report.sections.settings.verdict).toBe('ready');
  });
});
