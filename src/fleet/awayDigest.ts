import {
  AwayDigestOptions,
  AwayDigestSchema,
  WorkerStatus
} from "./awayDigestSchema.js";

const PATH_LIKE = /(\/|\\\\)[a-zA-Z0-9_.\-]+/g;

function redact(value: string, enabled: boolean): string {
  if (!enabled) return value;
  return value.replace(PATH_LIKE, "[path]");
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function truncateList(
  workers: WorkerStatus[],
  maxBytes: number,
  redactPaths: boolean,
  lineOverhead: number,
  render: (w: WorkerStatus) => string
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let used = lineOverhead;
  let truncated = false;
  for (const worker of workers) {
    const line = render(worker);
    const lineBytes = Buffer.byteLength(line, "utf8");
    const withNewline = lineBytes + 1;
    if (used + withNewline > maxBytes) {
      truncated = true;
      break;
    }
    used += withNewline;
    lines.push(line);
  }
  return { lines, truncated };
}

export function buildAwayDigest(
  workers: WorkerStatus[],
  options: AwayDigestOptions = {}
): {
  markdown: string;
  json: string;
} {
  const { maxBytes = 4096, redactPaths = false, topFailureCount = 5 } = options;

  const counts = {
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    killed: 0
  };
  for (const worker of workers) {
    counts[worker.state]++;
  }

  const failedWorkers = workers.filter((w) => w.state === "failed");
  const topFailures = failedWorkers
    .slice(0, topFailureCount)
    .map((worker) => ({
      workerId: worker.id,
      name: worker.name,
      failure: redact(worker.failure ?? "(no failure detail)", redactPaths)
    }));

  const header = [
    "# Away digest",
    "",
    `- Total: ${workers.length}`,
    `- Running: ${counts.running}`,
    `- Done: ${counts.done}`,
    `- Failed: ${counts.failed}`,
    `- Blocked: ${counts.blocked}`,
    `- Killed: ${counts.killed}`,
    "",
    "## Top failures",
    ""
  ];
  const headerBytes = Buffer.byteLength(header.join("\n") + "\n", "utf8");
  const footer = "\n";
  const footerBytes = Buffer.byteLength(footer, "utf8");
  const availableForFailures = Math.max(0, maxBytes - headerBytes - footerBytes);

  const { lines: renderedFailures, truncated } = truncateList(
    failedWorkers,
    availableForFailures,
    redactPaths,
    0,
    (worker) => {
      const detail = redact(worker.failure ?? "(no failure detail)", redactPaths);
      return `- ${escapeMarkdown(worker.name)} (${worker.id}): ${escapeMarkdown(detail)}`;
    }
  );

  const markdown = header.join("\n") + renderedFailures.join("\n") + footer;

  const digest = AwayDigestSchema.parse({
    generatedAt: new Date().toISOString(),
    total: workers.length,
    counts,
    topFailures,
    markdown,
    truncated
  });

  return {
    markdown: digest.markdown,
    json: JSON.stringify(digest, null, 2)
  };
}

export { AwayDigestOptions, AwayDigestSchema, WorkerStatus };
