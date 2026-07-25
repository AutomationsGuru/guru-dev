export type ReadinessVerdict = 'ready' | 'warning' | 'blocked';

export interface SectionStatus {
  verdict: ReadinessVerdict;
  messages: string[];
}

export interface DryRunReport {
  verdict: ReadinessVerdict;
  sections: {
    auth: SectionStatus;
    tools: SectionStatus;
    skills: SectionStatus;
    mcp: SectionStatus;
    settings: SectionStatus;
  };
  nextActions: string[];
}

export interface DryRunInput {
  auth?: {
    providers: Record<string, boolean>; // e.g. { anthropic: true, openai: false }
    defaultProvider?: string;
  };
  mcp?: {
    servers: Record<string, any>; // basic check for servers key presence
  };
  settings?: {
    memoryPath?: string;
  };
}

export function buildDryRunReport(input: DryRunInput = {}): DryRunReport {
  const report: DryRunReport = {
    verdict: 'ready',
    sections: {
      auth: { verdict: 'ready', messages: [] },
      tools: { verdict: 'ready', messages: [] },
      skills: { verdict: 'ready', messages: [] },
      mcp: { verdict: 'ready', messages: [] },
      settings: { verdict: 'ready', messages: [] },
    },
    nextActions: [],
  };

  // Auth Section
  if (!input.auth || !input.auth.providers || Object.keys(input.auth.providers).length === 0) {
    report.sections.auth.verdict = 'blocked';
    report.sections.auth.messages.push('No authentication providers configured.');
    report.nextActions.push('Configure at least one API provider (e.g., Anthropic, OpenAI).');
  } else {
    const hasActiveProvider = Object.values(input.auth.providers).some((isActive) => isActive);
    if (!hasActiveProvider) {
      report.sections.auth.verdict = 'blocked';
      report.sections.auth.messages.push('No active authentication providers found.');
      report.nextActions.push('Activate at least one API provider.');
    }
  }

  // MCP Section
  if (input.mcp && input.mcp.servers) {
    if (Object.keys(input.mcp.servers).length === 0) {
       // Just a warning, not blocked if empty
       report.sections.mcp.verdict = 'warning';
       report.sections.mcp.messages.push('MCP config found but no servers defined.');
    }
  }

  // Aggregate Verdicts
  const verdicts = [
    report.sections.auth.verdict,
    report.sections.tools.verdict,
    report.sections.skills.verdict,
    report.sections.mcp.verdict,
    report.sections.settings.verdict,
  ];

  if (verdicts.includes('blocked')) {
    report.verdict = 'blocked';
  } else if (verdicts.includes('warning')) {
    report.verdict = 'warning';
  }

  return report;
}
