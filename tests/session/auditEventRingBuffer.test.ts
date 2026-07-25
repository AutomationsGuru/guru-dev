import { describe, it, expect, beforeEach } from 'vitest';
import { AuditEventRingBuffer } from '../../src/session/auditEventRingBuffer.js';

describe('AuditEventRingBuffer', () => {
    let ringBuffer: AuditEventRingBuffer<string>;

    beforeEach(() => {
        ringBuffer = new AuditEventRingBuffer<string>(3);
    });

    it('should initialize with correct capacity and empty state', () => {
        expect(ringBuffer.capacity).toBe(3);
        expect(ringBuffer.toArray()).toEqual([]);
        expect(ringBuffer.size).toBe(0);
    });

    it('should append events', () => {
        ringBuffer.append('event1');
        expect(ringBuffer.size).toBe(1);
        expect(ringBuffer.toArray()).toEqual(['event1']);

        ringBuffer.append('event2');
        expect(ringBuffer.size).toBe(2);
        expect(ringBuffer.toArray()).toEqual(['event1', 'event2']);

        ringBuffer.append('event3');
        expect(ringBuffer.size).toBe(3);
        expect(ringBuffer.toArray()).toEqual(['event1', 'event2', 'event3']);
    });

    it('should evict oldest events when capacity is exceeded', () => {
        ringBuffer.append('event1');
        ringBuffer.append('event2');
        ringBuffer.append('event3');
        ringBuffer.append('event4');

        expect(ringBuffer.size).toBe(3);
        expect(ringBuffer.toArray()).toEqual(['event2', 'event3', 'event4']);

        ringBuffer.append('event5');
        expect(ringBuffer.size).toBe(3);
        expect(ringBuffer.toArray()).toEqual(['event3', 'event4', 'event5']);
    });

    it('should be able to clear', () => {
        ringBuffer.append('event1');
        ringBuffer.clear();

        expect(ringBuffer.size).toBe(0);
        expect(ringBuffer.toArray()).toEqual([]);
    });
});
