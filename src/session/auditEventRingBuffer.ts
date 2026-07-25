export class AuditEventRingBuffer<T> {
    private buffer: T[];
    private _capacity: number;

    constructor(capacity: number) {
        if (capacity <= 0) {
            throw new Error('Capacity must be greater than 0');
        }
        this._capacity = capacity;
        this.buffer = [];
    }

    public get capacity(): number {
        return this._capacity;
    }

    public get size(): number {
        return this.buffer.length;
    }

    public append(event: T): void {
        this.buffer.push(event);
        if (this.buffer.length > this._capacity) {
            this.buffer.shift();
        }
    }

    public toArray(): T[] {
        return [...this.buffer];
    }

    public clear(): void {
        this.buffer = [];
    }
}
