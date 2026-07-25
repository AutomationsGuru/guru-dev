import { describe, expect, it } from "vitest";

import { DeferredWorkQueue } from '../../src/session/deferredWorkQueue.js';

describe("DeferredWorkQueue", () => {
  it("enqueues items and dequeues in FIFO order", () => {
    const q = new DeferredWorkQueue<string>();

    q.enqueue("first", "alpha");
    q.enqueue("second", "beta");
    q.enqueue("third", "gamma");

    expect(q.length).toBe(3);

    const a = q.dequeue();
    expect(a).toEqual({ reason: "first", payload: "alpha" });

    const b = q.dequeue();
    expect(b).toEqual({ reason: "second", payload: "beta" });

    const c = q.dequeue();
    expect(c).toEqual({ reason: "third", payload: "gamma" });

    expect(q.length).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  it("peek returns the oldest item without removing it", () => {
    const q = new DeferredWorkQueue<number>();

    q.enqueue("count", 42);
    q.enqueue("count", 99);

    expect(q.length).toBe(2);

    const peeked = q.peek();
    expect(peeked).toEqual({ reason: "count", payload: 42 });

    // Peek is idempotent — same item, no removal.
    expect(q.peek()).toEqual({ reason: "count", payload: 42 });
    expect(q.length).toBe(2);
  });

  it("peek returns undefined when queue is empty", () => {
    const q = new DeferredWorkQueue();
    expect(q.peek()).toBeUndefined();
  });

  it("dequeue returns undefined when queue is empty", () => {
    const q = new DeferredWorkQueue();
    expect(q.dequeue()).toBeUndefined();
  });

  it("length is zero for a new queue", () => {
    const q = new DeferredWorkQueue();
    expect(q.length).toBe(0);
  });

  it("clear removes all items", () => {
    const q = new DeferredWorkQueue<string>();
    q.enqueue("a", "x");
    q.enqueue("b", "y");
    expect(q.length).toBe(2);

    q.clear();
    expect(q.length).toBe(0);
    expect(q.peek()).toBeUndefined();
    expect(q.dequeue()).toBeUndefined();
  });

  it("handles interleaved enqueue and dequeue", () => {
    const q = new DeferredWorkQueue<number>();

    q.enqueue("one", 1);
    q.enqueue("two", 2);
    expect(q.dequeue()).toEqual({ reason: "one", payload: 1 });

    q.enqueue("three", 3);
    expect(q.dequeue()).toEqual({ reason: "two", payload: 2 });
    expect(q.dequeue()).toEqual({ reason: "three", payload: 3 });
    expect(q.dequeue()).toBeUndefined();
  });

  it("works with object payloads", () => {
    const q = new DeferredWorkQueue<{ name: string; value: number }>();

    q.enqueue("obj", { name: "a", value: 1 });

    const item = q.dequeue();
    expect(item?.payload.name).toBe("a");
    expect(item?.payload.value).toBe(1);
  });
});
