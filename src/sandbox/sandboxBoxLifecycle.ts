export enum SandboxBoxStatus {
  UNKNOWN = 'UNKNOWN',
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  DESTROYED = 'DESTROYED',
}

const validTransitions: Partial<Record<SandboxBoxStatus, SandboxBoxStatus[]>> = {
  [SandboxBoxStatus.STOPPED]: [SandboxBoxStatus.STARTING, SandboxBoxStatus.DESTROYED],
  [SandboxBoxStatus.STARTING]: [SandboxBoxStatus.RUNNING, SandboxBoxStatus.STOPPED],
  [SandboxBoxStatus.RUNNING]: [SandboxBoxStatus.STOPPING],
  [SandboxBoxStatus.STOPPING]: [SandboxBoxStatus.STOPPED],
};

export function transitionSandboxBoxStatus(from: SandboxBoxStatus, to: SandboxBoxStatus): SandboxBoxStatus {
  const allowedTransitions = validTransitions[from];
  if (allowedTransitions?.includes(to)) {
    return to;
  }
  throw new Error(`Invalid state transition from ${from} to ${to}`);
}
