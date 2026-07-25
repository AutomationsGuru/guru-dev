/** A bounded, in-memory record of the most recent completed turns. */
export class TurnReplayBuffer<T> {
  private readonly turns: T[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("TurnReplayBuffer capacity must be a positive safe integer.");
    }
    this.capacity = capacity;
  }

  push(turn: T): void {
    this.turns.push(turn);
    if (this.turns.length > this.capacity) {
      this.turns.splice(0, this.turns.length - this.capacity);
    }
  }

  replay(): T[] {
    return [...this.turns];
  }
}
