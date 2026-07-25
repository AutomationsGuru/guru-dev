import {
  LinearTrajectoryMessageSchema,
  type LinearTrajectoryMessage
} from "./linearTrajectorySchema.js";

/**
 * Append-only model context that doubles as an exportable trajectory.
 *
 * Each append is validated and cloned before it enters the log; each export is a
 * fresh clone. This keeps historical steps stable even when callers reuse or
 * mutate their own objects after appending.
 */
export class LinearTrajectory {
  private readonly entries: LinearTrajectoryMessage[] = [];

  append(message: LinearTrajectoryMessage): void {
    this.entries.push(structuredClone(LinearTrajectoryMessageSchema.parse(message)));
  }

  asModelMessages(): LinearTrajectoryMessage[] {
    return structuredClone(this.entries);
  }
}
