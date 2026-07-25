import {
  ModelArenaInputSchema,
  type ModelArenaInput,
  type ModelArenaPlan
} from "./modelArenaSchema.js";

export interface ArenaResult {
  plan?: ModelArenaPlan;
  results?: Array<{ route: string; status: string; receipt?: unknown }>;
}

export function runArena(
  input: unknown,
  opts: { dryRun?: boolean } = {}
): ArenaResult {
  const parsed = ModelArenaInputSchema.parse(input);

  if (opts.dryRun) {
    return {
      plan: {
        task: parsed.task,
        routes: parsed.routes,
        checks: parsed.checks,
        dryRun: true
      }
    };
  }

  // execute path: stub worker results for tests
  const results = parsed.routes.map((route) => ({
    route: route.alias,
    status: "stubbed",
    receipt: { checks: parsed.checks.length }
  }));

  return { results };
}
