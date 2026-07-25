import { AgentMode, builtInModes } from './agentModeSchema.js';

// Assume a ToolDefinition type is available globally or from another module
// For this file, we'll define a simple version.
export interface ToolDefinition {
  name: string;
  class: string;
}

// Assume the hard limit checking system exists and can be imported.
// We will mock this for tests, but for implementation, we assume it's real.
// It returns true if the tool passes hard limits, false otherwise.
const checkHardLimits = (tool: ToolDefinition): boolean => {
  // In a real implementation, this would call the actual hard limit enforcement system.
  // For now, we'll placeholder it. It will be mocked in tests.
  // Example checks (these are conceptual):
  // if (violatesPreservation(tool)) return false;
  // if (violatesSpend(tool)) return false;
  // if (violatesSecrecy(tool)) return false;
  // if (violatesScope(tool)) return false;
  // if (violatesSelfImprovement(tool)) return false;
  return true;
};


const initialMode = builtInModes.find(m => m.name === 'ask');
if (!initialMode) {
  throw new Error("The default 'ask' mode could not be found.");
}
let currentMode: AgentMode = initialMode;

const modes: Map<string, AgentMode> = new Map(builtInModes.map(m => [m.name, m]));

export function setMode(modeName: string): void {
  const newMode = modes.get(modeName);
  if (!newMode) {
    throw new Error(`Mode '${modeName}' not found.`);
  }
  currentMode = newMode;
}

export function getMode(): AgentMode {
  return currentMode;
}

export function gate(tool: ToolDefinition): boolean {
  // 1. Check against constitutional hard limits first. These are non-negotiable.
  if (!checkHardLimits(tool)) {
    return false;
  }

  // 2. Check against the current mode's allowed tool classes.
  return currentMode.allowedToolClasses.includes(tool.class);
}
