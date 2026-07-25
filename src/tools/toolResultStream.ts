export type ToolResultStreamMode = 'buffered' | 'streamed';

export interface ToolResultStreamOptions {
    mode?: ToolResultStreamMode;
    onChunk?: ((chunk: string) => void) | undefined;
}

export class ToolResultStream {
    private mode: ToolResultStreamMode;
    private onChunk: ((chunk: string) => void) | undefined;
    private buffer: string[] = [];
    private isClosed = false;

    constructor(options: ToolResultStreamOptions = {}) {
        this.mode = options.mode ?? 'buffered';
        this.onChunk = options.onChunk;
    }

    public push(chunk: string): void {
        if (this.isClosed) {
            throw new Error('Cannot push to a closed stream');
        }
        
        if (this.mode === 'streamed') {
            if (this.onChunk) {
                this.onChunk(chunk);
            }
        }
        this.buffer.push(chunk);
    }

    public close(): void {
        this.isClosed = true;
    }

    public getResult(): string {
        return this.buffer.join('');
    }
}
