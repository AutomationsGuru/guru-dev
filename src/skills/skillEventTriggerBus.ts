export interface SkillEventTriggerBus {
  on(event: string, skillId: string): void;
  dispatch(event: string): string[];
}

export function createSkillEventTriggerBus(): SkillEventTriggerBus {
  const triggers = new Map<string, Set<string>>();

  return {
    on(event: string, skillId: string): void {
      const skillIds = triggers.get(event);

      if (skillIds) {
        skillIds.add(skillId);
        return;
      }

      triggers.set(event, new Set([skillId]));
    },
    dispatch(event: string): string[] {
      return [...(triggers.get(event) ?? [])];
    }
  };
}
