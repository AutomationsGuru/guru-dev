/**
 * IDEA-F506: Eval Dataset Synthesize Stub
 *
 * Deterministic synthesizer for high-quality evaluation datasets.
 * Focused on GuruHarness agentic workflow coverage.
 *
 * This is a stub implementation per F506 build plan Phase 1-2:
 * - Defines contracts (EvalCase, EvalDataset, SynthesizeOptions)
 * - Provides deterministic synthetic generation (no LLM yet)
 * - LLM path stubbed (throws if llmClient provided)
 *
 * Future phases will integrate real LLM-assisted synthesis via injected client.
 */

export interface EvalCase {
  id: string;
  category: string;
  prompt: string;
  expectedOutcome: string;
  complexity: number; // 1-5
  tags: string[];
  sourceFile?: string;
  sourceSnippet?: string;
}

export interface EvalDataset {
  id: string;
  version: string;
  generatedAt: string;
  totalCases: number;
  cases: EvalCase[];
  metadata: {
    categories: string[];
    byCategory: Record<string, number>;
    avgComplexity: number;
    seed: number | string;
    sourceCodebase: string;
  };
}

export interface SynthesizeOptions {
  maxCases?: number;
  categories?: string[];
  seed?: number | string;
  llmClient?: unknown; // stubbed for now; real type in src/llm/*
  includeSourceSnippets?: boolean;
}

/** Fixed category set per plan */
const DEFAULT_CATEGORIES = [
  'code-generation',
  'debugging',
  'refactoring',
  'testing',
  'documentation',
  'architecture',
  'security',
  'performance',
] as const;

type Category = (typeof DEFAULT_CATEGORIES)[number];

/** Simple seeded PRNG (mulberry32 variant) for determinism */
function createSeededRng(seed: number | string): () => number {
  let s = typeof seed === 'string'
    ? seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
    : seed;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Prompt templates per category (high-quality, GuruHarness-relevant) */
const PROMPT_TEMPLATES: Record<Category, string[]> = {
  'code-generation': [
    'Implement a new {feature} utility that handles {edge} gracefully.',
    'Write a function to {action} for {domain} with proper error handling.',
    'Create a class for managing {resource} lifecycle in an agent session.',
  ],
  'debugging': [
    'Diagnose why {symptom} occurs in {module} under {condition}.',
    'Find the root cause of flaky test in {area} when {trigger}.',
    'Explain the failure mode when {input} leads to {badOutput}.',
  ],
  'refactoring': [
    'Refactor {module} to eliminate duplication while preserving behavior.',
    'Extract {concern} into a reusable helper with full test coverage.',
    'Simplify the {complexity} logic in {file} without changing semantics.',
  ],
  'testing': [
    'Add unit tests for {function} covering nominal, edge, and error paths.',
    'Write an integration test that exercises {flow} end-to-end.',
    'Create a property-based test for {invariant} in {component}.',
  ],
  'documentation': [
    'Write clear JSDoc for {api} including examples and constraints.',
    'Document the decision record for choosing {approach} over {alternative}.',
    'Update the README section on {topic} with usage patterns and gotchas.',
  ],
  'architecture': [
    'Design the interface for a new {component} that integrates with {system}.',
    'Propose a clean separation of concerns for {concern} in the agent loop.',
    'Sketch the data flow for {feature} across CLI, session, and executor.',
  ],
  'security': [
    'Audit {module} for {vulnerability} risks and propose mitigations.',
    'Implement input sanitization for {inputType} in command parsing.',
    'Review the auth flow for timing or injection issues.',
  ],
  'performance': [
    'Optimize the hot path in {operation} for large {scale} inputs.',
    'Profile and reduce allocations in the {loop} during repeated {action}.',
    'Add caching to {expensive} without breaking cache-invalidation contracts.',
  ],
};

/** Expected outcome templates */
const OUTCOME_TEMPLATES: Record<Category, string[]> = {
  'code-generation': [
    'Function compiles, passes all tests, handles {edge} without crash.',
    'Implementation is pure, typed, and documented with 100% coverage.',
    'New utility integrates cleanly and follows existing patterns.',
  ],
  'debugging': [
    'Root cause identified; fix is minimal and localized.',
    'Flaky test stabilized with deterministic setup/teardown.',
    'Clear explanation + reproduction steps provided.',
  ],
  'refactoring': [
    'Behavior preserved (all tests green); duplication reduced by >30%.',
    'New helper is single-responsibility and fully tested.',
    'Complexity score lowered while readability improved.',
  ],
  'testing': [
    'Test suite covers 100% of branches and error cases.',
    'Integration test passes in CI and catches regressions.',
    'Property test proves invariant holds for 1000 generated inputs.',
  ],
  'documentation': [
    'Docs are accurate, concise, and include runnable examples.',
    'ADR captures trade-offs and rationale for future readers.',
    'README update improves onboarding time for new contributors.',
  ],
  'architecture': [
    'Interface is minimal, stable, and allows future extension.',
    'Separation makes testing and mocking straightforward.',
    'Data flow diagram matches implemented reality.',
  ],
  'security': [
    'No high-severity findings remain after mitigations.',
    'Sanitization prevents all known injection vectors.',
    'Auth review passes external security audit.',
  ],
  'performance': [
    'Latency reduced by 40% at p99 under load.',
    'Memory usage stable across 10k iterations (no leaks).',
    'Cache hit rate >90% with correct invalidation.',
  ],
};

/** Tag pools */
const TAG_POOLS: Record<Category, string[]> = {
  'code-generation': ['new-feature', 'utility', 'error-handling'],
  'debugging': ['diagnosis', 'root-cause', 'flaky-test'],
  'refactoring': ['clean-code', 'duplication', 'simplification'],
  'testing': ['coverage', 'edge-cases', 'property-based'],
  'documentation': ['jsdoc', 'adr', 'readme'],
  'architecture': ['interface-design', 'separation', 'data-flow'],
  'security': ['audit', 'sanitization', 'auth'],
  'performance': ['optimization', 'profiling', 'caching'],
};

/** Generate a single high-quality case */
function generateCase(
  rng: () => number,
  category: Category,
  index: number,
  includeSnippet: boolean
): EvalCase {
  const prompts = PROMPT_TEMPLATES[category];
  const outcomes = OUTCOME_TEMPLATES[category];
  const tags = TAG_POOLS[category];

  const promptIdx = Math.floor(rng() * prompts.length);
  const outcomeIdx = Math.floor(rng() * outcomes.length);

  const complexity = 1 + Math.floor(rng() * 5); // 1-5

  // Simple source file hint (synthetic, not real)
  const sourceFile = includeSnippet
    ? `src/${category.split('-')[0]}/${category}Helper.ts`
    : undefined;

  const sourceSnippet = includeSnippet
    ? `// synthetic snippet for case ${index}\nfunction example() { /* ... */ }`
    : undefined;

  return {
    id: `case-${category}-${index.toString().padStart(3, '0')}`,
    category,
    prompt: prompts[promptIdx]
      .replace('{feature}', 'agent session manager')
      .replace('{edge}', 'offline provider')
      .replace('{action}', 'switch models at runtime')
      .replace('{domain}', 'multi-provider routing')
      .replace('{resource}', 'worktree lifecycle')
      .replace('{symptom}', 'intermittent timeout')
      .replace('{module}', 'session executor')
      .replace('{condition}', 'concurrent commands')
      .replace('{input}', 'malformed mandate')
      .replace('{badOutput}', 'unhandled rejection')
      .replace('{concern}', 'approval ledger persistence')
      .replace('{file}', 'mandateCommandExecutor.ts')
      .replace('{complexity}', 'nested conditional')
      .replace('{function}', 'deriveSetupHint')
      .replace('{flow}', 'full review → synthesize → apply')
      .replace('{invariant}', 'idempotent apply')
      .replace('{component}', 'eval dataset builder')
      .replace('{api}', 'synthesizeEvalDataset')
      .replace('{topic}', 'evaluation harness')
      .replace('{approach}', 'stub-first')
      .replace('{alternative}', 'live LLM')
      .replace('{component}', 'monitor tool')
      .replace('{system}', 'GuruHarness core')
      .replace('{feature}', 'dataset synthesis')
      .replace('{vulnerability}', 'command injection')
      .replace('{inputType}', 'user-provided prompt')
      .replace('{operation}', 'diff application')
      .replace('{scale}', '10k-line')
      .replace('{loop}', 'agent loop')
      .replace('{action}', 'context compaction')
      .replace('{expensive}', 'model list refresh'),
    expectedOutcome: outcomes[outcomeIdx]
      .replace('{edge}', 'offline')
      .replace('{scale}', 'large'),
    complexity,
    tags: [...tags, `complexity-${complexity}`],
    sourceFile,
    sourceSnippet,
  };
}

/**
 * Synthesize a high-quality evaluation dataset.
 *
 * Deterministic when seed is provided.
 * LLM path is stubbed (throws) per plan.
 */
export async function synthesizeEvalDataset(
  codebasePath: string,
  options: SynthesizeOptions = {}
): Promise<EvalDataset> {
  const {
    maxCases = 24,
    categories = [...DEFAULT_CATEGORIES],
    seed = 42,
    llmClient,
    includeSourceSnippets = false,
  } = options;

  if (llmClient) {
    // Per plan: stub LLM path for now
    throw new Error(
      'LLM-assisted synthesis not yet implemented in stub. Provide no llmClient or implement in later phase.'
    );
  }

  const rng = createSeededRng(seed);
  const selectedCategories = categories.filter((c): c is Category =>
    (DEFAULT_CATEGORIES as readonly string[]).includes(c)
  );

  if (selectedCategories.length === 0) {
    throw new Error('No valid categories selected');
  }

  const cases: EvalCase[] = [];
  let caseIndex = 0;

  // Round-robin across categories until we hit maxCases or reasonable coverage
  while (cases.length < maxCases) {
    for (const cat of selectedCategories) {
      if (cases.length >= maxCases) break;
      const evCase = generateCase(rng, cat, caseIndex++, includeSourceSnippets);
      cases.push(evCase);
    }
  }

  // Compute metadata
  const byCategory: Record<string, number> = {};
  let totalComplexity = 0;

  for (const c of cases) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    totalComplexity += c.complexity;
  }

  const avgComplexity = totalComplexity / cases.length;

  const dataset: EvalDataset = {
    id: `eval-dataset-${Date.now()}`,
    version: '1.0.0-stub',
    generatedAt: new Date().toISOString(),
    totalCases: cases.length,
    cases,
    metadata: {
      categories: selectedCategories,
      byCategory,
      avgComplexity: Number(avgComplexity.toFixed(2)),
      seed,
      sourceCodebase: codebasePath,
    },
  };

  return dataset;
}
