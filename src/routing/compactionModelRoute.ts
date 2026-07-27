import { ModelSlot } from '../core/types.js';

export function needsCompact(tokenCount: number, budget: number): boolean {
  return tokenCount > budget;
}

export function resolveCompactModel(slots: ModelSlot[]): string | null {
  const compactModel = slots.find(slot => slot.role === 'compact');
  if (compactModel) {
    return compactModel.name;
  }
  const mainModel = slots.find(slot => slot.role === 'main');
  if (mainModel) {
    return mainModel.name;
  }
  return null;
}
