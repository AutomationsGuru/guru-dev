import { loadConfig, type Config } from '../config';
import { getLhtService } from './service';

export interface LHTStatus {
  elapsedMs: number;
  spendUsd: number;
  netSpendDelta: number;
  gates: {
    passed: number;
    pending: number;
    total: number;
  };
  status: 'healthy' | 'stall' | 'complete' | 'no-session';
  thresholds: {
    stallAfterMs: number;
    completeConfidenceThreshold: number;
  };
  profile: {
    minTimeMs: number;
    maxTimeMs: number;
    minSpend: number;
    maxSpend: number;
  };
  currentSessionId?: string;
}

export class LongHorizonTracker {
  /**
   * Get current LHT status for programmatic consumption.
   * Returns structured status including elapsed time, spend, gates, and health indicators.
   */
  static getLHTStatus(config?: Config): LHTStatus | null {
    const cfg = config ?? loadConfig();
    const lhtEnabled = cfg.lht?.enabled ?? false;

    if (!lhtEnabled) {
      return null;
    }

    const lhtService = getLhtService();
    const state = lhtService.getState();

    // No active session
    if (!lhtService.isActive() || !state.currentSessionId) {
      return {
        elapsedMs: 0,
        spendUsd: 0,
        netSpendDelta: 0,
        gates: { passed: 0, pending: 0, total: 0 },
        status: 'no-session',
        thresholds: {
          stallAfterMs: state.thresholds.stallAfterMs,
          completeConfidenceThreshold: state.thresholds.completeConfidenceThreshold,
        },
        profile: {
          minTimeMs: state.profile.minTimeMs,
          maxTimeMs: state.profile.maxTimeMs,
          minSpend: state.profile.minSpend,
          maxSpend: state.profile.maxSpend,
        },
      };
    }

    return {
      elapsedMs: state.elapsedMs,
      spendUsd: state.spendUsd,
      netSpendDelta: state.netSpendDelta,
      gates: {
        passed: state.gates.passed,
        pending: state.gates.pending,
        total: state.gates.total,
      },
      status: state.status,
      thresholds: {
        stallAfterMs: state.thresholds.stallAfterMs,
        completeConfidenceThreshold: state.thresholds.completeConfidenceThreshold,
      },
      profile: {
        minTimeMs: state.profile.minTimeMs,
        maxTimeMs: state.profile.maxTimeMs,
        minSpend: state.profile.minSpend,
        maxSpend: state.profile.maxSpend,
      },
      currentSessionId: state.currentSessionId,
    };
  }

  /**
   * Check if LHT is currently enabled in configuration.
   */
  static isEnabled(config?: Config): boolean {
    const cfg = config ?? loadConfig();
    return cfg.lht?.enabled ?? false;
  }
}
