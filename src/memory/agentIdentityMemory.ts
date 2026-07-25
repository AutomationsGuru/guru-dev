import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AgentIdentityBlockInputSchema,
  AgentIdentitySchema,
  DEFAULT_HARD_LIMIT_ANCHOR_TEXT,
  HARD_LIMIT_ANCHOR_LABEL,
  type AgentIdentity,
  type AgentIdentityBlock,
  type AgentIdentityBlockInput,
  type AgentIdentityUpdateResult
} from "./agentIdentityMemorySchema.js";

/**
 * Agent identity memory — the implementation half of IDEA-F174.
 *
 * Owns: createAgent (mint a durable id + the constitution anchor block),
 * setBlock/getBlock/getBlocks (named label→text blocks), applyUpdate (the
 * structural gate that rejects anchor removal), serialize/load (JSON
 * round-trip), and mergeIntoSystemContext (render the identity into the system
 * prompt at boot). The hard-limit anchor is enforced HERE, in the applyUpdate
 * path — not in a prompt — so the rule "never lose the five hard limits" is a
 * tested code path, not prose a model could ignore (closes prompt-rule drift).
 *
 * Persistence mirrors the L1 store's atomic-write discipline (tmp+rename) so a
 * crash mid-save never leaves a truncated identity file. A malformed file on
 * load returns undefined (skip-and-report), never throws — one bad identity
 * never takes down the boot, matching `parseFactFile`'s contract.
 */

const DEFAULT_SUBDIR = join(".guruharness", "identity");
const IDENTITY_FILENAME = "agent-identity.json";

export interface AgentIdentityMemoryOptions {
  /** Directory override (tests / space / role scopes). Defaults to ~/.guruharness/identity. */
  readonly directory?: string;
  readonly now?: () => Date;
  /** Inject a deterministic id (tests). Defaults to a crypto-random id. */
  readonly agentId?: string;
}

export interface AgentIdentityMemory {
  readonly directory: string;
  readonly identityFile: string;
  /** Mint a new agent identity. Throws if one already exists at this path (use load). */
  createAgent(initialBlocks?: readonly AgentIdentityBlockInput[]): AgentIdentity;
  /** Load the persisted identity, or undefined if none / malformed. */
  load(): AgentIdentity | undefined;
  /** Persist an identity atomically (tmp+rename). */
  save(identity: AgentIdentity): void;
  /** Canonical JSON form — stable key order for a clean round-trip + diff. */
  serialize(identity: AgentIdentity): string;
  /** Parse serialized JSON; returns undefined on any malformed input. */
  deserialize(text: string): AgentIdentity | undefined;
  /** Set/replace a block (text-only edit; the anchor block is always protected). */
  setBlock(identity: AgentIdentity, input: AgentIdentityBlockInput): AgentIdentityUpdateResult;
  /** Read one block by label, or undefined. */
  getBlock(identity: AgentIdentity, label: string): AgentIdentityBlock | undefined;
  /** Read every block (insertion order). */
  getBlocks(identity: AgentIdentity): readonly AgentIdentityBlock[];
  /**
   * Apply a batch of block edits. REJECTS (ok:false) if the result would remove
   * a protected block (the hard-limit anchor) — the structural constitution gate.
   */
  applyUpdate(identity: AgentIdentity, updates: readonly AgentIdentityBlockInput[]): AgentIdentityUpdateResult;
  /** Render the identity into a system-context block (empty string if no blocks). */
  mergeIntoSystemContext(identity: AgentIdentity): string;
}

export function resolveIdentityDirectory(options: AgentIdentityMemoryOptions = {}): string {
  return options.directory ?? join(homedir(), DEFAULT_SUBDIR);
}

function defaultAgentId(): string {
  // crypto.randomUUID without pulling node:crypto explicitly (global on Node 19+).
  return `agent-${globalThis.crypto.randomUUID()}`;
}

function cloneIdentity(identity: AgentIdentity): AgentIdentity {
  return {
    agentId: identity.agentId,
    version: 1,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    blocks: identity.blocks.map((block) => ({ ...block }))
  };
}

/** Build the protected anchor block — always present on a created identity. */
function anchorBlock(text: string = DEFAULT_HARD_LIMIT_ANCHOR_TEXT): AgentIdentityBlock {
  return { label: HARD_LIMIT_ANCHOR_LABEL, text, protected: true };
}

/** True if a block with the anchor label and protected flag survives in the set. */
export function hasHardLimitAnchor(blocks: readonly AgentIdentityBlock[]): boolean {
  return blocks.some((block) => block.label === HARD_LIMIT_ANCHOR_LABEL && block.protected && block.text.trim().length > 0);
}

export function createAgentIdentityMemory(options: AgentIdentityMemoryOptions = {}): AgentIdentityMemory {
  const directory = resolveIdentityDirectory(options);
  const now = options.now ?? (() => new Date());
  const identityFile = join(directory, IDENTITY_FILENAME);

  const ensureDir = (): void => {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  };

  const writeAtomic = (path: string, content: string): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  };

  const memory: AgentIdentityMemory = {
    directory,
    identityFile,

    createAgent(initialBlocks = []) {
      if (existsSync(identityFile)) {
        throw new Error(`Agent identity already exists at ${identityFile} — use load() to read it.`);
      }
      ensureDir();
      const timestamp = now().toISOString();
      // The anchor is always first and always protected, regardless of input.
      const blocks: AgentIdentityBlock[] = [anchorBlock()];
      const seen = new Set<string>([HARD_LIMIT_ANCHOR_LABEL]);
      for (const raw of initialBlocks) {
        const parsed = AgentIdentityBlockInputSchema.parse(raw);
        if (parsed.label === HARD_LIMIT_ANCHOR_LABEL) {
          // Allow the caller to override the anchor TEXT, never its protection.
          blocks[0] = anchorBlock(parsed.text);
          continue;
        }
        if (seen.has(parsed.label)) {
          continue; // dedupe within the create payload
        }
        seen.add(parsed.label);
        blocks.push({ label: parsed.label, text: parsed.text, protected: false });
      }
      const identity: AgentIdentity = {
        agentId: options.agentId ?? defaultAgentId(),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        blocks
      };
      writeAtomic(identityFile, memory.serialize(identity));
      return identity;
    },

    load() {
      if (!existsSync(identityFile)) {
        return undefined;
      }
      return memory.deserialize(readFileSync(identityFile, "utf8"));
    },

    save(identity) {
      ensureDir();
      writeAtomic(identityFile, memory.serialize(identity));
    },

    serialize(identity) {
      // Stable key order: arrays as-is. JSON.stringify preserves insertion order.
      return `${JSON.stringify(identity, null, 2)}\n`;
    },

    deserialize(text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return undefined;
      }
      const result = AgentIdentitySchema.safeParse(parsed);
      return result.success ? result.data : undefined;
    },

    setBlock(identity, input) {
      return memory.applyUpdate(identity, [input]);
    },

    getBlock(identity, label) {
      return identity.blocks.find((block) => block.label === label);
    },

    getBlocks(identity) {
      return identity.blocks.map((block) => ({ ...block }));
    },

    applyUpdate(identity, updates) {
      const next = cloneIdentity(identity);
      // index by label for in-place replace; preserve insertion order otherwise.
      const byLabel = new Map<string, number>();
      next.blocks.forEach((block, index) => byLabel.set(block.label, index));

      for (const raw of updates) {
        const parsed = AgentIdentityBlockInputSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false as const,
            blockers: parsed.error.issues.map((issue) => issue.message),
            summary: "Identity block input failed validation."
          };
        }
        if (parsed.data.label === HARD_LIMIT_ANCHOR_LABEL) {
          // Anchor edits update TEXT only; protection and position are fixed.
          const anchorIndex = byLabel.get(HARD_LIMIT_ANCHOR_LABEL);
          if (anchorIndex === undefined) {
            // Should be impossible (createAgent guarantees it), but fail closed.
            next.blocks.unshift(anchorBlock(parsed.data.text));
            byLabel.set(HARD_LIMIT_ANCHOR_LABEL, 0);
          } else {
            const existing = next.blocks[anchorIndex];
            if (existing) {
              next.blocks[anchorIndex] = { ...existing, text: parsed.data.text, protected: true };
            }
          }
          continue;
        }
        const existingIndex = byLabel.get(parsed.data.label);
        if (existingIndex !== undefined) {
          const existing = next.blocks[existingIndex];
          if (existing) {
            // A protected non-anchor block keeps its protection; otherwise honor input.
            next.blocks[existingIndex] = {
              label: existing.label,
              text: parsed.data.text,
              protected: existing.protected || parsed.data.protected === true
            };
          }
        } else {
          const block: AgentIdentityBlock = { label: parsed.data.label, text: parsed.data.text, protected: parsed.data.protected === true };
          next.blocks.push(block);
          byLabel.set(block.label, next.blocks.length - 1);
        }
      }

      // THE CONSTITUTION GATE: the anchor must survive every update.
      if (!hasHardLimitAnchor(next.blocks)) {
        return {
          ok: false as const,
          blockers: ["hard-limit-anchor-removed"],
          summary: "Update rejected: it would remove the protected hard-limit anchor block. The five hard limits are constitutionally non-removable."
        };
      }

      next.updatedAt = now().toISOString();
      return { ok: true as const, identity: next };
    },

    mergeIntoSystemContext(identity) {
      if (identity.blocks.length === 0) {
        return "";
      }
      const lines: string[] = ["## Agent identity", ""];
      for (const block of identity.blocks) {
        lines.push(`### ${block.label}${block.protected ? " (protected)" : ""}`, "", block.text.trim(), "");
      }
      return lines.join("\n").trimEnd();
    }
  };

  return memory;
}
