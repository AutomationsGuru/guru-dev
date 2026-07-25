import { z } from "zod";

/**
 * Fleet dual status — two independent axes for agent state tracking.
 *
 * - **processStatus**: lifecycle/process state of the agent process
 * - **workStatus**: cognitive/work state of the agent
 *
 * Both axes are independent: you can have processStatus="running" and
 * workStatus="blocked" at the same time.
 */

// --- Process status axis ---

export const FleetProcessStatusSchema = z.enum([
  "starting",
  "running",
  "stopping",
  "stopped",
  "crashed"
]);
export type FleetProcessStatus = z.infer<typeof FleetProcessStatusSchema>;

// --- Work status axis ---

export const FleetWorkStatusSchema = z.enum([
  "idle",
  "working",
  "thinking",
  "blocked",
  "completed"
]);
export type FleetWorkStatus = z.infer<typeof FleetWorkStatusSchema>;

// --- Combined dual status ---

export const FleetDualStatusSchema = z
  .object({
    processStatus: FleetProcessStatusSchema,
    workStatus: FleetWorkStatusSchema
  })
  .strict();
export type FleetDualStatus = z.infer<typeof FleetDualStatusSchema>;

// --- Default values ---

const DEFAULT_PROCESS_STATUS: FleetProcessStatus = "starting";
const DEFAULT_WORK_STATUS: FleetWorkStatus = "idle";
const DEFAULT_DUAL_STATUS: FleetDualStatus = {
  processStatus: DEFAULT_PROCESS_STATUS,
  workStatus: DEFAULT_WORK_STATUS
};

// --- Factory ---

export interface FleetDualStatusHandle {
  setProcess(status: FleetProcessStatus): void;
  setWork(status: FleetWorkStatus): void;
  snapshot(): Readonly<FleetDualStatus>;
  reset(): void;
}

export function createFleetDualStatus(): FleetDualStatusHandle {
  let current: FleetDualStatus = { ...DEFAULT_DUAL_STATUS };

  return {
    setProcess(status: FleetProcessStatus): void {
      current = { ...current, processStatus: status };
    },

    setWork(status: FleetWorkStatus): void {
      current = { ...current, workStatus: status };
    },

    snapshot(): Readonly<FleetDualStatus> {
      return { ...current };
    },

    reset(): void {
      current = { ...DEFAULT_DUAL_STATUS };
    }
  };
}