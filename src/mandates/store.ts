import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { MandateStateSchema, type MandateGrant, type MandateState } from "./schema.js";

/**
 * Mandate store — grants/denies persisted as POLICY (not secrets) under
 * ~/.guruharness/mandates.json. Atomic writes; safeParse-skip-corrupt.
 */

const DEFAULT_PATH = join(homedir(), ".guruharness", "mandates.json");

export interface MandateStoreOptions {
  readonly filePath?: string;
  readonly now?: () => Date;
}

export interface MandateStore {
  readonly filePath: string;
  load(): MandateState;
  grant(grant: Omit<MandateGrant, "grantedAt">): MandateState;
  revokeAll(): MandateState;
}

export function createMandateStore(options: MandateStoreOptions = {}): MandateStore {
  const filePath = options.filePath ?? DEFAULT_PATH;
  const now = options.now ?? (() => new Date());

  const read = (): MandateState => {
    if (!existsSync(filePath)) {
      return { grants: [], denies: [] };
    }
    try {
      const parsed = MandateStateSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
      return parsed.success ? parsed.data : { grants: [], denies: [] };
    } catch {
      return { grants: [], denies: [] };
    }
  };

  const write = (state: MandateState): void => {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(MandateStateSchema.parse(state), null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
  };

  return {
    filePath,
    load: read,
    grant(partial) {
      const state = read();
      const next: MandateState = {
        ...state,
        grants: [...state.grants, { ...partial, grantedAt: now().toISOString() }]
      };
      write(next);
      return next;
    },
    revokeAll() {
      const next: MandateState = { grants: [], denies: [] };
      write(next);
      return next;
    }
  };
}
