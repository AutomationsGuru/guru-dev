import {
  MessagingConnectorConfigSchema,
  MessagingConnectorIdSchema,
  MessagingConnectorMessageSchema,
  MessagingConnectorSendResultSchema,
  MessagingConnectorStatusSchema,
  type MessagingConnectorConfig,
  type MessagingConnectorId,
  type MessagingConnectorMessage,
  type MessagingConnectorMessageInput,
  type MessagingConnectorParityGapId,
  type MessagingConnectorSendResult,
  type MessagingConnectorStatus,
  type MessagingConnectorState
} from "./messagingConnectorSchema.js";

/**
 * Small ATTACH seam for external messaging. Implementations remain optional and
 * replaceable; the default connector performs no network or provider I/O.
 */
export interface MessagingConnector {
  readonly id: MessagingConnectorId;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: MessagingConnectorMessageInput): Promise<MessagingConnectorSendResult>;
}

export class NoopMessagingConnector implements MessagingConnector {
  readonly id: MessagingConnectorId;

  constructor(id: string) {
    this.id = MessagingConnectorIdSchema.parse(id);
  }

  async connect(): Promise<void> {
    // Deliberately empty: ATTACH is disabled/no-op until an explicit adapter is supplied.
  }

  async disconnect(): Promise<void> {
    // Deliberately empty: there is no external resource to release.
  }

  async send(message: MessagingConnectorMessage): Promise<MessagingConnectorSendResult> {
    const parsedMessage = MessagingConnectorMessageSchema.parse(message);
    return MessagingConnectorSendResultSchema.parse({
      connectorId: this.id,
      status: "noop",
      message: parsedMessage,
      summary: `${this.id} messaging connector is a no-op; nothing was sent.`
    });
  }
}

export interface MessagingConnectorRegistryOptions {
  readonly connector: MessagingConnector;
  readonly config?: Partial<MessagingConnectorConfig> & { readonly id?: string };
}

/**
 * Registry for one attached messaging connector. A connector is disabled by
 * default, and enablement is structurally tied to a recorded parity gap.
 */
export class MessagingConnectorRegistry {
  private readonly connector: MessagingConnector;
  private config: MessagingConnectorConfig;
  private state: MessagingConnectorState;

  constructor(options: MessagingConnectorRegistryOptions) {
    this.connector = options.connector;
    this.config = MessagingConnectorConfigSchema.parse({ id: options.connector.id, ...options.config });
    this.state = this.config.enabled ? "disconnected" : "disabled";
  }

  status(id: string = this.connector.id): MessagingConnectorStatus {
    if (id !== this.connector.id) {
      throw new Error(`Messaging connector ${id} is not registered.`);
    }
    return MessagingConnectorStatusSchema.parse({
      id: this.config.id,
      enabled: this.config.enabled,
      ...(this.config.parityGapId ? { parityGapId: this.config.parityGapId } : {}),
      state: this.state,
      summary: this.summary()
    });
  }

  enable(id: string = this.connector.id, parityGapId?: string): MessagingConnectorStatus {
    this.assertId(id);
    const parsedGapId = parityGapId ?? this.config.parityGapId;
    if (!parsedGapId) {
      throw new Error(`Cannot enable ${this.config.id}: an ATTACH parity-gap id is required.`);
    }
    this.config = MessagingConnectorConfigSchema.parse({ ...this.config, enabled: true, parityGapId: parsedGapId });
    this.state = "disconnected";
    return this.status();
  }

  disable(id: string = this.connector.id): MessagingConnectorStatus {
    this.assertId(id);
    this.config = MessagingConnectorConfigSchema.parse({ ...this.config, enabled: false });
    this.state = "disabled";
    return this.status();
  }

  async connect(id: string = this.connector.id): Promise<MessagingConnectorStatus> {
    this.assertId(id);
    this.assertEnabled();
    try {
      await this.connector.connect();
      this.state = "connected";
    } catch (error) {
      this.state = "error";
      throw error;
    }
    return this.status();
  }

  async disconnect(id: string = this.connector.id): Promise<MessagingConnectorStatus> {
    this.assertId(id);
    if (this.state === "connected") {
      await this.connector.disconnect();
    }
    if (this.config.enabled) {
      this.state = "disconnected";
    }
    return this.status();
  }

  async send(id: string, message: MessagingConnectorMessage): Promise<MessagingConnectorSendResult> {
    this.assertId(id);
    this.assertEnabled();
    if (this.state !== "connected") {
      throw new Error(`Messaging connector ${this.config.id} is not connected.`);
    }
    return MessagingConnectorSendResultSchema.parse(await this.connector.send(MessagingConnectorMessageSchema.parse(message)));
  }

  private assertId(id: string): void {
    if (id !== this.connector.id) {
      throw new Error(`Messaging connector ${id} is not registered.`);
    }
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error(`Messaging connector ${this.config.id} is disabled.`);
    }
    // The config schema enforces this too; keep the runtime guard at the lifecycle edge.
    if (!this.config.parityGapId) {
      throw new Error(`Messaging connector ${this.config.id} cannot run without an ATTACH parity-gap id.`);
    }
  }

  private summary(): string {
    if (!this.config.enabled) return `${this.config.id} messaging connector is disabled.`;
    return `${this.config.id} messaging connector is ${this.state}; ATTACH parity gap ${this.config.parityGapId} remains tracked.`;
  }
}

export function createMessagingConnectorRegistry(options: MessagingConnectorRegistryOptions): MessagingConnectorRegistry {
  return new MessagingConnectorRegistry(options);
}

export type { MessagingConnectorConfig, MessagingConnectorId, MessagingConnectorMessage, MessagingConnectorParityGapId, MessagingConnectorSendResult, MessagingConnectorStatus } from "./messagingConnectorSchema.js";
