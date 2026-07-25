export interface SandboxBox {
  readonly id: string;
}

export interface SandboxProvider {
  readonly id: string;
  createBox(): Promise<SandboxBox>;
}

export interface ProviderAttachSlot {
  register(provider: SandboxProvider): SandboxProvider;
  resolve(id: string): SandboxProvider;
  createBox(activeProviderId: string): Promise<SandboxBox>;
}

export function createProviderAttachSlot(): ProviderAttachSlot {
  const providers = new Map<string, SandboxProvider>();

  const resolve = (id: string): SandboxProvider => {
    const provider = providers.get(id);
    if (!provider) {
      throw new Error(`Unknown sandbox provider: ${id}`);
    }
    return provider;
  };

  return {
    register(provider) {
      providers.set(provider.id, provider);
      return provider;
    },
    resolve,
    createBox(activeProviderId) {
      return resolve(activeProviderId).createBox();
    }
  };
}

const defaultProviderAttachSlot = createProviderAttachSlot();

export const registerProvider = defaultProviderAttachSlot.register;
export const resolveProvider = defaultProviderAttachSlot.resolve;
export const createBox = defaultProviderAttachSlot.createBox;
