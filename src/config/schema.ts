import { z } from "zod";

import { SwarmConfigSchema } from "../swarm/schema.js";
import { LookAheadConfigSchema } from "../lookahead/schema.js";
import { CompactionConfigSchema } from "../compaction/schemas.js";
import { RetryConfigSchema } from "../model/retryPolicy.js";
import { BashOptimizerConfigSchema } from "../tools/bashOptimizer.js";
import { McpServerConfigSchema } from "../mcp/schemas.js";

import { PlannerModelConfigSchema } from "../model/schemas.js";

export const ValidationCommandSchema = z
  .object({
    name: z.string().trim().min(1),
    command: z.array(z.string().trim().min(1)).min(1),
    required: z.boolean().default(true)
  })
  .strict();
export type ValidationCommand = z.infer<typeof ValidationCommandSchema>;

/** Native critic-panel tuning (P1) — a model-powered adversarial review that needs no external tool. */
export const CriticPanelConfigSchema = z
  .object({
    /** Review lenses; each is one read-only critic persona. */
    personas: z.array(z.string().trim().min(1)).min(1).default(["security", "correctness", "contract", "simplicity"]),
    /** Run the adversarial VERIFY pass (confirm-with-repro / refute) before a finding counts. */
    verifyPass: z.boolean().default(true),
    /** Which surviving CONFIRMED severity is RED vs YELLOW. */
    redSeverities: z.array(z.enum(["low", "medium", "high"])).default(["high"]),
    /** Hard cap on critic+verifier model calls per review (bounds cost). */
    maxWorkers: z.number().int().positive().default(12)
  })
  .strict();
export type CriticPanelConfig = z.infer<typeof CriticPanelConfigSchema>;

/**
 * The review gate. `native-critic-panel` (default) is guru's OWN model-powered
 * review — it assumes only guru + a model connection (Foundational Law 1).
 * `command` runs an optional external CLI and needs a `command` argv.
 * CodeRabbit was removed from the project (2026-07-10) — do not reintroduce.
 */
export const ReviewGateSchema = z
  .object({
    provider: z.enum(["native-critic-panel", "command"]).default("native-critic-panel"),
    required: z.boolean().default(true),
    command: z.array(z.string().trim().min(1)).min(1).optional(),
    panel: CriticPanelConfigSchema.optional()
  })
  .strict()
  .refine((gate) => gate.provider === "native-critic-panel" || (gate.command !== undefined && gate.command.length > 0), {
    message: "reviewGate.command is required when provider is command.",
    path: ["command"]
  });
export type ReviewGate = z.infer<typeof ReviewGateSchema>;

export const ApprovalPolicySchema = z
  .object({
    autoCommitPushPr: z.boolean().default(true),
    allowLocalMerge: z.boolean().default(false),
    allowForcePush: z.boolean().default(false)
  })
  .strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const SelfBuildConfigSchema = z
  .object({
    maxIterations: z.number().int().positive().max(10).default(1),
    completedTaskIds: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type SelfBuildConfig = z.infer<typeof SelfBuildConfigSchema>;

/** Boot ritual Phase 5 (§4): a fast baseline command run green at boot (TTFV). */
export const BaselineHealthConfigSchema = z
  .object({
    /** The command to run (argv). Empty = the phase skips with a note. */
    command: z.array(z.string().trim().min(1)).default([]),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000)
  })
  .strict();
export type BaselineHealthConfig = z.infer<typeof BaselineHealthConfigSchema>;

export const PlannerModelFallbacksSchema = z.array(PlannerModelConfigSchema).default([]);

const DEFAULT_RISKY_PATH_PATTERNS = [
  ".git",
  ".env",
  ".ssh",
  ".aws",
  ".npmrc",
  ".yarnrc",
  ".netrc",
  ".config/gcloud",
  "secrets",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "service-account"
];

// Build/runtime tools plus read-only exploration basics — agentic models reach for
// ls/cat/grep constantly; blocking them burns tool-call budget on no-ops (2026-07-02
// scale shakedown). Exploration commands stay cwd-contained and content-guarded.
const DEFAULT_SHELL_ALLOWLIST = ["npm", "node", "git", "pwsh", "ls", "dir", "cat", "type", "head", "tail", "grep", "findstr", "pwd", "echo", "wc"];

export const RuntimeHardeningSchema = z
  .object({
    allowDirtyWorkspace: z.boolean().default(false),
    allowRiskyPaths: z.boolean().default(false),
    plannerMaxRetries: z.number().int().positive().max(10).default(1),
    riskyPathPatterns: z.array(z.string().trim().min(1)).default(DEFAULT_RISKY_PATH_PATTERNS),
    secretAllowList: z.array(z.string().trim()).default([]),
    shellAllowlist: z.array(z.string().trim().min(1)).default(DEFAULT_SHELL_ALLOWLIST)
  })
  .strict();
export type RuntimeHardeningConfig = z.infer<typeof RuntimeHardeningSchema>;

export const HarnessConfigSchema = z
  .object({
    runtimeName: z.string().trim().min(1).default("GuruHarness"),
    referenceRuntime: z.string().trim().min(1).default("a reference agent runtime"),
    skillDirectories: z.array(z.string().trim().min(1)).default([]),
    validationCommands: z.array(ValidationCommandSchema).default([]),
    // Default review = guru's OWN native critic panel (no external review SaaS).
    reviewGate: ReviewGateSchema.default({
      provider: "native-critic-panel",
      required: true
    }),
    approvalPolicy: ApprovalPolicySchema.default({
      autoCommitPushPr: true,
      allowLocalMerge: false,
      allowForcePush: false
    }),
    plannerModel: PlannerModelConfigSchema.optional(),
    plannerModelFallbacks: PlannerModelFallbacksSchema,
    runtimeHardening: RuntimeHardeningSchema.default({
      allowDirtyWorkspace: false,
      allowRiskyPaths: false,
      plannerMaxRetries: 1,
      riskyPathPatterns: DEFAULT_RISKY_PATH_PATTERNS,
      secretAllowList: [],
      shellAllowlist: DEFAULT_SHELL_ALLOWLIST
    }),
    selfBuild: SelfBuildConfigSchema.default({
      maxIterations: 1,
      completedTaskIds: []
    }),
    /** Swarm ceilings (Phase F): safe defaults; ultraSwarm is the big-iron crank. */
    swarm: SwarmConfigSchema.default(() => SwarmConfigSchema.parse({})),
    /** Look-ahead engine (Finale): off by default; scouts run ahead in dead time. */
    lookahead: LookAheadConfigSchema.default(() => LookAheadConfigSchema.parse({})),
    /** Compaction engine (Runtime Survival wave): context survival for long sessions. */
    compaction: CompactionConfigSchema.default(() => CompactionConfigSchema.parse({})),
    /** Turn-loop retry policy (Runtime Survival Clusters 2+3): absorb transient provider errors. */
    retry: RetryConfigSchema.default(() => RetryConfigSchema.parse({})),
    /** Bash token optimizer (every-session-dividends wave): OFF by default (pilot). */
    bashOptimizer: BashOptimizerConfigSchema.default(() => BashOptimizerConfigSchema.parse({})),
    /** Boot ritual Phase 5 (TTFV): a fast baseline command run at boot; empty = skip. */
    baselineHealth: BaselineHealthConfigSchema.default(() => BaselineHealthConfigSchema.parse({})),
    /** MCP servers to ATTACH (never-stuck resolver): stdio JSON-RPC; empty = none. */
    mcpServers: z.array(McpServerConfigSchema).default([])
  })
  .strict();
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type HarnessConfigInput = z.input<typeof HarnessConfigSchema>;

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = HarnessConfigSchema.parse({
  runtimeName: "GuruHarness",
  referenceRuntime: "a reference agent runtime",
  skillDirectories: [],
  validationCommands: [
    { name: "test", command: ["npm", "test"], required: true },
    { name: "typecheck", command: ["npm", "run", "typecheck"], required: true },
    { name: "build", command: ["npm", "run", "build"], required: true }
  ],
  reviewGate: {
    provider: "native-critic-panel",
    required: true
  },
  approvalPolicy: {
    autoCommitPushPr: true,
    allowLocalMerge: false,
    allowForcePush: false
  },
  runtimeHardening: {
    allowDirtyWorkspace: false,
    allowRiskyPaths: false,
    plannerMaxRetries: 1,
    riskyPathPatterns: DEFAULT_RISKY_PATH_PATTERNS,
    secretAllowList: [],
    shellAllowlist: DEFAULT_SHELL_ALLOWLIST
  },
  selfBuild: {
    maxIterations: 1,
    completedTaskIds: []
  }
});
