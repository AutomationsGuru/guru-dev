import { describe, it, expect, beforeEach } from 'vitest';
import { PromptLibraryRegistry, PromptTemplate } from '../../src/skills/promptLibraryRegistry.js';

describe('PromptLibraryRegistry', () => {
  let registry: PromptLibraryRegistry;

  beforeEach(() => {
    registry = new PromptLibraryRegistry();
  });

  it('adds and retrieves a prompt template', () => {
    const template: PromptTemplate = {
      id: 'greet',
      description: 'A friendly greeting',
      content: 'Hello, {name}!'
    };

    registry.add(template);
    const retrieved = registry.get('greet');

    expect(retrieved).toEqual(template);
  });

  it('lists all added prompt templates', () => {
    const t1: PromptTemplate = { id: 't1', content: 'C1' };
    const t2: PromptTemplate = { id: 't2', content: 'C2' };

    registry.add(t1);
    registry.add(t2);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual(t1);
    expect(list).toContainEqual(t2);
  });

  it('rejects duplicate prompt template IDs', () => {
    const template: PromptTemplate = { id: 'test', content: 'Some content' };
    registry.add(template);

    expect(() => {
      registry.add({ id: 'test', content: 'Different content' });
    }).toThrowError("Prompt template with id 'test' already exists.");
  });

  it('returns undefined for non-existent IDs', () => {
    expect(registry.get('missing')).toBeUndefined();
  });
});
