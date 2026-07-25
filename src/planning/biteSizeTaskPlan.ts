export interface BiteSizeTask {
  description: string;
  path: string;
  verification: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateTask(task: Partial<BiteSizeTask>): ValidationResult {
  const errors: string[] = [];

  if (!task.path || task.path.trim() === '') {
    errors.push('Task is missing a required path.');
  }

  if (!task.verification || task.verification.trim() === '') {
    errors.push('Task is missing a required verification step.');
  }

  return {
    ok: errors.length === 0,
    errors
  };
}
