/**
 * ConversationSwitchStack — a bounded LIFO stack of conversation ids for the
 * session runtime. The harness uses push/pop when agent turns switch
 * conversations mid-flight. Peek returns the current conversation without
 * modifying the stack. Overflow at maxDepth throws before mutation so the
 * harness can route to a BUILD/ATTACH/LEARN resolution.
 *
 * P1 daily-driver: small, owned, zero-dependency data structure.
 */
export class ConversationSwitchStack {
  private readonly _stack: string[] = [];
  readonly maxDepth: number;

  constructor(opts: { maxDepth?: number } = {}) {
    const { maxDepth = 20 } = opts;
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new Error(
        `ConversationSwitchStack maxDepth must be a non-negative integer, got ${maxDepth}`,
      );
    }
    this.maxDepth = maxDepth;
  }

  /** Push a conversation id onto the stack. Throws if the stack is full. */
  push(conversationId: string): void {
    if (this._stack.length >= this.maxDepth) {
      throw new Error(
        `ConversationSwitchStack overflow: cannot push "${conversationId}" — stack at max depth ${this.maxDepth}`,
      );
    }
    this._stack.push(conversationId);
  }

  /** Remove and return the top conversation id. Returns undefined if empty. */
  pop(): string | undefined {
    return this._stack.pop();
  }

  /** Return the top conversation id without removing it. Returns undefined if empty. */
  peek(): string | undefined {
    return this._stack[this._stack.length - 1];
  }

  /** Current number of conversation ids on the stack. */
  get depth(): number {
    return this._stack.length;
  }
}
