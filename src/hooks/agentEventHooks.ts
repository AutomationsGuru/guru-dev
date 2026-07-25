import {
  type HookEvent,
  type AgentEventHook,
  type HookAction,
  HookEventSchema,
  AgentEventHookSchema
} from "./agentEventHooksSchema.js";

// List of hard-limit tools that can never be auto-skipped by hooks
export const HARD_LIMIT_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "exactEdit",
  "shellExec",
  "gitPrAutomation",
  "githubPr",
  "manageTask",
  "desktop",
  "maintenanceAudit",
  "reviewGates"
]);

/**
 * Check if a tool is a hard-limit tool.
 * Hard-limit tools can never be auto-skipped by hooks.
 */
export function isHardLimitTool(toolId: string): boolean {
  return HARD_LIMIT_TOOLS.has(toolId);
}

/**
 * Replace placeholders like {{path}}, {{prompt}}, etc. in a template string.
 */
export function replacePlaceholders(template: string, event: HookEvent): string {
  let result = template;
  if (event.path !== undefined) {
    result = result.replace(/\{\{path\}\}/g, event.path);
  }
  if (event.prompt !== undefined) {
    result = result.replace(/\{\{prompt\}\}/g, event.prompt);
  }
  if (event.tool !== undefined) {
    result = result.replace(/\{\{tool\}\}/g, event.tool);
  }
  if (event.taskId !== undefined) {
    result = result.replace(/\{\{taskId\}\}/g, event.taskId);
  }
  if (event.subject !== undefined) {
    result = result.replace(/\{\{subject\}\}/g, event.subject);
  }
  return result;
}

/**
 * Find matching hooks for an event.
 */
export function matchHooks(hooks: readonly AgentEventHook[], event: HookEvent): AgentEventHook[] {
  // Validate the event structure
  const parsedEvent = HookEventSchema.parse(event);

  return hooks.filter((hook) => {
    // Disabled hooks no-op
    if (!hook.enabled) {
      return false;
    }

    // Check event type match
    if (hook.when !== parsedEvent.type) {
      return false;
    }

    // Check pattern match if present
    if (hook.pattern) {
      let textToMatch = "";
      switch (parsedEvent.type) {
        case "fileSaved":
          textToMatch = parsedEvent.path ?? "";
          break;
        case "promptSubmit":
          textToMatch = parsedEvent.prompt ?? "";
          break;
        case "preTool":
        case "postTool":
          textToMatch = parsedEvent.tool ?? "";
          break;
        case "taskStart":
          textToMatch = parsedEvent.subject ?? "";
          break;
      }

      try {
        const regex = new RegExp(hook.pattern);
        return regex.test(textToMatch);
      } catch {
        // Fallback to simple includes
        return textToMatch.includes(hook.pattern);
      }
    }

    return true;
  });
}

/**
 * Run matching handlers and return list of resolved actions.
 */
export function runHandlers(hooks: readonly AgentEventHook[], event: HookEvent): HookAction[] {
  const matched = matchHooks(hooks, event);

  const actions: HookAction[] = [];

  for (const hook of matched) {
    const action: HookAction = { ...hook.then };

    // Resolve placeholders in shell commands
    if (action.shell) {
      action.shell = {
        ...action.shell,
        command: replacePlaceholders(action.shell.command, event)
      };
    }

    // Resolve placeholders in askAgent prompts
    if (action.askAgent) {
      action.askAgent = {
        ...action.askAgent,
        prompt: replacePlaceholders(action.askAgent.prompt, event)
      };
    }

    // Apply "hard-limit tools never auto-skipped by hooks" rule:
    // If the event is preTool and the tool is a hard-limit tool,
    // we must ignore any "skip" request.
    if (event.type === "preTool" && event.tool && isHardLimitTool(event.tool)) {
      if (action.skip) {
        // Ignore the skip instruction
        const { skip: _, ...rest } = action;
        if (Object.keys(rest).length === 0) {
          // If skip was the only instruction, don't return an empty action
          continue;
        }
        actions.push(rest as HookAction);
        continue;
      }
    }

    actions.push(action);
  }

  return actions;
}

export class AgentEventHooksRegistry {
  private hooks: AgentEventHook[] = [];

  constructor(hooks: readonly AgentEventHook[] = []) {
    this.hooks = [...hooks];
  }

  public register(hook: AgentEventHook): void {
    const parsed = AgentEventHookSchema.parse(hook);
    this.hooks.push(parsed);
  }

  public getHooks(): readonly AgentEventHook[] {
    return this.hooks;
  }

  public clear(): void {
    this.hooks = [];
  }

  public match(event: HookEvent): AgentEventHook[] {
    return matchHooks(this.hooks, event);
  }

  public runHandlers(event: HookEvent): HookAction[] {
    return runHandlers(this.hooks, event);
  }
}
