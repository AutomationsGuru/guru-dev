import { describe, it, expect, vi } from 'vitest';
import { ToolResultStream } from '../../src/tools/toolResultStream.js';

describe('ToolResultStream', () => {
    it('buffers chunks in buffered mode', () => {
        const stream = new ToolResultStream({ mode: 'buffered' });
        stream.push('chunk 1');
        stream.push('chunk 2');
        stream.close();
        
        expect(stream.getResult()).toBe('chunk 1chunk 2');
    });

    it('emits chunks immediately in streamed mode', () => {
        const onChunk = vi.fn();
        const stream = new ToolResultStream({ mode: 'streamed', onChunk });
        
        stream.push('chunk 1');
        expect(onChunk).toHaveBeenCalledWith('chunk 1');
        
        stream.push('chunk 2');
        expect(onChunk).toHaveBeenCalledWith('chunk 2');
        
        expect(stream.getResult()).toBe('chunk 1chunk 2');
    });
    
    it('defaults to buffered mode', () => {
        const stream = new ToolResultStream();
        stream.push('test');
        expect(stream.getResult()).toBe('test');
    });
    
    it('throws when pushing to a closed stream', () => {
        const stream = new ToolResultStream();
        stream.close();
        expect(() => stream.push('test')).toThrow('Cannot push to a closed stream');
    });
});
