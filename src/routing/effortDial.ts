export type Effort = 'low' | 'medium' | 'high' | 'ultra';

export interface EffortConfig {
  maxTokens: number;
  thinking: boolean;
}

const effortMap: Record<Effort, EffortConfig> = {
  low: { maxTokens: 4096, thinking: false },
  medium: { maxTokens: 8192, thinking: true },
  high: { maxTokens: 16384, thinking: true },
  ultra: { maxTokens: 32768, thinking: true },
};

let currentEffort: Effort = 'medium';
let strongModelForUltra: string | undefined;

export function setEffort(e: Effort, pack?: { strongModel?: string }): void {
  if (!(e in effortMap)) {
    throw new Error(`Invalid effort level: ${e}`);
  }
  currentEffort = e;
  if (e === 'ultra' && pack?.strongModel) {
    strongModelForUltra = pack.strongModel;
  } else {
    strongModelForUltra = undefined;
  }
}

export function getEffort(): Effort {
  return currentEffort;
}

export function getEffortConfig(): EffortConfig {
  return effortMap[currentEffort];
}

export function getStrongModelForUltra(): string | undefined {
  return strongModelForUltra;
}

export { effortMap };
