import { messagingConnectorConfigSchema, type MessagingConnectorConfig } from './messagingConnectorSchema.js';

export interface MessagingConnector {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: any): Promise<void>;
}

export class StubMessagingConnector implements MessagingConnector {
  async connect(): Promise<void> {
    // No-op
  }

  async disconnect(): Promise<void> {
    // No-op
  }

  async send(_message: any): Promise<void> {
    // No-op
  }
}

let activeConnector: MessagingConnector | null = null;
let currentConfig: MessagingConnectorConfig | null = null;

export function isEnabled(): boolean {
  return activeConnector !== null;
}

export function enable(config: unknown): void {
  const parsedConfig = messagingConnectorConfigSchema.parse(config);
  currentConfig = parsedConfig;
  activeConnector = new StubMessagingConnector();
}

export function disable(): void {
  activeConnector = null;
  currentConfig = null;
}

export function getConnector(): MessagingConnector | null {
  return activeConnector;
}

export function getConfig(): MessagingConnectorConfig | null {
  return currentConfig;
}
