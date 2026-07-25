export function validateTask(task: any): void {
  if (typeof task?.expectedOutput !== 'string' || task.expectedOutput.trim() === '') {
    throw new Error('expectedOutput is required and must be a non-empty string');
  }
  // optional schema key supported (no further validation for minimal contract)
  if (task.schema !== undefined && typeof task.schema !== 'object') {
    throw new Error('schema must be an object if provided');
  }
}