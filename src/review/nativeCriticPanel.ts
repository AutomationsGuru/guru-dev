import type { CriticPanelConfig } from "../config/schema.js";
import type { CommandGate, CommandGateResult, NativeReviewer, ReviewGateVerdict } from "./gates.js";

/**
 * Native adversarial critic panel (self-build P1) — guru's OWN model-powered code
 * review. It is the default review path (no external review SaaS): it needs nothing but the
 * accepted baseline model connection (Foundational Law 1), and it CANNOT rubber-stamp
 * itself — read-only persona critics (a diff in, findings out, NO tools), an independent
 * adversarial VERIFY pass (confirm-with-repro or refute), and a verdict SYNTHESIZED IN
 * CODE (not model discretion): GREEN iff no surviving CONFIRMED finding at a RED severity.
 */

export type Severity = "low" | "medium" | "high";

export interface CriticFinding {
  readonly persona: string;
  readonly severity: Severity;
  readonly summary: string;
  readonly failureScenario: string;
  readonly file?: string;
  readonly line?: number;
}

export interface NativeReviewContext {
  /** The change under review (diff / changed files). Critics see ONLY this + the objective. */
  readonly diff: string;
  readonly objective?: string;
  readonly plannerNotes?: string;
}

export interface NativeReviewResult {
  readonly verdict: ReviewGateVerdict;
  readonly findings: readonly CriticFinding[]; // surviving CONFIRMED findings
  readonly reviewers: readonly string[];
  readonly refutedCount: number;
  readonly summary: string;
  /** Aggregate usage from completed FIND/VERIFY responses; absent for legacy string responses. */
  readonly usage?: ModelTokenUsage;
}

export interface ModelTokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface AskModelResponse {
  readonly text: string;
  readonly usage?: ModelTokenUsage;
}

export type AskModelResult = string | AskModelResponse;

/**
 * The one external dependency — a single-turn model call. Critics are read-only BY
 * CONSTRUCTION: they receive a prompt and return text; they are never handed a tool,
 * a file handle, or an executor, so there is nothing to deny.
 */
export type AskModel = (
  prompt: string,
  meta: { readonly persona: string; readonly phase: "find" | "verify" }
) => Promise<AskModelResult>;

const PERSONA_BRIEF: Readonly<Record<string, string>> = {
  security: "secrets/credential leaks, injection, unsafe shell/eval, auth/permission bypass, path traversal, unsafe deserialization",
  correctness: "logic bugs, off-by-one, null/undefined derefs, wrong conditionals, unhandled errors, race conditions, incorrect edge cases",
  contract: "breaking changes to public APIs/types, regressions in existing behavior, missing/weakened tests, violated invariants",
  simplicity: "needless complexity, dead code, duplicated logic, unclear naming, over-abstraction — flag only where it risks a real defect"
};

const SEVERITIES: readonly Severity[] = ["low", "medium", "high"];

/** Pull the first JSON array/object out of a model response (which may wrap it in prose/markdown). */
function extractJson(text: string): unknown {
  const start = text.search(/[[{]/u);
  if (start === -1) {
    return null;
  }
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeSeverity(value: unknown): Severity {
  const s = String(value ?? "").toLowerCase();
  return s === "high" || s === "critical" ? "high" : s === "low" ? "low" : "medium";
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeAskModelResult(result: AskModelResult): AskModelResponse {
  if (typeof result === "string") {
    return { text: result };
  }
  return {
    text: result.text,
    ...(result.usage
      ? {
          usage: {
            input: normalizeTokenCount(result.usage.input),
            output: normalizeTokenCount(result.usage.output)
          }
        }
      : {})
  };
}

function findPrompt(persona: string, context: NativeReviewContext): string {
  const brief = PERSONA_BRIEF[persona] ?? `defects in the ${persona} dimension`;
  return [
    `You are a strict, adversarial code reviewer. Lens: ${persona.toUpperCase()} — focus on: ${brief}.`,
    context.objective ? `The change was meant to: ${context.objective}` : "",
    "Review ONLY the change below. Report ONLY real, specific defects you can justify — do not invent issues, do not restyle.",
    "Respond with a JSON array (empty if none). Each item: {\"severity\":\"low|medium|high\",\"summary\":\"one line\",\"failureScenario\":\"concrete input/state -> wrong result\",\"file\":\"path\",\"line\":123}.",
    "",
    "----- CHANGE UNDER REVIEW -----",
    context.diff.slice(0, 60_000),
    "----- END CHANGE -----"
  ].filter(Boolean).join("\n");
}

function verifyPrompt(finding: CriticFinding, context: NativeReviewContext): string {
  return [
    "You are an independent skeptic. A reviewer raised the finding below. Try to REFUTE it.",
    "It counts as CONFIRMED only if you can name a concrete input/state that actually triggers the defect in THIS change. If you cannot, or it is speculative/stylistic, REFUTE it.",
    `FINDING (${finding.severity}): ${finding.summary}`,
    `Claimed failure: ${finding.failureScenario}`,
    finding.file ? `At: ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "",
    "",
    "Respond with JSON: {\"confirmed\": true|false, \"reason\": \"the concrete repro, or why it is refuted\"}.",
    "",
    "----- CHANGE UNDER REVIEW -----",
    context.diff.slice(0, 60_000),
    "----- END CHANGE -----"
  ].filter(Boolean).join("\n");
}

/** Run the panel: parallel FIND per persona, adversarial VERIFY per finding, code-synthesized verdict. */
export async function runNativeCriticPanel(
  context: NativeReviewContext,
  deps: { readonly askModel: AskModel; readonly panel: CriticPanelConfig }
): Promise<NativeReviewResult> {
  const { askModel, panel } = deps;
  const personas = panel.personas;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let observedUsage = false;
  const budgetLeft = (): number => panel.maxWorkers - calls;
  const recordResponse = (result: AskModelResult): AskModelResponse => {
    const response = normalizeAskModelResult(result);
    if (response.usage) {
      observedUsage = true;
      inputTokens += response.usage.input;
      outputTokens += response.usage.output;
    }
    return response;
  };

  // --- FIND (each persona reads the diff; capped by the worker budget) ---
  const findResults = await Promise.all(
    personas.slice(0, Math.max(0, budgetLeft())).map(async (persona) => {
      calls += 1;
      try {
        const response = recordResponse(await askModel(findPrompt(persona, context), { persona, phase: "find" }));
        const parsed = extractJson(response.text);
        const items = Array.isArray(parsed) ? parsed : [];
        return items
          .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
          .map((item): CriticFinding => ({
            persona,
            severity: normalizeSeverity(item.severity),
            summary: String(item.summary ?? "unspecified"),
            failureScenario: String(item.failureScenario ?? item.summary ?? ""),
            ...(typeof item.file === "string" ? { file: item.file } : {}),
            ...(typeof item.line === "number" ? { line: item.line } : {})
          }));
      } catch {
        return [] as CriticFinding[];
      }
    })
  );
  const found = findResults.flat();

  // --- VERIFY (adversarial refute; kept in severity order until the budget runs out) ---
  const ordered = [...found].sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity));
  const confirmed: CriticFinding[] = [];
  let refutedCount = 0;
  for (const finding of ordered) {
    if (!panel.verifyPass) {
      confirmed.push(finding);
      continue;
    }
    if (budgetLeft() <= 0) {
      confirmed.push(finding); // budget exhausted — keep unverified findings rather than silently drop (fail-safe)
      continue;
    }
    calls += 1;
    try {
      const response = recordResponse(await askModel(verifyPrompt(finding, context), { persona: finding.persona, phase: "verify" }));
      const parsed = extractJson(response.text) as { confirmed?: unknown } | null;
      if (parsed && parsed.confirmed === false) {
        refutedCount += 1;
      } else {
        confirmed.push(finding); // default-KEEP when the refutation is not explicit (fail-safe on a security gate)
      }
    } catch {
      confirmed.push(finding);
    }
  }

  // --- SYNTHESIZE (code, not model discretion) ---
  const redSet = new Set(panel.redSeverities);
  const verdict: ReviewGateVerdict = confirmed.some((finding) => redSet.has(finding.severity))
    ? "RED"
    : confirmed.length > 0
      ? "YELLOW"
      : "GREEN";

  const reviewers = personas.slice(0, findResults.length);
  const summary =
    verdict === "GREEN"
      ? `native-critic-panel GREEN — ${reviewers.length} lenses, no confirmed defects (${refutedCount} refuted).`
      : `native-critic-panel ${verdict} — ${confirmed.length} confirmed finding(s) across ${reviewers.length} lenses (${refutedCount} refuted).`;

  return {
    verdict,
    findings: confirmed,
    reviewers,
    refutedCount,
    summary,
    ...(observedUsage ? { usage: { input: inputTokens, output: outputTokens } } : {})
  };
}

/** Wrap the panel as a NativeReviewer (gate → CommandGateResult) for runReviewGates. */
export function makeNativeReviewer(deps: {
  readonly askModel: AskModel;
  readonly panel: CriticPanelConfig;
  readonly getReviewContext: (cwd?: string) => Promise<NativeReviewContext>;
}): NativeReviewer {
  return async (gate: CommandGate, cwd?: string): Promise<CommandGateResult> => {
    const startedAt = Date.now();
    const context = await deps.getReviewContext(cwd);
    const review = await runNativeCriticPanel(context, { askModel: deps.askModel, panel: deps.panel });
    const findingsText = review.findings.map((f) => `  [${f.severity}] (${f.persona}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`).join("\n");
    return {
      ...gate,
      exitCode: review.verdict === "RED" ? 1 : 0,
      stdout: `${review.summary}${findingsText ? `\n${findingsText}` : ""}`,
      stderr: "",
      durationMs: Date.now() - startedAt,
      status: review.verdict === "RED" ? "failed" : "passed",
      verdict: review.verdict,
      summary: review.summary,
      ...(review.usage ? { tokens: review.usage.input + review.usage.output } : {})
    };
  };
}
