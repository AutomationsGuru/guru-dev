/**
 * TUI Session State
 * Manages visibility and configuration for TUI panels including LHT status
 */

export interface LhtPanelState {
  visible: boolean;
  compact: boolean;
  refreshRateMs: number;
}

export interface TuiSessionState {
  lhtPanel: LhtPanelState;
}

/**
 * Default TUI session state
 */
export const DEFAULT_TUI_STATE: TuiSessionState = {
  lhtPanel: {
    visible: false,
    compact: true,
    refreshRateMs: 5000,
  },
};

/**
 * LHT Panel data interface (wired from ritual.ts LHT state)
 */
export interface LhtPanelData {
  elapsedMs: number;
  spend: number;
  netSpendDelta: number;
  gatesPassed: number;
  gatesTotal: number;
  health: 'healthy' | 'stall' | 'complete' | 'error';
}

/**
 * Global TUI session state instance
 */
let sessionState: TuiSessionState = { ...DEFAULT_TUI_STATE };

export function getTuiState(): TuiSessionState {
  return sessionState;
}

export function setTuiState(newState: Partial<TuiSessionState>): void {
  sessionState = {
    ...sessionState,
    ...newState,
    lhtPanel: {
      ...sessionState.lhtPanel,
      ...(newState.lhtPanel || {}),
    },
  };
}

export function toggleLhtPanel(): void {
  sessionState.lhtPanel.visible = !sessionState.lhtPanel.visible;
}

export function setLhtPanelVisibility(visible: boolean): void {
  sessionState.lhtPanel.visible = visible;
}

export function isLhtPanelEnabled(configEnabled: boolean): boolean {
  return configEnabled && sessionState.lhtPanel.visible;
}
