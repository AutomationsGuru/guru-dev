export class TTFVMetric {
  private startTime: number | null = null;
  private firstUsefulTime: number | null = null;

  markBootStart(timeMs: number = Date.now()): void {
    if (this.startTime === null) {
      this.startTime = timeMs;
    }
  }

  markFirstUseful(timeMs: number = Date.now()): void {
    if (this.startTime !== null && this.firstUsefulTime === null) {
      this.firstUsefulTime = timeMs;
    }
  }

  get durationMs(): number | null {
    if (this.startTime !== null && this.firstUsefulTime !== null) {
      return this.firstUsefulTime - this.startTime;
    }
    return null;
  }
}
