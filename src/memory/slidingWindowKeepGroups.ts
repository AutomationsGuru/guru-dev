/**
 * Sliding window keep groups (IDEA-F248-SLIDE-WINDOW-01 / R-MA-SLIDE).
 *
 * Pure list reduction: keep the last N non-system message groups and drop older
 * groups while always preserving system messages. Groups are atomic conversation
 * units (MAF SlidingWindowStrategy residual) so a tool call never loses its
 * result. No I/O, no wall clock, no network — composes with F244 pipeline and
 * F245 triggers as a strategy step beneath the summarizing engine.
 */

export type SlidingWindowRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "toolCall"
  | "toolResult";

export interface SlidingWindowMessage {
  readonly role: SlidingWindowRole | (string & {});
  readonly content: string;
  readonly id?: string;
}

function isSystemRole(role: string): boolean {
  return role === "system";
}

function isToolishRole(role: string): boolean {
  return role === "tool" || role === "toolCall" || role === "toolResult";
}

function isSystemGroup(group: readonly SlidingWindowMessage[]): boolean {
  return group.length > 0 && group.every((message) => isSystemRole(message.role));
}

/**
 * Partition a flat transcript into atomic groups.
 *
 * - Each system message is its own group (always preserved by `compact`).
 * - A user or assistant message opens a new group.
 * - tool / toolCall / toolResult messages attach to the open group so a call
 *   and its result stay or go together; an orphan toolish message starts a group.
 */
export function groupMessages(
  messages: readonly SlidingWindowMessage[]
): SlidingWindowMessage[][] {
  const groups: SlidingWindowMessage[][] = [];
  let current: SlidingWindowMessage[] | undefined;

  for (const message of messages) {
    if (isSystemRole(message.role)) {
      if (current !== undefined) {
        groups.push(current);
        current = undefined;
      }
      groups.push([message]);
      continue;
    }

    if (isToolishRole(message.role)) {
      if (current !== undefined) {
        current.push(message);
      } else {
        current = [message];
      }
      continue;
    }

    // user | assistant | any other non-system role: open a fresh group
    if (current !== undefined) {
      groups.push(current);
    }
    current = [message];
  }

  if (current !== undefined) {
    groups.push(current);
  }

  return groups;
}

/**
 * Keep the last `keepLast` non-system groups; drop older non-system groups.
 * System messages are always preserved in their original relative order.
 * A non-positive `keepLast` keeps only system messages. Never mutates input.
 */
export function compact(
  messages: readonly SlidingWindowMessage[],
  keepLast: number
): SlidingWindowMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const window = keepLast > 0 ? Math.floor(keepLast) : 0;
  const groups = groupMessages(messages);

  const nonSystemIndices: number[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group && !isSystemGroup(group)) {
      nonSystemIndices.push(index);
    }
  }

  if (window >= nonSystemIndices.length) {
    // Nothing to drop — return a shallow copy so callers can treat the result
    // as owned without aliasing the input array.
    return messages.slice();
  }

  const keptNonSystem = new Set(nonSystemIndices.slice(nonSystemIndices.length - window));
  const out: SlidingWindowMessage[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) {
      continue;
    }
    if (isSystemGroup(group) || keptNonSystem.has(index)) {
      for (const message of group) {
        out.push(message);
      }
    }
  }
  return out;
}
