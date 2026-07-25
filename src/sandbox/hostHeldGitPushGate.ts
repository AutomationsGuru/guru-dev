export interface PushOptions {
  readonly token?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Gate that prevents unauthorized git pushes from the sandbox.
 * The sandbox itself holds no secrets. A push is only allowed if the host
 * explicitly approves it (e.g., via a specific env var or token provided during the push attempt).
 */
export function mayPush(opts?: PushOptions): boolean {
  const env = opts?.env ?? process.env;

  // Host must explicitly set this to approve a push from the sandbox.
  if (env.GURU_HOST_PUSH_APPROVED === "1") {
    return true;
  }

  // Alternative: explicitly passed token for the operation
  if (opts?.token && opts.token.length > 0) {
    return true; // We don't validate the token here, just that one was provided by the host
  }

  return false;
}
