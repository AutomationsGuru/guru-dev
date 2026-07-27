/**
 * Sleeptime Agent Pass
 *
 * Schedules a deferred reflect/maintenance proposal on session idle.
 * Returns a cancellable ScheduledTask. When fired, creates a bounded
 * maintenance proposal via the operator-visible remember path.
 *
 * Constraints:
 * - Does NOT invoke models, tools, filesystem mutations, or self-build
 * - Proposal defaults to $0 cost, zero fanout
 * - Requires separately governed executor before any work runs
 * - Cancellation proves cancelled timer never delivers
 */

import { Session } from './agentSession.js';
import { ScheduledTask } from './scheduledTask.js';
import { remember, RememberEntry } from '../memory/remember.js';

export interface SleeptimeProposal extends RememberEntry {
  type: 'maintenance-proposal';
  cost: 0;
  fanout: 0;
  requiresExecutor: true;
}

/**
 * Schedule a sleeptime maintenance proposal pass.
 *
 * @param session - The active session context
 * @param delayMs - Milliseconds to wait before proposing maintenance
 * @returns ScheduledTask that can be cancelled before firing
 */
export function scheduleSleeptime(
  session: Session,
  delayMs: number
): ScheduledTask {
  if (!session) {
    throw new Error('scheduleSleeptime: session is required');
  }
  if (typeof delayMs !== 'number' || delayMs < 0) {
    throw new Error('scheduleSleeptime: delayMs must be a non-negative number');
  }

  const task = new ScheduledTask();

  task.schedule(() => {
    const proposal: SleeptimeProposal = {
      type: 'maintenance-proposal',
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      timestamp: new Date().toISOString(),
      content: 'Bounded maintenance proposal: reflect on session activity. ' +
        'Cost: $0, Fanout: 0. Requires separately governed executor. ' +
        'No model invocation, tool use, or filesystem mutation.',
      cost: 0,
      fanout: 0,
      requiresExecutor: true
    };

    remember(proposal);
  }, delayMs);

  return task;
}
