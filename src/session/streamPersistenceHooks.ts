export const STREAM_PERSISTENCE_TURN_EVENT = "turn.stream.chunk" as const;

export interface StreamPersistenceTurnEvent {
  readonly type: typeof STREAM_PERSISTENCE_TURN_EVENT;
  readonly sequence: number;
  readonly text: string;
}

export interface StreamPersistenceHooks {
  onChunk(text: string): void;
  flush(): Promise<readonly StreamPersistenceTurnEvent[]>;
  pending(): readonly StreamPersistenceTurnEvent[];
}

export interface StreamPersistenceHooksOptions {
  readonly persist: (events: readonly StreamPersistenceTurnEvent[]) => void | Promise<void>;
}

/**
 * Capture streamed assistant chunks as replayable turn events. Each accepted
 * chunk receives a monotonically increasing sequence so replayers can restore
 * the exact stream order later, even when the persistence sink stores events
 * independently.
 */
export function createStreamPersistenceHooks(options: StreamPersistenceHooksOptions): StreamPersistenceHooks {
  let nextSequence = 1;
  let queued: StreamPersistenceTurnEvent[] = [];
  let flushChain = Promise.resolve<readonly StreamPersistenceTurnEvent[]>([]);

  return {
    onChunk(text: string): void {
      if (text.length === 0) {
        return;
      }
      queued = [...queued, createTurnEvent(nextSequence, text)];
      nextSequence += 1;
    },
    async flush(): Promise<readonly StreamPersistenceTurnEvent[]> {
      const batch = queued;
      queued = [];
      if (batch.length === 0) {
        return [];
      }
      flushChain = flushChain.then(async () => {
        await options.persist(batch);
        return batch;
      });
      return flushChain;
    },
    pending(): readonly StreamPersistenceTurnEvent[] {
      return [...queued];
    }
  };
}

export function replayStreamTurnText(events: readonly StreamPersistenceTurnEvent[]): string {
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => event.text)
    .join("");
}

function createTurnEvent(sequence: number, text: string): StreamPersistenceTurnEvent {
  return {
    type: STREAM_PERSISTENCE_TURN_EVENT,
    sequence,
    text
  };
}
