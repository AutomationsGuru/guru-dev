import { describe, it, expect } from 'vitest';
import { SandboxBoxStatus, transitionSandboxBoxStatus } from '../../src/sandbox/sandboxBoxLifecycle.js';

describe('transitionSandboxBoxStatus', () => {
  // Test valid transitions
  it('should transition from STOPPED to STARTING', () => {
    expect(transitionSandboxBoxStatus(SandboxBoxStatus.STOPPED, SandboxBoxStatus.STARTING)).toBe(SandboxBoxStatus.STARTING);
  });

  it('should transition from STARTING to RUNNING', () => {
    expect(transitionSandboxBoxStatus(SandboxBoxStatus.STARTING, SandboxBoxStatus.RUNNING)).toBe(SandboxBoxStatus.RUNNING);
  });

  it('should transition from RUNNING to STOPPING', () => {
    expect(transitionSandboxBoxStatus(SandboxBoxStatus.RUNNING, SandboxBoxStatus.STOPPING)).toBe(SandboxBoxStatus.STOPPING);
  });

  it('should transition from STOPPING to STOPPED', () => {
    expect(transitionSandboxBoxStatus(SandboxBoxStatus.STOPPING, SandboxBoxStatus.STOPPED)).toBe(SandboxBoxStatus.STOPPED);
  });

  it('should transition from STARTING to STOPPED (e.g., startup failed)', () => {
    expect(transitionSandboxBoxStatus(SandboxBoxStatus.STARTING, SandboxBoxStatus.STOPPED)).toBe(SandboxBoxStatus.STOPPED);
  });

  it('should transition from STOPPED to DESTROYED', () => {
    expect(transitionSandboxBoxStatus(SandboxBoxStatus.STOPPED, SandboxBoxStatus.DESTROYED)).toBe(SandboxBoxStatus.DESTROYED);
  });

  it('should not transition from DESTROYED to any other state', () => {
    expect(() => transitionSandboxBoxStatus(SandboxBoxStatus.DESTROYED, SandboxBoxStatus.STOPPED)).toThrow('Invalid state transition from DESTROYED to STOPPED');
  });

  // Test invalid transitions
  it('should throw an error for invalid transition from STOPPED to RUNNING', () => {
    expect(() => transitionSandboxBoxStatus(SandboxBoxStatus.STOPPED, SandboxBoxStatus.RUNNING)).toThrow('Invalid state transition from STOPPED to RUNNING');
  });

  it('should throw an error for transitioning to the same state', () => {
    expect(() => transitionSandboxBoxStatus(SandboxBoxStatus.RUNNING, SandboxBoxStatus.RUNNING)).toThrow('Invalid state transition from RUNNING to RUNNING');
  });

  it('should throw an error for invalid transition from RUNNING to STARTING', () => {
    expect(() => transitionSandboxBoxStatus(SandboxBoxStatus.RUNNING, SandboxBoxStatus.STARTING)).toThrow('Invalid state transition from RUNNING to STARTING');
  });
});
