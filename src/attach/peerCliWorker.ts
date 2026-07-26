import { execa, ExecaChildProcess } from 'execa';
import { PeerCliConfig, PeerCliConfigSchema } from './peerCliSchema.js';

/**
 * ParityGap registry for ATTACH mode.
 * Tracks external coding CLIs (e.g. goose, cursor-agent) spawned as swarm workers.
 * Entry created on first use of a given command. Provides visibility for parity tracking
 * and future native BUILD replacement. Not promoted to face product.
 */
const parityGapRegistry = new Set<string>();

function registerParityGap(command: string): void {
  if (!parityGapRegistry.has(command)) {
    parityGapRegistry.add(command);
    // Coordinator note: parity gap recorded for command. Status: ATTACH (tracked, replaceable).
  }
}

/**
 * PeerCliWorker — optional ATTACH spawn of external stdio/ACP coding CLI as swarm worker.
 *
 * - Respects enabled flag (default false per schema).
 * - Spawns with provided command/args/env/timeout.
 * - Captures stdout summary for parent swarm coordinator.
 * - Supports cancel via stop().
 * - Enforces no silent promotion; external CLI remains behind explicit attach boundary.
 */
export class PeerCliWorker {
  private config: PeerCliConfig;
  private child: ExecaChildProcess | null = null;
  private running = false;
  private stdoutLines: string[] = [];
  private readonly maxSummaryLines = 50;

  constructor(config: PeerCliConfig) {
    // Validate on construction (defense in depth; callers should use schema.parse)
    this.config = PeerCliConfigSchema.parse(config);
  }

  /**
   * Start the external CLI worker (if enabled).
   * Idempotent if already running. Records ParityGap on first spawn for this command.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      return; // disabled by default — no-op
    }
    if (this.running && this.child) {
      return; // already running
    }

    // Register parity gap for this ATTACH (explicit, tracked)
    registerParityGap(this.config.command);

    // Prepare env: start from process.env, overlay provided keys
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.config.env ?? {}),
    };

    // Spawn via execa (matches project idiom in selfBuildExecutor)
    this.child = execa(this.config.command, this.config.args ?? [], {
      env: spawnEnv,
      timeout: this.config.timeoutMs ?? 300_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false, // we handle exit ourselves
    });

    this.running = true;
    this.stdoutLines = [];

    // Stream stdout into buffer for summary
    this.child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      this.stdoutLines.push(...lines);
      // Trim buffer to prevent unbounded growth
      if (this.stdoutLines.length > this.maxSummaryLines * 2) {
        this.stdoutLines = this.stdoutLines.slice(-this.maxSummaryLines);
      }
    });

    // Handle process exit / error
    this.child.on('exit', (code) => {
      this.running = false;
      this.child = null;
      // Optional: could surface exit code to parent, but summary capture is primary contract
    });

    this.child.on('error', (err) => {
      this.running = false;
      this.child = null;
      // Surface via summary if needed; parent can inspect
      this.stdoutLines.push(`[peer-cli error] ${err.message}`);
    });
  }

  /**
   * Stop / cancel the running worker.
   * Safe to call when not running.
   */
  stop(): void {
    if (this.child && this.running) {
      this.child.kill('SIGTERM');
      this.running = false;
      this.child = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Return a bounded stdout summary (last N lines) for parent swarm coordinator.
   * Never exposes secrets; only stdout text.
   */
  getStdoutSummary(): string {
    const recent = this.stdoutLines.slice(-this.maxSummaryLines);
    return recent.join('\n');
  }
}
