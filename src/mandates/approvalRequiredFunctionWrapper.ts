import type { ToolDefinition, ToolEffect, ToolExecutionContext } from "../tools/registry.js";

/**
 * Approval-required function wrapper (IDEA-F246-APPROVAL-WRAP-01).
 *
 * Residual from the Microsoft Agent Framework review (K12
 * `ApprovalRequiredAIFunction`): the ability to wrap a tool definition so its
 * invoke path ALWAYS emits an approval request BEFORE any side effect can run.
 *
 * The wrapper does not import a sibling HITL/approval-modes module (those are
 * separate lanes — F221/F242 — and may not have landed yet); instead it carries
 * an injected approval surface. The contract — "no side effect without an
 * explicit approval" — is enforced as a structural code path
 * (Constitution §3.2: no unapproved side effects), never as prose a model could
 * skip. Composes conceptually with F242 tool approval modes and F221 HITL
 * decisions; a future caller can wire those into `request`.
 */

/**
 * The request emitted on the first invoke of a wrapped tool. It carries the
 * tool id, the parsed input, and the declared effect so an operator surface can
 * render a meaningful prompt. The input is forwarded verbatim — secret-value
 * hygiene is owned by the tool body and the output sanitizer, not this wrapper.
 */
export interface WrappedApprovalRequest {
  readonly toolId: string;
  readonly input: unknown;
  readonly effect: ToolEffect | undefined;
}

/**
 * A decision attached to a `tryInvoke` that has already emitted a
 * `needsApproval`. Only `approved: true` proceeds; anything else is treated as
 * a denial (fail-closed, §3.2).
 */
export interface ApprovalDecision {
  readonly approved: boolean;
  /** Optional execution context forwarded to the wrapped tool body. */
  readonly context?: ToolExecutionContext;
}

/** Outcome of attempting an invoke. See {@link ApprovalRequiredFunction.tryInvoke}. */
export type ApprovalRequiredOutcome<TOutput> =
  | { readonly kind: "needsApproval"; readonly request: WrappedApprovalRequest }
  | { readonly kind: "denied"; readonly request: WrappedApprovalRequest }
  | { readonly kind: "result"; readonly output: TOutput }
  | { readonly kind: "failed"; readonly error: string };

/**
 * The injected approval surface. Receives the approval request and resolves to
 * a strict `true`/`false`. A truthy-but-not-`true` value is NOT an approval —
 * this keeps the gate fail-closed against a buggy prompt implementation.
 */
export type ApprovalSurface = (request: WrappedApprovalRequest) => Promise<boolean> | boolean;

export interface ApprovalRequiredWrapperOptions {
  readonly request: ApprovalSurface;
}

/**
 * Descriptive metadata mirrored from the wrapped tool so a registry can still
 * describe it. `effect` is optional exactly as on {@link ToolDefinition}.
 */
export interface ApprovalRequiredFunctionMetadata {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly effect?: ToolEffect;
}

/**
 * A tool definition wrapped so the invoke path always emits approval first.
 * Exposes the wrapped tool's descriptive metadata plus the gated `tryInvoke`.
 */
export interface ApprovalRequiredFunction<TTool extends ToolDefinition = ToolDefinition>
  extends ApprovalRequiredFunctionMetadata {
  /**
   * Attempt to invoke the wrapped tool. With no `decision`, returns
   * `needsApproval` WITHOUT running the tool body. With a decision, the
   * approval surface is consulted; only strict `true` runs the tool. A thrown
   * tool body surfaces as `failed`; a denied approval surfaces as `denied`.
   */
  tryInvoke(
    input: Parameters<TTool["execute"]>[0],
    decision?: ApprovalDecision
  ): Promise<ApprovalRequiredOutcome<Awaited<ReturnType<TTool["execute"]>>>>;
}

/**
 * Wrap a tool definition so its invoke path ALWAYS emits an approval request
 * before any side effect. The wrapped tool body never executes until an explicit
 * `approved: true` decision is supplied AND the injected approval surface
 * returns strict `true`.
 */
export function wrapApprovalRequired<TTool extends ToolDefinition>(
  tool: TTool,
  options: ApprovalRequiredWrapperOptions
): ApprovalRequiredFunction<TTool> {
  const approvalSurface = options.request;
  // exactOptionalPropertyTypes: do not set `effect` to an explicit `undefined`.
  const meta: ApprovalRequiredFunctionMetadata =
    tool.effect === undefined
      ? { id: tool.id, title: tool.title, description: tool.description }
      : { id: tool.id, title: tool.title, description: tool.description, effect: tool.effect };

  return {
    ...meta,
    async tryInvoke(
      input: Parameters<TTool["execute"]>[0],
      decision?: ApprovalDecision
    ): Promise<ApprovalRequiredOutcome<Awaited<ReturnType<TTool["execute"]>>>> {
      const approvalRequest: WrappedApprovalRequest = {
        toolId: tool.id,
        input,
        effect: tool.effect
      };

      // First door: no decision supplied yet → always emit approval, never run.
      if (!decision) {
        return { kind: "needsApproval", request: approvalRequest };
      }

      // Second door: an approval surface must return strict `true`. A missing or
      // truthy-but-not-true answer is a denial (fail-closed, §3.2).
      let granted = false;
      try {
        granted = (await approvalSurface(approvalRequest)) === true;
      } catch {
        granted = false;
      }

      if (!granted) {
        return { kind: "denied", request: approvalRequest };
      }

      try {
        const output = (await tool.execute(input, decision.context ?? {})) as Awaited<
          ReturnType<TTool["execute"]>
        >;
        return { kind: "result", output };
      } catch (error) {
        return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}
