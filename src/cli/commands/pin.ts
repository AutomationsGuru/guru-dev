import { Command } from 'commander';
import { GuruHarness } from '../../core/harness';
import { ContextPinnerGuru } from '../../gurus/context-pinner';
import { Mandate } from '../../core/mandate';
import * as fs from 'fs/promises';
import * as path from 'path';

export const pinCommand = new Command('pin')
  .description('Pin files into context for the active mandate (uses ContextPinnerGuru)')
  .argument('<files...>', 'One or more file paths to pin (relative or absolute)')
  .option('-m, --mandate <id>', 'Mandate ID (defaults to active or first)')
  .option('--unpin', 'Unpin instead of pin')
  .option('--list', 'List currently pinned files')
  .action(async (files: string[], options: { mandate?: string; unpin?: boolean; list?: boolean }) => {
    const harness = new GuruHarness();
    // Load mandate (simplified: use first or by id; real impl would resolve active)
    let mandate: Mandate;
    if (options.mandate) {
      mandate = await harness.loadMandate(options.mandate);
    } else {
      // Fallback: create or load default for demo
      mandate = await harness.loadMandate('default');
    }

    const pinner = new ContextPinnerGuru();

    if (options.list) {
      const pinned = pinner.listPinnedFiles(mandate);
      console.log(pinned.length ? pinned.join('\n') : 'No files currently pinned.');
      return;
    }

    if (options.unpin) {
      for (const f of files) {
        try {
          await pinner.unpinFile(mandate, path.resolve(f));
          console.log(`Unpinned: ${f}`);
        } catch (e: any) {
          console.error(`Failed to unpin ${f}: ${e.message}`);
        }
      }
    } else {
      for (const f of files) {
        try {
          const resolved = path.resolve(f);
          // Basic existence check for UX
          await fs.access(resolved);
          await pinner.pinFile(mandate, resolved);
          console.log(`Pinned: ${f}`);
        } catch (e: any) {
          console.error(`Failed to pin ${f}: ${e.message}`);
        }
      }
    }

    // Optional: persist mandate changes if harness supports
    console.log('Context updated. Use `guru status` or invoke gurus to see effect.');
  });
