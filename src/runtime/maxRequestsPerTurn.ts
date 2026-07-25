export class TurnRequestTracker {
  private gateCount = 0;
  private totalCount = 0;
  private maxRequests: number;

  constructor(maxRequests: number = 50) {
    this.maxRequests = maxRequests;
  }

  /**
   * Records a model request.
   */
  recordRequest(): void {
    this.gateCount++;
    this.totalCount++;
  }

  /**
   * Returns true if the request limit has been reached and explicitly needs continuation.
   */
  needsContinue(): boolean {
    return this.gateCount >= this.maxRequests;
  }

  /**
   * Clears the current limit gate, allowing more requests this turn.
   */
  continueTurn(): void {
    this.gateCount = 0;
  }

  /**
   * Resets the entire turn tracking, including the total request count.
   * To be called when a new user turn begins.
   */
  resetTurn(): void {
    this.gateCount = 0;
    this.totalCount = 0;
  }

  /**
   * Gets the total number of requests made in the current turn, across all continuations.
   */
  getTotalRequests(): number {
    return this.totalCount;
  }
}
