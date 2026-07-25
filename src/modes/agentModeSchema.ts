import { z } from 'zod';

export const agentModeSchema = z.object({
  name: z.string(),
  description: z.string(),
  allowedToolClasses: z.array(z.string()),
});

export type AgentMode = z.infer<typeof agentModeSchema>;

export const builtInModes: AgentMode[] = [
  {
    name: 'ask',
    description: 'For answering questions. Allows read-only tools, search. Forbids file writing and destructive shell commands.',
    allowedToolClasses: ['read-only', 'search'],
  },
  {
    name: 'plan',
    description: 'For creating and reviewing plans. Allows file reading/writing for plan files, but denies shell commands with side-effects.',
    allowedToolClasses: ['read-only', 'file-write-plan'],
  },
  {
    name: 'code',
    description: 'For writing and modifying code. Allows file system read/write and execution of build/test commands, respecting the global YOLO policy.',
    allowedToolClasses: ['read-only', 'file-write', 'shell-build', 'shell-test'],
  },
  {
    name: 'debug',
    description: 'For debugging code. Allows read-only access, plus execution of debuggers and test runners.',
    allowedToolClasses: ['read-only', 'shell-debug', 'shell-test'],
  },
  {
    name: 'review',
    description: 'For reviewing code. Strictly read-only access.',
    allowedToolClasses: ['read-only'],
  },
  {
    name: 'orchestrate',
    description: 'For high-level task management. Allows process control tools and file system reads, but limited writes.',
    allowedToolClasses: ['read-only', 'process-control', 'file-write-limited'],
  },
];
