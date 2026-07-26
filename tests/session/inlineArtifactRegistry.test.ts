import { describe, it, expect } from 'vitest';
import { InlineArtifactRegistry, InlineArtifact } from '../../src/session/inlineArtifactRegistry';

describe('InlineArtifactRegistry', () => {
  it('put and list by step', () => {
    const registry = new InlineArtifactRegistry();
    const art1: InlineArtifact = { id: 'log-1', mime: 'text/plain', path: '/tmp/step1.log' };
    const art2: InlineArtifact = { id: 'img-1', mime: 'image/png', path: '/tmp/step1.png' };

    registry.put('step-alpha', art1);
    registry.put('step-alpha', art2);
    registry.put('step-beta', { id: 'data-1', mime: 'application/json', path: '/tmp/beta.json' });

    const alpha = registry.list('step-alpha');
    expect(alpha).toHaveLength(2);
    expect(alpha[0]).toEqual(art1);
    expect(alpha[1]).toEqual(art2);

    const beta = registry.list('step-beta');
    expect(beta).toHaveLength(1);
    expect(beta[0].mime).toBe('application/json');

    expect(registry.list('nonexistent')).toEqual([]);
  });

  it('duplicate id overwrites previous entry for the same step', () => {
    const registry = new InlineArtifactRegistry();
    registry.put('step-1', { id: 'conflict', mime: 'text/plain', path: '/old/path.txt' });
    registry.put('step-1', { id: 'conflict', mime: 'application/json', path: '/new/path.json' });

    const listed = registry.list('step-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].mime).toBe('application/json');
    expect(listed[0].path).toBe('/new/path.json');
  });

  it('different steps may share artifact id without collision', () => {
    const registry = new InlineArtifactRegistry();
    registry.put('step-a', { id: 'shared', mime: 'text/plain', path: '/a.txt' });
    registry.put('step-b', { id: 'shared', mime: 'text/plain', path: '/b.txt' });

    expect(registry.list('step-a')).toHaveLength(1);
    expect(registry.list('step-b')).toHaveLength(1);
    expect(registry.listSteps()).toContain('step-a');
    expect(registry.listSteps()).toContain('step-b');
  });
});
