import { describe, it, expect } from 'vitest';
import { switchProtocol, Protocol, SwitchReceipt, ProtocolAdapter } from '../../src/routing/protocolSwitch.js';

describe('protocolSwitch', () => {
  it('should successfully switch to supported protocol and return receipt', () => {
    const routeId = 'route-openai-1';
    const targetProtocol: Protocol = 'openai-compat';
    const receipt: SwitchReceipt = switchProtocol(routeId, targetProtocol);

    expect(receipt.routeId).toBe(routeId);
    expect(receipt.to).toBe(targetProtocol);
    expect(receipt.from).toBeDefined();
    expect(receipt.sessionId).toMatch(/^sess-/);
    expect(receipt.timestamp).toBeDefined();
    expect(receipt.adapter).toBeDefined();
  });

  it('should throw for unsupported protocol per provider', () => {
    const routeId = 'route-gemini-1';
    const unsupported: Protocol = 'openai-compat'; // gemini provider doesn't support openai-compat in matrix

    expect(() => switchProtocol(routeId, unsupported)).toThrow(/unsupported protocol/i);
  });

  it('should preserve sessionId via F70 transcript composition in receipt', () => {
    const routeId = 'route-anthropic-42';
    const receipt = switchProtocol(routeId, 'anthropic');

    expect(receipt.sessionId).toBe(`sess-${routeId}`);
    expect(receipt).toHaveProperty('sessionId');
  });

  it('should support all defined protocols for compatible providers', () => {
    const protocols: Protocol[] = ['openai-compat', 'anthropic', 'gemini-shape'];
    protocols.forEach((proto) => {
      const receipt = switchProtocol(`route-${proto}`, proto);
      expect(receipt.to).toBe(proto);
    });
  });
});
