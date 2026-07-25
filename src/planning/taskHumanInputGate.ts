export interface TaskHumanInput {
  humanInput?: boolean;
}

export interface OperatorReceipt {
  receivedAt: string;
}

export function canComplete(task: TaskHumanInput, receipt?: OperatorReceipt): boolean {
  return !task.humanInput || receipt !== undefined;
}
