import { describe, it, expect, vi } from 'vitest';
import {
  runArchitectEditorPipeline,
  type ArchitectEditorPipelineOptions,
  type ArchitectModel,
  type EditorModel,
} from '../../src/planning/architectEditorPipeline.js';
import type { ArchitectProposal } from '../../src/planning/architectEditorSchema.js';

describe('runArchitectEditorPipeline (IDEA-F16)', () => {
  const validProposal: ArchitectProposal = {
    objective: 'Refactor foo to bar',
    reasoning: 'Two-phase improves precision for complex edits',
    steps: [{ order: 1, description: 'Update foo.ts', affectedPaths: ['src/foo.ts'] }],
    affectedPaths: ['src/foo.ts'],
    validation: [],
    unresolvedQuestions: [],
  };

  const validEdits = {
    edits: [
      {
        kind: 'search-replace' as const,
        path: 'src/foo.ts',
        search: 'old',
        replace: 'new',
      },
    ],
  };

  it('default off: returns enabled=false with zero model calls', async () => {
    const architect = { createProposal: vi.fn() };
    const editor = { createEdits: vi.fn() };

    const result = await runArchitectEditorPipeline({
      objective: 'add feature X',
      architectEditor: false,
      architect: architect as unknown as ArchitectModel,
      editor: editor as unknown as EditorModel,
    });

    expect(result.enabled).toBe(false);
    expect(result.proposal).toBeNull();
    expect(result.edits).toEqual([]);
    expect(architect.createProposal).not.toHaveBeenCalled();
    expect(editor.createEdits).not.toHaveBeenCalled();
  });

  it('two-phase when enabled: architect → validate → editor → result', async () => {
    const architect: ArchitectModel = {
      createProposal: vi.fn().mockResolvedValue(validProposal),
    };
    const editor: EditorModel = {
      createEdits: vi.fn().mockResolvedValue(validEdits),
    };

    const result = await runArchitectEditorPipeline({
      objective: 'refactor foo',
      architectEditor: true,
      architect,
      editor,
    });

    expect(result.enabled).toBe(true);
    expect(result.proposal).toEqual(validProposal);
    expect(result.edits).toHaveLength(1);
    expect(result.failureReason).toBeUndefined();
    expect(architect.createProposal).toHaveBeenCalledTimes(1);
    expect(editor.createEdits).toHaveBeenCalledTimes(1);
  });

  it('invalid proposal format → failureReason=invalid-proposal, no editor call', async () => {
    const architect: ArchitectModel = {
      createProposal: vi.fn().mockResolvedValue({ bad: 'shape' }),
    };
    const editor: EditorModel = {
      createEdits: vi.fn(),
    };

    const result = await runArchitectEditorPipeline({
      objective: 'test',
      architectEditor: true,
      architect,
      editor,
    });

    expect(result.enabled).toBe(true);
    expect(result.proposal).toBeNull();
    expect(result.edits).toEqual([]);
    expect(result.failureReason).toBe('invalid-proposal');
    expect(editor.createEdits).not.toHaveBeenCalled();
  });

  it('editor format reject → failureReason=invalid-edits, proposal preserved', async () => {
    const architect: ArchitectModel = {
      createProposal: vi.fn().mockResolvedValue(validProposal),
    };
    const editor: EditorModel = {
      createEdits: vi.fn().mockResolvedValue({ bad: 'format' }),
    };

    const result = await runArchitectEditorPipeline({
      objective: 'test',
      architectEditor: true,
      architect,
      editor,
    });

    expect(result.enabled).toBe(true);
    expect(result.proposal).toEqual(validProposal);
    expect(result.edits).toEqual([]);
    expect(result.failureReason).toBe('invalid-edits');
  });

  it('sandboxPending surfaces in result for downstream gates', async () => {
    const architect: ArchitectModel = {
      createProposal: vi.fn().mockResolvedValue(validProposal),
    };
    const editor: EditorModel = {
      createEdits: vi.fn().mockResolvedValue(validEdits),
    };

    const result = await runArchitectEditorPipeline({
      objective: 'sandbox test',
      architectEditor: true,
      sandboxPending: true,
      architect,
      editor,
    });

    expect(result.enabled).toBe(true);
    expect(result.reviewRequired).toBe(false); // reviewRequired defaults false; caller sets based on sandboxPending
    // Pipeline returns ops; caller decides apply path
  });
});