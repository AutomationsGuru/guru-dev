import {
  MessagingConnectorConfigSchema,
  type MessagingConnectorConfigInput,
  type MessagingConnectorSendResult,
  type MessagingConnectorStatus
} from "./messagingConnectorSchema.js";

/**
 * IDEA-F73 ATTACH stub: interface-only registry for external messaging
 * connectors (Slack, Teams, Discord, generic). Mirrors the src/mcp/attach.ts
 * posture — honest default-disabled status, never a surprise network call.
 *
 * A connector may only be enabled when a parity gap id (e.g. "R-CL-CONNECT")
 * is attached, so enablement is always traceable to a tracked gap. The noop
 * implementation performs zero I/O and reports itself as a stub.
 */

export const MESSAGING_CONNECTOR_PARITY_GAP_PREFIX = "MessagingConnectorParityGapRequired";

export class MessagingConnectorParityGapError extends Error {
  public readonly connectorId: string;

  constructor(connectorId: string) {
    super(
      `${MESSAGING_CONNECTOR_PARITY_GAP_PREFIX}: connector "${connectorId}" cannot be enabled without a parityGapId (e.g. "R-CL-CONNECT").`
    );
    this.name = "MessagingConnectorParityGapError";
    this.connectorId = connectorId;
  }
}

export interface MessagingConnector {
  readonly id: string;
  readonly status: MessagingConnectorStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: string): Promise<MessagingConnectorSendResult>;
}

function parseConfig(config: MessagingConnectorConfigInput) {
  const result = MessagingConnectorConfigSchema.safeParse(config);
  if (!result.success) {
    const gapIssue = result.error.issues.find((issue) => issue.path.includes("parityGapId"));
    if (gapIssue) {
      const id = typeof config === "object" && config && "id" in config ? String(config.id) : "unknown";
      throw new MessagingConnectorParityGapError(id);
    }
    throw result.error;
  }
  // Defense-in-depth: the schema's superRefine already enforces this invariant.
  if (result.data.enabled && !result.data.parityGapId) {
    throw new MessagingConnectorParityGapError(result.data.id);
  }
  return result.data;
}

export function createNoopMessagingConnector(config: MessagingConnectorConfigInput): MessagingConnector {
  const parsed = parseConfig(config);
  let status: MessagingConnectorStatus = parsed.enabled ? "ready" : "disabled";

  return {
    id: parsed.id,
    get status() {
      return status;
    },
    async connect() {
      if (!parsed.enabled) {
        status = "disabled";
        return;
      }
      // Stub wave: no real provider session exists; enabling surfaces the
      // connector as "enabled" without performing any network I/O.
      status = "enabled";
    },
    async disconnect() {
      status = parsed.enabled ? "ready" : "disabled";
    },
    async send(_message: string): Promise<MessagingConnectorSendResult> {
      // Noop stub: never throws, never delivers, never performs network I/O.
      return {
        delivered: false,
        reason: "noop-stub",
        connectorId: parsed.id
      };
    }
  };
}

/** Small in-memory registry; connectors default to disabled. */
const connectors = new Map<string, MessagingConnector>();

export function registerConnector(config: MessagingConnectorConfigInput): MessagingConnector {
  const connector = createNoopMessagingConnector(config);
  connectors.set(connector.id, connector);
  return connector;
}

export function getConnector(id: string): MessagingConnector | undefined {
  return connectors.get(id);
}

export function listConnectors(): readonly MessagingConnector[] {
  return [...connectors.values()];
}

export function removeConnector(id: string): boolean {
  return connectors.delete(id);
}
