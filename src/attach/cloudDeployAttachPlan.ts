export interface CloudDeployOpts {
  provider?: string;
  region?: string;
  secretsRef?: string[];
}

export interface CloudDeployPlan {
  provider: string;
  region?: string;
  secretsRef: string[];
}

export function buildPlan(opts: CloudDeployOpts): CloudDeployPlan {
  if (!opts.provider) {
    throw new Error("Missing required field: provider");
  }

  const plan: CloudDeployPlan = {
    provider: opts.provider,
    secretsRef: opts.secretsRef ?? [],
  };

  if (opts.region !== undefined) {
    plan.region = opts.region;
  }

  return plan;
}
