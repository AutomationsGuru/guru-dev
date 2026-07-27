/**
 * ShellStreamBuffer - Ring buffer for partial shell output chunks.
 *
 * Enables background shell jobs to expose partial output to TUI subscribers
 * without blocking. Supports append(chunk), chunk() for next unread, readSince(timestamp).
 * Caps total bytes at 1MB default by dropping oldest entries when full.
 *
 * Ring buffer semantics:
 * - Entries are kept in insertion order with wall-clock timestamps (ms).
 * - When append would exceed cap, oldest whole entries are dropped until under cap.
 * - Single large chunk exceeding cap: the chunk is dropped entirely (after evicting older data).
 * - chunk() provides a simple sequential consumer cursor for unread chunks.
 * - readSince() allows timestamp-based catch-up independent of chunk() cursor.
 * - Not thread-safe; intended for single-threaded Node event loop usage.
 *   Concurrent append/chunk from multiple async contexts may require external synchronization.
 *
 * @example
 * const buf = new ShellStreamBuffer(512 * 1024); // 512KB cap
 * buf.append('partial output...');
 * const next = buf.chunk(); // 'partial output...'
 * const recent = buf.readSince(Date.now() - 5000);
 */

export class ShellStreamBuffer {
  private entries: Array<{ data: string; timestamp: number }> = [];
  private totalBytes: number = 0;
  private readIndex: number = 0;
  private readonly capBytes: number;

  /**
   * Create a new ShellStreamBuffer.
   * @param capBytes - Maximum bytes to retain (default 1MB = 1024*1024).
   */
  constructor(capBytes: number = 1024 * 1024) {
    if (capBytes <= 0) {
      throw new Error('capBytes must be positive');
    }
    this.capBytes = capBytes;
  }

  /**
   * Append output data to the buffer.
   * Converts Buffer to UTF-8 string. Enforces cap by dropping oldest entries.
   * If the new chunk alone exceeds cap (after evicting older), it is dropped.
   * @param data - string or Buffer chunk from shell stdout/stderr.
   */
  append(data: string | Buffer): void {
    const str = typeof data === 'string' ? data : data.toString('utf8');
    const entryBytes = Buffer.byteLength(str, 'utf8');
    const entry = { data: str, timestamp: Date.now() };

    // Evict oldest entries to make room for this one (or as much as possible)
    while (this.totalBytes + entryBytes > this.capBytes && this.entries.length > 0) {
      const oldest = this.entries.shift()!;
      this.totalBytes -= Buffer.byteLength(oldest.data, 'utf8');
      if (this.readIndex > 0) {
        this.readIndex--;
      }
    }

    // Only add if it fits within cap (handles single large chunk > cap)
    if (entryBytes <= this.capBytes) {
      this.entries.push(entry);
      this.totalBytes += entryBytes;
    }
    // If still > cap after evictions (i.e. entryBytes > cap), drop it silently.
    // This matches "drop oldest data when full" and keeps buffer under cap.
  }

  /**
   * Return the next unread chunk and advance the read cursor.
   * Returns null if no new chunks since last chunk() call (caught up).
   * Note: does not remove data; readSince() still sees all retained entries.
   */
  chunk(): string | null {
    if (this.readIndex >= this.entries.length) {
      return null;
    }
    const entry = this.entries[this.readIndex];
    this.readIndex++;
    return entry.data;
  }

  /**
   * Return all entries with timestamp > since (ms since epoch).
   * Useful for subscribers to catch up on recent output without cursor.
   * Order is chronological (oldest first).
   */
  readSince(since: number): Array<{ data: string; timestamp: number }> {
    return this.entries.filter((e) => e.timestamp > since);
  }

  /**
   * Current total bytes stored in the buffer.
   */
  getTotalBytes(): number {
    return this.totalBytes;
  }

  /**
   * Reset the buffer (clears entries, bytes, and read cursor).
   * Intended for testing or session reset.
   */
  clear(): void {
    this.entries = [];
    this.totalBytes = 0;
    this.readIndex = 0;
  }
}

export default ShellStreamBuffer;
