import { MANDATE_READ_ONLY_TOOLS } from "../../mandates/evaluate.js";
import type { HarnessProfile } from "../harnessProfile.js";

/**
 * The `minimal` profile: small prompt, reduced tool-surface labels, and
 * linear-parse response mode (model emits linear text the runtime parses).
 * Pure data module — Guru's runtime still executes every tool.
 */
export const minimalProfile: HarnessProfile = {
  id: "minimal",
  description: "Minimal surface: short prompt, terse tool labels, linear text parsed into tool calls.",
  systemPromptParts: [
    "You are a minimal agent.",
    "Emit one action per line as: TOOL <id> <json-input>.",
    "Only use the tools listed below."
  ],
  toolSurface: {
    // Narrow the presented surface to a small working set. Hard-limit tools
    // that exist in the runtime tool list still survive this narrowing.
    include: ["read", "ls", "bash"],
    overrides: {
      read: { label: "read-file", description: "Read a file." },
      ls: { label: "list-dir", description: "List a directory." },
      bash: { label: "shell", description: "Run a shell command." }
    }
  },
  responseMode: "linear-parse",
  hardLimitToolIds: [...MANDATE_READ_ONLY_TOOLS]
};
