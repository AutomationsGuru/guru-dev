/**
 * HarnessCapabilityMatrix — static capability registry for GuruHarness
 * Provides supports(feature) query returning boolean from known matrix
 */

export interface HarnessCapability {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string;
  confidence?: number;
}

/**
 * Static capability matrix — authoritative source of supported capabilities
 */
export const HARNESS_CAPABILITY_MATRIX: HarnessCapability[] = [
  {
    id: 'cap_001',
    name: 'Memory Management',
    description: 'Persistent memory store with scoped retention',
    category: 'memory',
    provider: 'local',
    confidence: 0.95
  },
  {
    id: 'cap_002',
    name: 'Tool Execution',
    description: 'Safe execution of registered tools and commands',
    category: 'execution',
    provider: 'local',
    confidence: 0.93
  },
  {
    id: 'cap_003',
    name: 'Model Routing',
    description: 'Intelligent routing across connected model providers',
    category: 'routing',
    provider: 'openai',
    confidence: 0.88
  },
  {
    id: 'cap_004',
    name: 'Context Compaction',
    description: 'Automatic context window management and summarization',
    category: 'core',
    provider: 'anthropic',
    confidence: 0.91
  },
  {
    id: 'cap_005',
    name: 'Agent Orchestration',
    description: 'Multi-agent coordination and workflow execution',
    category: 'orchestration',
    provider: 'google',
    confidence: 0.85
  },
  {
    id: 'cap_006',
    name: 'Vector Search',
    description: 'Semantic search over vector stores with reranking',
    category: 'memory',
    provider: 'google',
    confidence: 0.92
  }
];

/**
 * HarnessCapabilityMatrix class — query interface for capability support
 */
export class HarnessCapabilityMatrix {
  private capabilityMap: Map<string, HarnessCapability>;

  constructor() {
    this.capabilityMap = new Map();
    HARNESS_CAPABILITY_MATRIX.forEach(cap => {
      this.capabilityMap.set(cap.id, cap);
    });
  }

  /**
   * Check if a capability is supported by feature id or name
   * Returns true if the capability exists in the matrix, false otherwise
   */
  supports(feature: string): boolean {
    if (!feature || feature.trim().length === 0) {
      return false;
    }

    const f = feature.trim();

    // Direct ID match
    if (this.capabilityMap.has(f)) {
      return true;
    }

    // Case-insensitive name match
    const lowerF = f.toLowerCase();
    for (const cap of this.capabilityMap.values()) {
      if (cap.name.toLowerCase() === lowerF) {
        return true;
      }
      if (cap.id.toLowerCase() === lowerF) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get a capability by id or name (for introspection)
   */
  getCapability(feature: string): HarnessCapability | undefined {
    if (!feature || feature.trim().length === 0) {
      return undefined;
    }

    const f = feature.trim();

    // Direct ID lookup
    const byId = this.capabilityMap.get(f);
    if (byId) return byId;

    // Case-insensitive name lookup
    const lowerF = f.toLowerCase();
    for (const cap of this.capabilityMap.values()) {
      if (cap.name.toLowerCase() === lowerF || cap.id.toLowerCase() === lowerF) {
        return cap;
      }
    }

    return undefined;
  }

  /**
   * Get all capabilities (for enumeration)
   */
  getAllCapabilities(): HarnessCapability[] {
    return Array.from(this.capabilityMap.values());
  }
}

// Default export for convenience
export default HarnessCapabilityMatrix;
