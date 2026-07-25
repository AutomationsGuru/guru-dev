/**
 * Loadout install state lifecycle.
 *
 * Records installed component ids; doctor reports drift; repair restores only recorded components;
 * uninstall dry-run lists removals without deleting.
 */

export interface ComponentInstallRecord {
  id: string;
  paths: string[];
}

export interface LoadoutInstallState {
  components: ComponentInstallRecord[];
}

export interface DoctorReport {
  ok: boolean;
  missingFiles: string[];
  extraFiles: string[]; // Files found that aren't in any component record (out of scope for now based on steps, but good to have)
  messages: string[];
}

export interface FsFacade {
  existsSync(path: string): boolean;
}

/**
 * Checks the current installation state against the recorded state.
 * Reports missing files that were supposed to be installed.
 */
export function doctor(state: LoadoutInstallState, fs: FsFacade): DoctorReport {
  const missingFiles: string[] = [];
  const messages: string[] = [];

  for (const component of state.components) {
    for (const path of component.paths) {
      if (!fs.existsSync(path)) {
        missingFiles.push(path);
        messages.push(`Component '${component.id}': Missing installed file '${path}'`);
      }
    }
  }

  return {
    ok: missingFiles.length === 0,
    missingFiles,
    extraFiles: [],
    messages
  };
}

/**
 * Returns a list of paths that would be removed during uninstallation,
 * based on the recorded components. Pure function, no filesystem mutations.
 */
export function uninstallDryRun(state: LoadoutInstallState): string[] {
  const removals = new Set<string>();
  for (const component of state.components) {
    for (const path of component.paths) {
      removals.add(path);
    }
  }
  return Array.from(removals).sort();
}

/**
 * Generates a repair plan listing the components that need to be reinstalled
 * due to missing files.
 */
export function generateRepairPlan(state: LoadoutInstallState, fs: FsFacade): ComponentInstallRecord[] {
  const componentsToRepair: ComponentInstallRecord[] = [];

  for (const component of state.components) {
    const isMissingAny = component.paths.some(p => !fs.existsSync(p));
    if (isMissingAny) {
      componentsToRepair.push(component);
    }
  }

  return componentsToRepair;
}
