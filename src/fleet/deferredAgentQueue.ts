// src/fleet/deferredAgentQueue.ts

export interface DeferredAgentJob {
  id: string;
  agentId: string;
  runAt: Date;
  priority: number; // Lower number is higher priority
}

export interface DeferredAgentQueue {
  enqueue: (job: DeferredAgentJob) => void;
  list: () => DeferredAgentJob[];
  cancel: (jobId: string) => boolean;
  popReady: (now: Date) => DeferredAgentJob | undefined;
}

export function createDeferredAgentQueue(): DeferredAgentQueue {
  const jobs: DeferredAgentJob[] = [];

  const enqueue = (job: DeferredAgentJob): void => {
    jobs.push(job);
  };

  const list = (): DeferredAgentJob[] => {
    return [...jobs];
  };

  const cancel = (jobId: string): boolean => {
    const index = jobs.findIndex(job => job.id === jobId);
    if (index !== -1) {
      jobs.splice(index, 1);
      return true;
    }
    return false;
  };

  const popReady = (now: Date): DeferredAgentJob | undefined => {
    const readyJobs = jobs.filter(job => job.runAt.getTime() <= now.getTime());
    if (readyJobs.length === 0) {
      return undefined;
    }

    // Sort by priority (lower is higher), then by runAt (earlier is higher)
    readyJobs.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.runAt.getTime() - b.runAt.getTime();
    });

    const jobToPop = readyJobs[0];
    const indexInMainQueue = jobs.findIndex(job => job.id === jobToPop.id);
    if (indexInMainQueue !== -1) {
      jobs.splice(indexInMainQueue, 1);
    }

    return jobToPop;
  };

  return {
    enqueue,
    list,
    cancel,
    popReady,
  };
}
